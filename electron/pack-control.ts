import path from 'node:path'
import { readFile, mkdir, symlink, lstat, realpath, rm, readdir, link, rename } from 'node:fs/promises'
import type { AppSettings, ExternalRuntime, LauncherControlRequest, PackControlConfig, RuntimeState } from '../src/types'
import { readPackRegistry, toPackStatus, type PackRecord } from './pack-registry'
import { writeFileAtomic } from './fs-atomic'
import { createRuntimeController, findAvailableWebPort, type RuntimeController, type RuntimeControllerOptions } from './runtime'
import { clearElevatedSession, elevatedSessionPath, readElevatedSession, scanExternalRuntimes, stopExternalRuntime } from './external-runtime'
import { readProfile, togglePlugin, isSafePackageName } from './profile'
import { readInstalledSkills, toggleInstalledSkill, uninstallInstalledSkill, isSkillName } from './skill-format'
import { readInstalledPresets, toggleInstalledPreset, uninstallInstalledPreset } from './preset-install'

export interface PackControlOptions {
  userData: string
  registryPath: string
  readSettings: () => Promise<AppSettings>
  resolveSettings: (record: PackRecord, config: PackControlConfig) => Promise<AppSettings>
  runtimeOptions: (record: PackRecord, settings: AppSettings) => Omit<RuntimeControllerOptions, 'readSettings'>
  createController?: typeof createRuntimeController
  openExternal: (url: string) => Promise<unknown>
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
  const queues = new Map<string, Promise<unknown>>()
  let writeQueue: Promise<unknown> = Promise.resolve()
  let portQueue: Promise<unknown> = Promise.resolve()
  const reservations = new Set<number>()
  let closing = false
  /** 后台重启的状态：controller 会被换掉，所以 restarting/lastError 只能记在这张表里。 */
  const restarts = new Map<string, { restarting: boolean; lastError: string | null }>()
  const runtimeStateOf = (id: string): RuntimeState => {
    const base: RuntimeState = controllers.get(id)?.state() ?? { running: false, pid: null, startedAt: null, url: null, port: null }
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
  const stopExternal = options.externalRuntime?.stop ?? stopExternalRuntime
  const serial = <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action)
      .catch((error: unknown) => { throw asResourceWriteFailure(error, key, controllers.get(key)?.isRunning() === true) })
    queues.set(key, next)
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => undefined)
    return next
  }
  async function configs(): Promise<Record<string, PackControlConfig>> {
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
      // 手改坏的配置不该连累列表：留档一份再按默认值继续，别让用户丢文件。
      const backup = configPath + '.corrupt-' + Date.now()
      await rename(configPath, backup).catch(() => undefined)
      console.warn('[pack-control] 配置文件解析失败，已留档到 ' + backup, error)
      return {}
    }
  }
  async function config(id: string): Promise<PackControlConfig> {
    const base = await options.readSettings()
    const saved: Partial<PackControlConfig> | undefined = (await configs())[id]
    return Object.assign({ portMode: 'auto' as const, port: base.webPort, runAsAdmin: false, autoStart: false, pinnedAt: null }, saved)
  }
  async function record(id?: string): Promise<PackRecord> {
    if (typeof id !== 'string' || !id) throw new Error('packId is required')
    const found = (await readPackRegistry(options.registryPath)).find(r => r.id === id)
    if (!found) throw new Error('Unknown pack: ' + id)
    return found
  }
  /** 本进程内存里托管的那些 pid：它们不是「外部」进程，扫描时要排掉。 */
  function hostedPids(): number[] {
    return [...controllers.values()].map(c => c.state().pid).filter((pid): pid is number => typeof pid === 'number')
  }
  async function findExternal(r: PackRecord, profileName: string): Promise<ExternalRuntime | null> {
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
  async function controller(r: PackRecord): Promise<RuntimeController> {
    const existing = controllers.get(r.id)
    if (existing) return existing
    const c = await config(r.id)
    const settings = await options.resolveSettings(r, c)
    const home = path.resolve(settings.dshHome).toLowerCase()
    if ([...controllerHomes.entries()].some(([id, h]) => id !== r.id && h === home && (controllers.get(id)?.isRunning() || queues.has(id)))) throw new Error('Another pack is already using this home')
    // 同一个家目录被别的包的外部遗留进程占着，也不能起。
    const shared: Array<{ id: string; profileName: string }> = []
    for (const sibling of await readPackRegistry(options.registryPath)) {
      if (sibling.id === r.id) continue
      const siblingSettings = await options.resolveSettings(sibling, await config(sibling.id))
      if (path.resolve(siblingSettings.dshHome).toLowerCase() === home) shared.push({ id: sibling.id, profileName: siblingSettings.profileName })
    }
    if (shared.length) {
      const externals = await scanExternal({ packs: shared, excludePids: hostedPids() })
      const occupied = [...externals.values()][0]
      if (occupied) throw new Error('另一个整合包的 DSH 还在用同一个家目录（PID ' + occupied.pid + '）。先停止它再启动。')
    }
    controllerHomes.set(r.id, home)
    await options.beforeStart?.(r, settings)
    const runtime = (options.createController ?? createRuntimeController)({ ...options.runtimeOptions(r, settings), readSettings: async () => settings, portMode: c.portMode, portFallbackAttempts: 100, runAsAdmin: c.runAsAdmin, reservePort: reserve, releasePort: p => reservations.delete(p), elevatedStash: { root: elevatedRoot, packId: r.id } })
    controllers.set(r.id, runtime)
    return runtime
  }
  /** 后台串行执行的 stop → start：失败只落到 runtime.lastError，绝不抛给已经拿到 accepted 的调用方。 */
  async function restartPack(r: PackRecord): Promise<void> {
    const running = controllers.get(r.id)
    if (running) {
      try {
        await running.stop()
      } catch (error) {
        // 停不下来就不要再起第二份：原因留在状态里，用户可改用「强制停止」。
        noteRestartFailure(r.id, error)
        return
      } finally {
        // stop 抛错也必须摘掉旧 controller，否则 map 里留着一个已经失效的实例。
        controllers.delete(r.id)
        await clearElevatedSession(elevatedRoot, r.id).catch(() => undefined)
      }
    }
    try {
      await (await controller(r)).start()
      restarts.delete(r.id)
    } catch (error) {
      noteRestartFailure(r.id, error)
    }
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
  async function execute(request: LauncherControlRequest): Promise<unknown> {
    if (!request || typeof request.command !== 'string' || (request.args !== undefined && (!request.args || typeof request.args !== 'object' || Array.isArray(request.args)))) throw new Error('Invalid control request')
    const { command, packId } = request
    const args = request.args ?? {}
    if (command === 'pack.list') {
      const base = await options.readSettings()
      const items = await Promise.all((await readPackRegistry(options.registryPath)).map(async r => {
        const c = await config(r.id)
        const settings = await options.resolveSettings(r, c)
        return { record: r, config: c, profileName: settings.profileName }
      }))
      // 一次扫描覆盖全部包：列表页会被频繁拉取，批处理才不至于每次都起一次 PowerShell。
      const externals = await scanExternal({ packs: items.map(item => ({ id: item.record.id, profileName: item.profileName })), excludePids: hostedPids() })
      return { packs: await Promise.all(items.map(async item => {
        const target = externals.get(item.record.id) ?? null
        const session = target ? await readElevatedSession(elevatedRoot, item.record.id).catch(() => null) : null
        return {
          ...toPackStatus(item.record, base.activePackId),
          homePath: item.record.homePath,
          config: item.config,
          runtime: runtimeStateOf(item.record.id),
          externalRuntime: target ? { ...target, elevatedSession: session ? elevatedSessionPath(elevatedRoot, item.record.id) : null } : null,
        }
      })) }
    }
    if (command === 'pack.create') return options.lifecycle?.(command, undefined, args)
    const r = await record(packId)
    if (command === 'pack.config.get') return config(r.id)
    if (command === 'pack.config.set') return serial(r.id, async () => {
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
    })
    if (command === 'pack.resources.list') return resources(r, args.kind)
    return serial(r.id, async () => {
      if (command === 'pack.start' || command === 'pack.restart') {
        if (closing) throw new Error('Launcher is shutting down')
        const startSettings = await options.resolveSettings(r, await config(r.id))
        const external = await findExternal(r, startSettings.profileName)
        if (external) throw new Error('这个整合包已经有一份没被启动器托管的 DSH 在运行（PID ' + external.pid + '，端口 ' + (external.port ?? '未知') + '）。先停止它再启动。')
        if (command === 'pack.restart') {
          // 先回话、后执行：停+起要花好几秒（提权时还要等用户应答 UAC），调用方不能被挂在这里。
          restarts.set(r.id, { restarting: true, lastError: null })
          void serial(r.id, () => restartPack(r)).catch(() => undefined)
          return { accepted: true, restarting: true }
        }
        return (await controller(r)).start()
      }
      if (command === 'pack.stop') {
        const runtime = controllers.get(r.id)
        if (runtime) {
          const state = await runtime.stop({ force: args.force === true })
          controllers.delete(r.id)
          restarts.delete(r.id)
          await clearElevatedSession(elevatedRoot, r.id)
          return state
        }
        const stopSettings = await options.resolveSettings(r, await config(r.id))
        const external = await findExternal(r, stopSettings.profileName)
        // 内存里没有 controller 也不代表没在跑：先扫一遍外部遗留进程，扫不到才算真没跑。
        if (!external) return { running: false, pid: null, startedAt: null, url: null, port: null }
        const stored = await options.readSettings()
        const allowElevation = args.noElevated === true ? false : stored.elevatedStopPrompt !== false
        const method = await stopExternal(external, { dataDir: options.userData, allowElevation, log: text => console.log('[pack-stop] ' + r.id + ': ' + text) })
        await clearElevatedSession(elevatedRoot, r.id)
        return { running: false, pid: null, startedAt: null, url: null, port: null, externalStopped: true, stoppedBy: method }
      }
      if (command === 'pack.openWeb') {
        const state = controllers.get(r.id)?.state()
        if (!state?.running || !state.url) throw new Error('Pack Web service is not ready')
        const url = new URL(state.url)
        if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Invalid runtime URL')
        await options.openExternal(url.href)
        return state
      }
      // 运行中的整合包也允许改插件/资源：改动照常写进家目录，下次启动生效（前端自己提示「下次启动生效」）。
      // 真的写不进去时（Windows 文件被占用）不静默：serial 会把这类错误翻成中文再抛。
      const s = await options.resolveSettings(r, await config(r.id))
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
      if (command === 'pack.delete') await assertNotSharedSource(r.id)
      if (command === 'pack.rename' || command === 'pack.delete') return options.lifecycle?.(command, r.id, args)
      throw new Error('Unsupported control command: ' + command)
    })
  }
  return {
    execute,
    async autoStart() {
      const all = await readPackRegistry(options.registryPath)
      const saved = await configs()
      return Promise.allSettled(all.map(async r => { if ((await config(r.id)).autoStart) await execute({ command: 'pack.start', packId: r.id }) }))
    },
    async shutdown() { closing = true; await Promise.allSettled([...queues.values()]); await Promise.allSettled([...controllers.values()].map(c => c.stop())) },
    isRunning: () => [...controllers.values()].some(c => c.isRunning()),
    isPackRunning: (id: string) => controllers.get(id)?.isRunning() ?? false,
    runtimeUrl: (id: string) => controllers.get(id)?.state().url ?? null,
    assertPackRemovable: (id: string) => assertNotSharedSource(id),
    async forgetPack(id: string) {
      const next = writeQueue.catch(() => undefined).then(async () => {
        const saved = await configs(); delete saved[id]
        await writeFileAtomic(configPath, JSON.stringify(saved, null, 2))
        controllers.delete(id); controllerHomes.delete(id)
      })
      writeQueue = next; await next
    },
    hasRunningHome: (home: string) => [...controllerHomes.entries()].some(([id, h]) => h === path.resolve(home).toLowerCase() && controllers.get(id)?.isRunning()),
  }
}
