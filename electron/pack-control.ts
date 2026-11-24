import path from 'node:path'
import { realpathSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { canonicalPackIdentity, matchesPackIdentity, readProcessIdentity, tryClaimPackOwnership, verifyProcessIdentity, type PackIdentity, type ProcessIdentity } from './pack-ownership'
import { readIndependentRuntimeSession, stopIndependentRuntimeSession, type IndependentRuntimeSession } from './independent-runtime'
import { readFile, mkdir, symlink, lstat, realpath, rm, readdir, link, rename } from 'node:fs/promises'
import type { AppSettings, ExternalRuntime, LauncherControlRequest, PackControlConfig, RuntimeState } from '../src/types'
import { readPackRegistry, toPackStatus, type PackRecord } from './pack-registry'
import { writeFileAtomic } from './fs-atomic'
import { createRuntimeController, findAvailableWebPort, type RuntimeController, type RuntimeControllerOptions } from './runtime'
import { clearElevatedSession, elevatedSessionPath, readElevatedSession, scanExternalRuntimes, type stopExternalRuntime } from './external-runtime'
import { readProfile, togglePlugin, isSafePackageName } from './profile'
import { readInstalledSkills, toggleInstalledSkill, uninstallInstalledSkill, isSkillName } from './skill-format'
import { readInstalledPresets, toggleInstalledPreset, uninstallInstalledPreset } from './preset-install'

export interface PackControlOptions {
  userData: string
  registryPath: string
  readSettings: () => Promise<AppSettings>
  resolveIdentitySettings?: (record: PackRecord) => Promise<Pick<AppSettings, 'dshHome' | 'profileName'>>
  resolveSettings: (record: PackRecord, config: PackControlConfig) => Promise<AppSettings>
  runtimeOptions: (record: PackRecord, settings: AppSettings) => Omit<RuntimeControllerOptions, 'readSettings'>
  createController?: typeof createRuntimeController
  openExternal: (url: string) => Promise<unknown>
  probePackActiveSessions?: (url: string) => Promise<number | null>
  beforeStart?: (record: PackRecord, settings: AppSettings) => Promise<void>
  lifecycle?: (command: string, packId: string | undefined, args: Record<string, unknown>) => Promise<unknown>
  market?: (command: string, settings: AppSettings, args: Record<string, unknown>) => Promise<unknown>
  /** 外部遗留进程的扫描与停止；默认走 external-runtime 的真实实现，测试注入假实现。 */
  externalRuntime?: {
    scan?: typeof scanExternalRuntimes
    stop?: typeof stopExternalRuntime
  }
}

export function validatePackConfig(patch: Record<string, unknown>): Partial<PackControlConfig> {
  const keys = ['portMode', 'port', 'runAsAdmin', 'autoStart', 'pinnedAt', 'workspace', 'launchArgs']
  for (const key of Object.keys(patch)) if (!keys.includes(key)) throw new Error('Unsupported pack setting: ' + key)
  if ('portMode' in patch && !['auto', 'fixed'].includes(String(patch.portMode))) throw new Error('Invalid port mode')
  if ('port' in patch && (!Number.isInteger(patch.port) || Number(patch.port) < 1 || Number(patch.port) > 65535)) throw new Error('Invalid port')
  for (const key of ['runAsAdmin', 'autoStart']) if (key in patch && typeof patch[key] !== 'boolean') throw new Error('Invalid ' + key)
  if ('pinnedAt' in patch && patch.pinnedAt !== null && (typeof patch.pinnedAt !== 'string' || !Number.isFinite(Date.parse(patch.pinnedAt)))) throw new Error('Invalid pin timestamp')
  if ('workspace' in patch && (typeof patch.workspace !== 'string' || (patch.workspace !== '' && !path.isAbsolute(patch.workspace)))) throw new Error('Workspace must be absolute')
  if ('launchArgs' in patch && (!Array.isArray(patch.launchArgs) || patch.launchArgs.some(a => typeof a !== 'string' || a.includes('\0')))) throw new Error('Invalid launch arguments')
  return patch as Partial<PackControlConfig>
}

/** 家目录文件被别的进程占住时 Windows 抛的那些码：写不进去必须如实说，不能装作改成功了。 */
type PackRuntimeState = RuntimeState & { ownership?: 'owned' | 'observer'; activeSessionCount?: number | null }
type WorkerRecord = {
  pack: PackIdentity
  sessionId: string
  runtime: ProcessIdentity
  worker: ProcessIdentity
  port: number | null
  url: string | null
}
type VerifiedWorker = { session: IndependentRuntimeSession; record: WorkerRecord; state: PackRuntimeState }

const workerRoot = (identity: PackIdentity): string => path.join(identity.profilePath, '.launcher-overture-runtimes')
const workerRecordFile = (root: string): string => path.join(root, 'pack-runtime.json')
const idleState = (): RuntimeState => ({ running: false, pid: null, startedAt: null, url: null, port: null })
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const canonicalHome = (home: string): string => { try { return realpathSync.native(home) } catch { return path.resolve(home) } }
const validPort = (port: unknown): port is number => Number.isInteger(port) && Number(port) >= 1 && Number(port) <= 65535

function loopbackUrl(value: string, port?: number): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password ||
      (port !== undefined && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== port)) throw new Error('Invalid runtime URL')
  return url
}

const execFileAsync = promisify(execFile)
async function ownsListener(processIdentity: ProcessIdentity, url: URL, port: number): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', url.hostname === '[::1]' ? 'tcpv6' : 'tcp'], { windowsHide: true, timeout: 3000 }).catch(() => ({ stdout: '' }))
  const address = url.hostname === '[::1]' ? /^(?:\[::1\]|\[::\])$/ : /^(?:127\.0\.0\.1|0\.0\.0\.0)$/
  const pids = stdout.split(/\r?\n/).flatMap(line => {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line)
    return m && Number(m[2]) === port && address.test(m[1]) ? [Number(m[3])] : []
  })
  if (!pids.length) return false
  if (pids.every(pid => pid === processIdentity.pid)) return verifyProcessIdentity(processIdentity) === 'match'
  const script = [
    '$ErrorActionPreference="Stop"',
    '$rows = @{}; Get-CimInstance Win32_Process | ForEach-Object { $rows[[int]$_.ProcessId] = $_ }',
    '$target = ' + processIdentity.pid,
    '$listeners = @(' + pids.join(',') + ')',
    'foreach ($listener in $listeners) { $current = $rows[[int]$listener]; while ($current -and $current.ProcessId -ne $target) { $parent = $rows[[int]$current.ParentProcessId]; if (!$parent -or $parent.CreationDate -ge $current.CreationDate) { exit 1 }; $current = $parent }; if (!$current) { exit 1 } }',
  ].join('; ')
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000 })
    return verifyProcessIdentity(processIdentity) === 'match'
  } catch { return false }
}

const FILE_LOCK_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EISDIR', 'EROFS'])

function asResourceWriteFailure(error: unknown, packId: string, running: boolean): unknown {
  if (!running) return error
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (typeof code !== 'string' || !FILE_LOCK_CODES.has(code)) return error
  const reason = error instanceof Error ? error.message : String(error)
  return new Error('整合包「' + packId + '」正在运行，这次改动没能写进它的家目录（' + code + '）。正在运行的 DSH 不受影响，但这次改动没有生效；先停止整合包再重试。原始错误：' + reason)
}

export function createPackControl(options: PackControlOptions) {
  const controllers = new Map<string, RuntimeController>()
  const controllerHomes = new Map<string, string>()
  const claims = new Map<string, { identity: PackIdentity; release: () => void }>()
  const discovered = new Map<string, { home: string; worker?: VerifiedWorker; external?: ExternalRuntime; blocked?: boolean }>()
  const removals = new Map<string, Promise<void>>()
  const verifiedUrls = new Map<string, { url: string; pid: number; startedAt: string | null; rawUrl: string }>()
  const publications = new Map<string, Promise<void>>()
  const immediateStops = new Set<Promise<unknown>>()
  const queues = new Map<string, Promise<unknown>>()
  let writeQueue: Promise<unknown> = Promise.resolve()
  let portQueue: Promise<unknown> = Promise.resolve()
  const reservations = new Set<number>()
  let closing = false
  let stoppedForMaintenance = false
  /** 后台重启的状态：controller 会被换掉，所以 restarting/lastError 只能记在这张表里。 */
  const restarts = new Map<string, { restarting: boolean; lastError: string | null }>()
  /** 强制停止会让正在后台跑的那轮重启作废：epoch 一变，它就不再执行 start。 */
  const restartEpochs = new Map<string, number>()
  const runtimeStateOf = (id: string): PackRuntimeState => {
    const local = controllers.get(id)?.state()
    const found = discovered.get(id)
    const blocked: PackRuntimeState | undefined = found?.blocked ? { ...idleState(), running: true, ownership: 'observer', lastError: 'Independent runtime identity could not be verified' } : undefined
    const legacy: PackRuntimeState | undefined = found?.external ? { ...idleState(), ownership: 'observer' } : undefined
    const base: PackRuntimeState = local?.running ? { ...local, ownership: 'owned' } : found?.worker?.state ?? blocked ?? legacy ?? local ?? idleState()
    const flag = restarts.get(id)
    // restarting/lastError 恒定出现：界面不用区分「没这字段」和「false」。
    return { ...base, restarting: flag?.restarting ?? false, lastError: flag?.lastError ?? base.lastError ?? null }
  }
  const noteRestartFailure = (id: string, error: unknown): void => {
    const message = '重启整合包失败：' + (error instanceof Error ? error.message : String(error))
    restarts.set(id, { restarting: false, lastError: message })
    console.warn('[pack-restart] ' + id + ': ' + message)
  }
  const configPath = path.join(options.userData, 'pack-control.json')
  const elevatedRoot = path.join(options.userData, 'elevated')
  const scanExternal = options.externalRuntime?.scan ?? scanExternalRuntimes
  const serial = <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action)
      .catch((error: unknown) => { throw asResourceWriteFailure(error, key, isPackRunning(key)) })
    queues.set(key, next)
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => undefined)
    return next
  }
  const withWriteClaim = async <T>(r: PackRecord, action: () => Promise<T>): Promise<T> => {
    try { await assertWritable(r); return await action() }
    finally { if (!isPackRunning(r.id)) releaseClaim(r.id) }
  }
  async function configs(repair = true): Promise<Record<string, PackControlConfig>> {
    let text: string
    try {
      text = await readFile(configPath, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw e
    }
    // 记事本一类编辑器会写 BOM，JSON.parse 见到它直接抛，整页整合包列表会跟着变红。
    try {
      return JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, PackControlConfig>
    } catch (error) {
      if (!repair) return {}
      // 手改坏的配置不该连累列表：留档一份再按默认值继续，别让用户丢文件。
      const backup = configPath + '.corrupt-' + Date.now()
      await rename(configPath, backup).catch(() => undefined)
      console.warn('[pack-control] 配置文件解析失败，已留档到 ' + backup, error)
      return {}
    }
  }
  async function config(id: string, repair = true): Promise<PackControlConfig> {
    const base = await options.readSettings()
    const saved: Partial<PackControlConfig> | undefined = (await configs(repair))[id]
    return Object.assign({ portMode: 'auto' as const, port: base.webPort, runAsAdmin: false, autoStart: false, pinnedAt: null }, saved)
  }
  async function record(id?: string): Promise<PackRecord> {
    if (typeof id !== 'string' || !id) throw new Error('packId is required')
    const found = (await readPackRegistry(options.registryPath)).find(r => r.id === id)
    if (!found) throw new Error('Unknown pack: ' + id)
    return found
  }
  function isPackRunning(id: string): boolean {
    const found = discovered.get(id)
    return controllers.get(id)?.isRunning() === true || !!(found?.worker || found?.external || found?.blocked)
  }

  async function identitySettings(r: PackRecord) {
    return options.resolveIdentitySettings ? options.resolveIdentitySettings(r) : options.resolveSettings(r, await config(r.id))
  }

  async function identityOf(s: Pick<AppSettings, 'dshHome' | 'profileName'>, create = false): Promise<PackIdentity | null> {
    try { return await canonicalPackIdentity(s.dshHome, s.profileName) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return null
      await mkdir(path.join(s.dshHome, 'profiles', s.profileName), { recursive: true })
      return canonicalPackIdentity(s.dshHome, s.profileName)
    }
  }

  function claim(id: string, identity: PackIdentity) {
    const current = claims.get(id)
    if (current) {
      if (!matchesPackIdentity(identity, current.identity)) throw new Error('Pack identity changed while owned')
      return 'claimed'
    }
    const result = tryClaimPackOwnership(identity)
    if (result.status === 'unavailable') throw new Error('Pack ownership unavailable: ' + result.reason)
    if (result.status === 'claimed') claims.set(id, { identity, release: result.release })
    return result.status
  }

  function releaseClaim(id: string): void {
    claims.get(id)?.release()
    claims.delete(id)
  }

  async function workerDirectories(identity: PackIdentity): Promise<string[]> {
    const root = workerRoot(identity)
    try {
      const actualRoot = await realpath(root)
      if (!samePath(root, actualRoot)) throw new Error('Independent runtime directory was redirected')
      return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^runtime-[a-zA-Z0-9]+$/.test(entry.name)).map(entry => path.join(root, entry.name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async function verifyWorker(identity: PackIdentity, dir: string, ownership: PackRuntimeState['ownership'], endpoint = false): Promise<{ worker?: VerifiedWorker; blocked?: boolean }> {
    const record = await readFile(workerRecordFile(dir), 'utf8').then(text => JSON.parse(text) as WorkerRecord | null).catch(() => null)
    if (!record || !matchesPackIdentity(identity, record.pack) || !record.runtime || !record.worker) {
      return { blocked: !!await readIndependentRuntimeSession(dir) }
    }
    const runtimeIdentity = verifyProcessIdentity(record.runtime)
    const workerIdentity = verifyProcessIdentity(record.worker)
    if (runtimeIdentity === 'absent' || runtimeIdentity === 'mismatch') return { blocked: !!await readIndependentRuntimeSession(dir) }
    if (runtimeIdentity !== 'match' || workerIdentity !== 'match') return { blocked: true }
    const session = await readIndependentRuntimeSession(dir)
    if (!session || session.sessionId !== record.sessionId || session.runtimePid !== record.runtime.pid || session.workerPid !== record.worker.pid ||
        verifyProcessIdentity(record.runtime) !== 'match' || verifyProcessIdentity(record.worker) !== 'match') return { blocked: true }
    const port = validPort(record.port) ? record.port : null
    let url: string | null = null
    if (endpoint && port !== null) {
      try {
        const candidate = loopbackUrl(record.url ?? 'http://127.0.0.1:' + port + '/', port)
        if (await ownsListener(record.runtime, candidate, port)) url = candidate.href
      } catch { /* A bad endpoint must not prevent inspecting or stopping the worker. */ }
    }
    return { worker: { session, record, state: { running: true, pid: session.runtimePid, startedAt: session.startedAt, url, port: url ? port : null, ownership } } }
  }

  async function discover(r: PackRecord, settings: Pick<AppSettings, 'dshHome' | 'profileName'>, allowClaim: boolean, endpoint = false, external?: ExternalRuntime | null) {
    if (controllers.get(r.id)?.isRunning() || removals.has(r.id)) return
    const identity = await identityOf(settings)
    const home = identity?.homePath ?? canonicalHome(settings.dshHome)
    if (identity) {
      const candidates = await Promise.all((await workerDirectories(identity)).map(dir => verifyWorker(identity, dir, 'observer', endpoint)))
      const live = candidates.flatMap(item => item.worker ? [item.worker] : [])
      if (live.length > 1 || candidates.some(item => item.blocked)) {
        discovered.set(r.id, { home, blocked: true })
        return
      }
      if (live.length === 1) {
        const worker = live[0]
        const existing = claims.get(r.id)
        if ((existing && matchesPackIdentity(identity, existing.identity)) || (allowClaim && !closing && claim(r.id, identity) === 'claimed')) worker.state.ownership = 'owned'
        discovered.set(r.id, { home, worker })
        return
      }
    }
    const legacy = external === undefined ? await findExternal(r, settings.profileName) : external
    if (legacy) discovered.set(r.id, { home, external: legacy })
    else {
      discovered.delete(r.id)
      verifiedUrls.delete(r.id)
      if (allowClaim && !restarts.get(r.id)?.restarting && !immediateStops.size) releaseClaim(r.id)
    }
  }

  function publish(id: string, runtime: RuntimeController, identity: PackIdentity): Promise<void> {
    const next = (publications.get(id) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      if (controllers.get(id) !== runtime || !runtime.isRunning()) return
      const session = await runtime.independentSession?.()
      if (!session) return
      const root = workerRoot(identity)
      if (!samePath(path.dirname(session.sessionRoot), root) || !/^runtime-[a-zA-Z0-9]+$/.test(path.basename(session.sessionRoot))) throw new Error('Independent worker session is outside the pack directory')
      const worker = readProcessIdentity(session.workerPid)
      const child = readProcessIdentity(session.runtimePid)
      if (worker.status !== 'alive' || child.status !== 'alive') throw new Error('Could not verify the independent worker process identity')
      const state = runtime.state()
      const record: WorkerRecord = { pack: identity, sessionId: session.sessionId, runtime: child.identity, worker: worker.identity, port: state.port, url: state.url }
      await writeFileAtomic(workerRecordFile(session.sessionRoot), JSON.stringify(record))
    })
    publications.set(id, next)
    void next.finally(() => { if (publications.get(id) === next) publications.delete(id) }).catch(() => undefined)
    return next
  }

  /** 本进程内存里托管的那些 pid：它们不是「外部」进程，扫描时要排掉。 */
  function hostedPids(): number[] {
    return [...controllers.values()].map(c => c.state().pid).filter((pid): pid is number => typeof pid === 'number')
  }
  async function findExternal(r: PackRecord, profileName: string): Promise<ExternalRuntime | null> {
    // 控制器已经在托管这个包：它拉起的进程树不是「外部实例」，扫描误判会把停止按钮指向别人的进程。
    if (controllers.get(r.id)?.isRunning()) return null
    const found = await scanExternal({ packs: [{ id: r.id, profileName }], excludePids: hostedPids() })
    const target = found.get(r.id) ?? null
    if (!target) return null
    const session = await readElevatedSession(elevatedRoot, r.id).catch(() => null)
    return { ...target, elevatedSession: session ? elevatedSessionPath(elevatedRoot, r.id) : null }
  }
  async function reserve(preferred: number, fixed: boolean): Promise<number | null> {
    const next = portQueue.catch(() => undefined).then(async () => {
      const selected = await findAvailableWebPort(preferred, fixed ? 1 : 100, async p => !reservations.has(p) && (await import('./runtime')).isLoopbackPortAvailable(p))
      if (selected !== null) reservations.add(selected)
      return selected
    })
    portQueue = next
    return next
  }
  function discoveryError(found: { external?: ExternalRuntime }): Error {
    const target = found.external
    if (target) return new Error('这个整合包已经有一份没被启动器托管的 DSH 在运行（PID ' + target.pid + '，端口 ' + (target.port ?? '未知') + '）。先停止它再启动。')
    return new Error('This pack is owned by another launcher or its runtime identity is unverified')
  }

  async function startPack(r: PackRecord): Promise<PackRuntimeState> {
    const running = controllers.get(r.id)
    if (removals.has(r.id)) throw new Error('Pack removal is in progress')
    if (running?.isRunning()) return runtimeStateOf(r.id)
    const identityTarget = await identitySettings(r)
    await discover(r, identityTarget, true, true)
    const found = discovered.get(r.id)
    if (found?.worker?.state.ownership === 'owned') return runtimeStateOf(r.id)
    if (found) throw discoveryError(found)
    const c = await config(r.id)
    const settings = await options.resolveSettings(r, c)
    const identity = (await identityOf(settings, true))!
    if ([...controllerHomes].some(([id, home]) => id !== r.id && samePath(home, identity.homePath) && (isPackRunning(id) || queues.has(id)))) throw new Error('Another pack is already using this home')
    const shared: Array<{ id: string; profileName: string }> = []
    for (const sibling of await readPackRegistry(options.registryPath)) {
      if (sibling.id === r.id) continue
      const siblingSettings = await identitySettings(sibling)
      if (!samePath(canonicalHome(siblingSettings.dshHome), identity.homePath)) continue
      await discover(sibling, siblingSettings, false, false, null)
      if (isPackRunning(sibling.id)) throw new Error('Another pack is already using this home')
      shared.push({ id: sibling.id, profileName: siblingSettings.profileName })
    }
    if (shared.length && (await scanExternal({ packs: shared, excludePids: hostedPids() })).size) throw new Error('An external runtime is already using this home')
    if (claim(r.id, identity) === 'busy') throw new Error('This pack is owned by another launcher')
    try {
      await discover(r, settings, false, true)
      const current = discovered.get(r.id)
      if (current?.worker?.state.ownership === 'owned') return runtimeStateOf(r.id)
      if (current) throw discoveryError(current)
      controllerHomes.set(r.id, identity.homePath)
      await options.beforeStart?.(r, settings)
      const runtimeOptions = options.runtimeOptions(r, settings)
      let runtime: RuntimeController
      runtime = (options.createController ?? createRuntimeController)({
        ...runtimeOptions, readSettings: async () => settings,
        preserveOnLauncherExit: runtimeOptions.spawnProcess || runtimeOptions.spawnElevatedProcess ? undefined : { root: workerRoot(identity) },
        emitState: state => {
          runtimeOptions.emitState(state)
          if (!runtime || controllers.get(r.id) !== runtime) return
          if (state.running) {
            if (state.url) void verifiedRuntimeUrl(r.id, state).catch(() => null)
            void publish(r.id, runtime, identity).catch(error => console.warn('[pack-runtime]', r.id, error))
          } else if (!closing) {
            void serial(r.id, async () => {
              if (controllers.get(r.id) === runtime && !runtime.isRunning()) {
                await discover(r, settings, false)
                if (!isPackRunning(r.id)) releaseClaim(r.id)
              }
            }).catch(error => console.warn('[pack-runtime]', r.id, error))
          }
        },
        portMode: c.portMode, portFallbackAttempts: 100, runAsAdmin: c.runAsAdmin, reservePort: reserve,
        releasePort: p => reservations.delete(p), elevatedStash: { root: elevatedRoot, packId: r.id },
      })
      controllers.set(r.id, runtime)
      const state = await runtime.start()
      await publish(r.id, runtime, identity)
      if (!runtime.isRunning()) releaseClaim(r.id)
      if (!state.running) return state
      const url = await verifiedRuntimeUrl(r.id, state).catch(() => null)
      return { ...state, url: url?.href ?? null, ownership: 'owned' }
    } catch (error) {
      if (!isPackRunning(r.id)) releaseClaim(r.id)
      throw error
    }
  }

  async function restartPack(r: PackRecord, epoch: number): Promise<void> {
    if ((restartEpochs.get(r.id) ?? 0) !== epoch) return
    try {
      await stopPack(r, {}, true)
      if ((restartEpochs.get(r.id) ?? 0) !== epoch) return
      await startPack(r)
      restarts.delete(r.id)
    } catch (error) {
      noteRestartFailure(r.id, error)
    } finally {
      if (!isPackRunning(r.id)) releaseClaim(r.id)
    }
  }

  async function stopPack(r: PackRecord, args: Record<string, unknown>, retainClaim = false): Promise<unknown> {
    if (removals.has(r.id)) throw new Error('Pack removal is in progress')
    const force = args.force === true
    if (force) restartEpochs.set(r.id, (restartEpochs.get(r.id) ?? 0) + 1)
    const runtime = controllers.get(r.id)
    if (runtime?.isRunning()) {
      const state = await runtime.stop({ force })
      if (runtime.isRunning() || state.running) throw new Error('Pack is still running')
      if (controllers.get(r.id) === runtime) controllers.delete(r.id)
      restarts.delete(r.id)
      verifiedUrls.delete(r.id)
      await clearElevatedSession(elevatedRoot, r.id)
      if (!retainClaim) releaseClaim(r.id)
      return state
    }
    await discover(r, await identitySettings(r), !force)
    const found = discovered.get(r.id)
    if (!found) {
      if (!retainClaim) releaseClaim(r.id)
      return idleState()
    }
    const verified = found.worker
    if (!verified) throw new Error('Cannot stop this external runtime because its pack or process identity is unverified')
    if (verified.state.ownership !== 'owned' && !force) throw new Error('This pack is owned by another launcher. Use explicit force stop to stop its verified worker.')
    await stopIndependentRuntimeSession(verified.session)
    if (verifyProcessIdentity(verified.record.runtime) === 'match') throw new Error('Pack process is still running')
    discovered.delete(r.id)
    verifiedUrls.delete(r.id)
    restarts.delete(r.id)
    if (!retainClaim) releaseClaim(r.id)
    return { ...idleState(), ...(force ? { externalStopped: true, stoppedBy: 'session' } : {}) }
  }

  async function reconcileRunningPacks(endpoint = false): Promise<void> {
    const items = await Promise.all((await readPackRegistry(options.registryPath)).map(async r => ({ r, settings: await identitySettings(r) })))
    const externals = await scanExternal({ packs: items.map(({ r, settings }) => ({ id: r.id, profileName: settings.profileName })), excludePids: hostedPids() })
    await Promise.all(items.map(({ r, settings }) => serial(r.id, () => discover(r, settings, true, endpoint, externals.get(r.id) ?? null))))
  }

  async function acquirePackRemoval(id: string): Promise<() => void> {
    const r = await record(id)
    return serial(id, async () => {
      try {
        await assertWritable(r, true)
        await assertPackRemovable(id)
        let finish!: () => void
        const removing = new Promise<void>(resolve => { finish = resolve })
        removals.set(id, removing)
        return () => {
          if (removals.get(id) !== removing) return
          removals.delete(id)
          try { releaseClaim(id) } finally { finish() }
        }
      } catch (error) {
        if (!isPackRunning(id) && !removals.has(id)) releaseClaim(id)
        throw error
      }
    })
  }

  async function assertPackRemovable(id: string): Promise<void> {
    const r = await record(id)
    await discover(r, await identitySettings(r), false)
    if (isPackRunning(id)) throw new Error('Stop the pack before deleting it')
    await assertNotSharedSource(id)
  }

  async function drain(): Promise<void> {
    while (queues.size || immediateStops.size || publications.size || removals.size) {
      await Promise.allSettled([...queues.values(), ...immediateStops, ...publications.values(), ...removals.values()])
    }
  }

  async function prepareForRelaunch(signal?: AbortSignal): Promise<() => void> {
    if (closing) throw new Error('Launcher is already shutting down')
    closing = true
    const rollback = () => { closing = false }
    try {
      signal?.throwIfAborted()
      await drain()
      signal?.throwIfAborted()
      for (const [id, claim] of claims) {
        const runtime = controllers.get(id)
        if (runtime?.isRunning()) {
          await publish(id, runtime, claim.identity)
          const session = await runtime.independentSession?.()
          if (!session || !(await verifyWorker(claim.identity, session.sessionRoot, 'owned', true)).worker) {
            throw new Error('Pack ' + id + ' cannot survive launcher exit. Stop it first or choose to stop packs on exit.')
          }
        } else if (discovered.get(id)?.worker?.state.ownership === 'owned') {
          const session = discovered.get(id)!.worker!.session
          if (!(await verifyWorker(claim.identity, session.sessionRoot, 'owned', true)).worker) throw new Error('Could not verify that pack ' + id + ' can survive launcher exit')
        }
        signal?.throwIfAborted()
      }
      return rollback
    } catch (error) {
      rollback()
      throw error
    }
  }

  async function shutdown(mode: 'stop' | 'keep' = 'stop'): Promise<void> {
    if (mode === 'keep') { await prepareForRelaunch(); return }
    closing = true
    await drain()
    const results = await Promise.allSettled([...claims.keys()].filter(id => controllers.get(id)?.isRunning() || discovered.get(id)?.worker?.state.ownership === 'owned').map(async id => {
      const r = await record(id)
      await stopPack(r, {})
    }))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) {
      closing = false
      throw new AggregateError(errors, errors.map(String).join('; '))
    }
    for (const id of claims.keys()) releaseClaim(id)
    stoppedForMaintenance = true
  }
  async function resources(r: PackRecord, kind: unknown) {
    const s = await options.resolveSettings(r, await config(r.id))
    if (kind === 'plugins') {
      const items = (await readProfile(s.dshHome, s.profileName)).plugins
      return { items: await Promise.all(items.map(async item => {
        const provenance = await readFile(path.join(s.dshHome, '.launcher-shared-plugins-' + encodeURIComponent(item.packageName) + '.json'), 'utf8').then(text => JSON.parse(text) as { sourcePackId: string }).catch(() => null)
        return provenance ? { ...item, shared: true, sourcePackId: provenance.sourcePackId, sourcePackName: (await readPackRegistry(options.registryPath)).find(p => p.id === provenance.sourcePackId)?.name } : item
      })) }
    }
    if (kind === 'skills' || kind === 'presets') {
      const folder = kind === 'skills' ? 'skills' : 'agent-presets'
      const items = kind === 'skills' ? await readInstalledSkills(s.dshHome) : await readInstalledPresets(s.dshHome)
      return { items: await Promise.all(items.map(async item => {
        const provenance = await readFile(path.join(s.dshHome, '.launcher-shared-' + folder + '-' + item.name + '.json'), 'utf8').then(text => JSON.parse(text) as { sourcePackId: string }).catch(() => null)
        return provenance ? { ...item, shared: true, sourcePackId: provenance.sourcePackId, sourcePackName: (await readPackRegistry(options.registryPath)).find(p => p.id === provenance.sourcePackId)?.name } : item
      })) }
    }
    throw new Error('Invalid resource kind')
  }
  async function assertNotSharedSource(sourceId: string, kind?: unknown, name?: unknown): Promise<void> {
    const base = await options.readSettings()
    for (const target of await readPackRegistry(options.registryPath)) {
      if (target.id === sourceId) continue
      const home = target.homePath ?? base.dshHome
      for (const file of await readdir(home).catch(() => [])) {
        if (!file.startsWith('.launcher-shared-') || !file.endsWith('.json')) continue
        const ref = await readFile(path.join(home, file), 'utf8').then(text => JSON.parse(text) as { sourcePackId: string; kind: string; name: string }).catch(() => null)
        if (ref?.sourcePackId === sourceId && (!kind || ref.kind === kind) && (!name || ref.name === name)) throw new Error('Unlink shared references from pack ' + target.name + ' before removing their source')
      }
    }
  }
  async function verifiedRuntimeUrl(id: string, state: PackRuntimeState): Promise<URL | null> {
    if (!state.running || !state.url || !validPort(state.port) || state.pid === null) return null
    const url = loopbackUrl(state.url, state.port)
    if (controllers.get(id)?.isRunning()) {
      const current = readProcessIdentity(state.pid)
      if (current.status !== 'alive' || !await ownsListener(current.identity, url, state.port)) return null
    } else if (!discovered.get(id)?.worker || verifyProcessIdentity(discovered.get(id)!.worker!.record.runtime) !== 'match') return null
    verifiedUrls.set(id, { url: url.href, pid: state.pid, startedAt: state.startedAt, rawUrl: state.url })
    return url
  }

  async function execute(request: LauncherControlRequest): Promise<unknown> {
    if (!request || typeof request.command !== 'string' || (request.args !== undefined && (!request.args || typeof request.args !== 'object' || Array.isArray(request.args)))) throw new Error('Invalid control request')
    const { command, packId } = request
    const args = request.args ?? {}
    if (command === 'pack.list') {
      const base = await options.readSettings()
      if (!closing) await reconcileRunningPacks(true)
      return { packs: await Promise.all((await readPackRegistry(options.registryPath)).map(async r => {
        const runtime = runtimeStateOf(r.id)
        const url = await verifiedRuntimeUrl(r.id, runtime).catch(() => null)
        if (runtime.running && !url) { runtime.url = null; verifiedUrls.delete(r.id) }
        if (options.probePackActiveSessions && runtime.running) {
          runtime.activeSessionCount = null
          const count = url ? await options.probePackActiveSessions(url.href).catch(() => null) : null
          if (count !== null && Number.isInteger(count) && count >= 0) runtime.activeSessionCount = count
        }
        return {
          ...toPackStatus(r, base.activePackId), homePath: r.homePath, config: await config(r.id), runtime,
          externalRuntime: discovered.get(r.id)?.external ?? null,
        }
      })) }
    }
    if (closing && !['pack.config.get', 'pack.resources.list'].includes(command)) throw new Error('Launcher is shutting down')
    if (command === 'pack.create') return options.lifecycle?.(command, undefined, args)
    const r = await record(packId)
    if (closing && !['pack.config.get', 'pack.resources.list'].includes(command)) throw new Error('Launcher is shutting down')
    if (command === 'pack.delete') {
      await assertPackRemovable(r.id)
      return options.lifecycle?.(command, r.id, args)
    }
    if (command === 'pack.config.get') return config(r.id)
    if (command === 'pack.config.set') return serial(r.id, () => withWriteClaim(r, async () => {
      const patch = validatePackConfig(args)
      const next = writeQueue.catch(() => undefined).then(async () => {
        const all = await configs()
        const updated = { ...await config(r.id), ...patch }
        all[r.id] = updated
        await writeFileAtomic(configPath, JSON.stringify(all, null, 2) + '\n')
        if (!controllers.get(r.id)?.isRunning()) controllers.delete(r.id)
        return updated
      })
      writeQueue = next
      return next
    }))
    if (command === 'pack.resources.list') return resources(r, args.kind)
    if (command === 'pack.market.catalog' || command === 'pack.market.compatibility') {
      return options.market?.(command, await options.resolveSettings(r, await config(r.id, command !== 'pack.market.compatibility')), args)
    }
    if (command === 'pack.stop' && args.force === true && controllers.get(r.id)?.isRunning()) {
      if (closing) throw new Error('Launcher is shutting down')
      const action = stopPack(r, args)
      immediateStops.add(action)
      try { return await action } finally { immediateStops.delete(action) }
    }
    if (closing && !['pack.config.get', 'pack.resources.list'].includes(command)) throw new Error('Launcher is shutting down')
    return serial(r.id, async () => {
      if (command === 'pack.start') return startPack(r)
      if (command === 'pack.restart') {
        await discover(r, await identitySettings(r), true)
        const found = discovered.get(r.id)
        if (found && found.worker?.state.ownership !== 'owned') throw discoveryError(found)
        const epoch = restartEpochs.get(r.id) ?? 0
        restarts.set(r.id, { restarting: true, lastError: null })
        void serial(r.id, () => restartPack(r, epoch)).catch(() => undefined)
        return { accepted: true, restarting: true }
      }
      if (command === 'pack.stop') return stopPack(r, args)
      if (command === 'pack.openWeb') {
        const settings = await identitySettings(r)
        await discover(r, settings, true, true)
        const state = runtimeStateOf(r.id)
        if (!state.running || !state.url) throw new Error('Pack Web service is not ready')
        const url = await verifiedRuntimeUrl(r.id, state)
        if (!url) throw new Error('Pack Web listener ownership could not be verified')
        await options.openExternal(url.href)
        return state
      }
      const current = command === 'pack.market.install' || command === 'pack.market.update' ? await record(r.id) : r
      return withWriteClaim(current, async () => {
      // 运行中的整合包也允许改插件/资源：改动照常写进家目录，下次启动生效（前端自己提示「下次启动生效」）。
      // 真的写不进去时（Windows 文件被占用）不静默：serial 会把这类错误翻成中文再抛。
      const s = await options.resolveSettings(current, await config(current.id))
      if (command === 'pack.market.update') {
        if (typeof args.packageName !== 'string' || !isSafePackageName(args.packageName)) throw new Error('Invalid package name')
        const provenance = path.join(s.dshHome, '.launcher-shared-plugins-' + encodeURIComponent(args.packageName) + '.json')
        const linked = await lstat(provenance).then(() => true).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        })
        if (linked) throw new Error('请先解除共享引用，再更新此插件。')
        await assertNotSharedSource(r.id, 'plugins', args.packageName)
      }
      if (command.startsWith('pack.market.') || command.startsWith('pack.skillMarket.')) return options.market?.(command, s, args)
      if (command === 'pack.resources.enabled' || command === 'pack.resources.remove') {
        if (command.endsWith('.remove') || args.kind === 'skills' || args.kind === 'presets') await assertNotSharedSource(r.id, args.kind, args.name)
        if (typeof args.name !== 'string') throw new Error('Resource name required')
        const name = args.name
        if (command.endsWith('.enabled') && typeof args.enabled !== 'boolean') throw new Error('enabled must be boolean')
        if (args.kind === 'plugins') {
          if (!isSafePackageName(name)) throw new Error('Invalid package name')
          if (command.endsWith('.remove')) {
            const sidecar = path.join(s.dshHome, '.launcher-shared-plugins-' + encodeURIComponent(name) + '.json')
            const shared = await readFile(sidecar, 'utf8').then(() => true).catch(() => false)
            if (!shared) return options.market?.('pack.market.remove', s, args)
            const manifestPath = path.join(s.dshHome, 'profiles', s.profileName, 'package.json')
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
            delete manifest.dependencies?.[name]
            if (manifest.dsh?.profile?.bundles) manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n: string) => n !== name)
            await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2))
            await rm(path.join(s.dshHome, 'profiles', s.profileName, 'node_modules', name), { force: true })
            await rm(sidecar, { force: true })
            return resources(r, args.kind)
          }
          await togglePlugin(s.dshHome, s.profileName, name, args.enabled as boolean)
        } else if (args.kind === 'skills') {
          if (command.endsWith('.remove')) await uninstallInstalledSkill(s.dshHome, name)
          else await toggleInstalledSkill(s.dshHome, name, args.enabled as boolean)
        } else if (args.kind === 'presets') {
          if (command.endsWith('.remove')) await uninstallInstalledPreset(s.dshHome, name, path.join(s.dshHome, '.launcher-preset-receipts.json'))
          else await toggleInstalledPreset(s.dshHome, name, args.enabled as boolean)
        } else throw new Error('Invalid resource kind')
        if (command.endsWith('.remove')) await rm(path.join(s.dshHome, '.launcher-shared-' + (args.kind === 'presets' ? 'agent-presets' : String(args.kind)) + '-' + encodeURIComponent(name) + '.json'), { force: true })
        return resources(r, args.kind)
      }
      if (command === 'pack.resources.link') {
        if (!['plugins', 'skills', 'presets'].includes(String(args.kind)) || typeof args.name !== 'string' || !(args.kind === 'plugins' ? isSafePackageName(args.name) : isSkillName(args.name))) throw new Error('Invalid shared resource')
        if (args.sourcePackId === r.id) throw new Error('A pack cannot share a resource with itself')
        const source = await record(String(args.sourcePackId ?? ''))
        const sourceSettings = await options.resolveSettings(source, await config(source.id))
        const folder = args.kind === 'plugins' ? 'profiles/' + s.profileName + '/node_modules' : args.kind === 'skills' ? 'skills' : '.agent-presets'
        const sourceFolder = args.kind === 'plugins' ? 'profiles/' + sourceSettings.profileName + '/node_modules' : folder
        const skill = args.kind === 'skills' ? (await readInstalledSkills(sourceSettings.dshHome)).find(item => item.name === args.name) : null
        const sourcePath = skill?.path ?? path.join(sourceSettings.dshHome, sourceFolder, args.name)
        const dest = path.join(s.dshHome, folder, skill?.format === 'flat' ? path.basename(sourcePath) : args.name)
        const body = await realpath(sourcePath)
        const directory = (await lstat(body)).isDirectory()
        if (!directory && skill?.format !== 'flat') throw new Error('Shared resource must be a directory')
        await mkdir(path.dirname(dest), { recursive: true })
        const manifestPath = path.join(s.dshHome, 'profiles', s.profileName, 'package.json')
        const previousManifest = args.kind === 'plugins' ? await readFile(manifestPath, 'utf8').catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }) : null
        const sidecar = path.join(s.dshHome, '.launcher-shared-' + (args.kind === 'plugins' ? 'plugins' : folder.replace('.', '')) + '-' + encodeURIComponent(args.name) + '.json')
        if (directory) await symlink(body, dest, process.platform === 'win32' ? 'junction' : 'dir')
        else await link(body, dest)
        try {
        if (args.kind === 'plugins') {
          type Manifest = { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
          const manifest: Manifest = previousManifest === null ? {} : JSON.parse(previousManifest)
          manifest.dependencies = { ...manifest.dependencies, [args.name]: 'file:' + body }
          manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...new Set([...(manifest.dsh?.profile?.bundles ?? []), args.name])] } }
          await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2))
        }
        await writeFileAtomic(sidecar, JSON.stringify({ sourcePackId: source.id, name: args.name, kind: args.kind, sourcePath: body }))
        } catch (error) {
          await rm(dest, { force: true })
          if (args.kind === 'plugins') {
            if (previousManifest === null) await rm(manifestPath, { force: true })
            else await writeFileAtomic(manifestPath, previousManifest)
          }
          throw error
        }
        return resources(r, args.kind)
      }
      if (command === 'pack.rename') return options.lifecycle?.(command, r.id, args)
      throw new Error('Unsupported control command: ' + command)
      })
    })
  }
  async function assertWritable(r: PackRecord, createIdentity = false) {
    if (removals.has(r.id)) throw new Error('Pack removal is in progress')
    if (closing) throw new Error('Launcher is shutting down')
    const settings = await identitySettings(r)
    await discover(r, settings, false)
    const found = discovered.get(r.id)
    if (found && found.worker?.state.ownership !== 'owned') throw new Error('Cannot modify a pack with an external or unverified runtime')
    const identity = await identityOf(settings, createIdentity)
    if (identity && !claims.has(r.id)) {
      if (claim(r.id, identity) === 'busy') throw new Error('This pack is owned by another launcher')
      // A live worker can appear while taking over from an exiting launcher.
      await discover(r, settings, false)
      const current = discovered.get(r.id)
      if (current && current.worker?.state.ownership !== 'owned') throw new Error('Cannot modify a pack with an external or unverified runtime')
    }
  }

  return {
    execute,
    async autoStart() {
      const all = await readPackRegistry(options.registryPath)
      return Promise.allSettled(all.map(async r => {
        if (!(await config(r.id)).autoStart) return
        try {
          if (closing) return
          await serial(r.id, async () => {
            if (closing) return
            await discover(r, await identitySettings(r), true)
            if (!isPackRunning(r.id)) await startPack(r)
          })
          restarts.delete(r.id)
        } catch (error) {
          // 自启失败以前被 allSettled 吞掉：界面只剩「外部运行中」，用户看不到为什么没起来。
          const message = '开机自启失败：' + (error instanceof Error ? error.message : String(error))
          restarts.set(r.id, { restarting: false, lastError: message })
          console.warn('[pack-autostart] ' + r.id + ': ' + message)
        }
      }))
    },
    reconcileRunningPacks: () => reconcileRunningPacks(true),
    prepareForRelaunch,
    shutdown,
    resumeAfterStop() {
      if (!stoppedForMaintenance) return
      stoppedForMaintenance = false
      closing = false
    },
    isRunning: () => [...new Set([...controllers.keys(), ...discovered.keys()])].some(isPackRunning),
    isPackRunning,
    runtimeUrl: (id: string) => {
      const latest = runtimeStateOf(id)
      const verified = verifiedUrls.get(id)
      return latest.running && verified && verified.pid === latest.pid && verified.startedAt === latest.startedAt && verified.rawUrl === latest.url ? verified.url : null
    },
    assertPackRemovable,
    acquirePackRemoval,
    async withPackRemoval<T>(id: string, action: () => Promise<T>): Promise<T> {
      const release = await acquirePackRemoval(id)
      try { return await action() } finally { release() }
    },
    async withPackMutation<T>(id: string, action: () => Promise<T>, requireStopped = false): Promise<T> {
      const r = await record(id)
      return serial(id, () => withWriteClaim(r, async () => {
        if (requireStopped && isPackRunning(id)) throw new Error('Stop the pack before modifying it')
        return action()
      }))
    },
    async forgetPack(id: string) {
      const next = writeQueue.catch(() => undefined).then(async () => {
        const saved = await configs(); delete saved[id]
        await writeFileAtomic(configPath, JSON.stringify(saved, null, 2))
        controllers.delete(id); controllerHomes.delete(id); discovered.delete(id); verifiedUrls.delete(id); if (!removals.has(id)) releaseClaim(id)
      })
      writeQueue = next; await next
    },
    hasRunningHome: (home: string) => {
      const canonical = canonicalHome(home)
      return [...controllerHomes].some(([id, h]) => samePath(h, canonical) && controllers.get(id)?.isRunning()) ||
        [...discovered].some(([id, entry]) => samePath(entry.home, canonical) && isPackRunning(id))
    },
  }
}
