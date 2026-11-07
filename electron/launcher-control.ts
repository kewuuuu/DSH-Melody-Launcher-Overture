import path from 'node:path'
import type { LauncherApiEntryInput, LauncherControlRequest, MigratablePath, SkillInstallTarget } from '../src/types'
import type { PackManager } from './pack'
import type { SettingsStore } from './settings'
import type { NodeRuntime, PnpmRuntime } from './node-runtime'
import { findManagedDshVersions } from './runtime-versions'
import { createPackControl } from './pack-control'
import { ensureLauncherControlSkill } from './launcher-control-skill'
import { createDshMarketService } from './dsh-market'
import { createInstaller } from './installer'
import { matchSkillsShTarget } from './skills-sh'
import { isSafeRepositoryName } from './profile'
import type { StorageController } from './storage-root'
import { createApiLibrary, type ApiLibrary } from './api-library'
import { createPackApis } from './pack-apis'
import { createPendingResumeQueue, enqueueBeforeRestart, type PendingResumeQueue } from './pending-resume'
import { migratePath } from './path-migration'

export function createLauncherControl(options: {
  userData: string
  cliPath: string
  settings: SettingsStore
  packManager: PackManager
  prepareNodeRuntime: () => Promise<NodeRuntime>
  preparePnpmRuntime: (node: NodeRuntime) => Promise<PnpmRuntime>
  openExternal: (url: string) => Promise<unknown>
  fallbackWorkspace: () => string
  fetchImpl: typeof fetch
  emitOutput: (text: string) => void
  loginRegistration: (enabled: boolean) => void
  storage: StorageController
  legacyRuntimeRunning: () => boolean
  prepareOfficeCliTool?: import('./runtime').RuntimeControllerOptions['prepareOfficeCliTool']
  /** 父级接线时可注入同一条队列给 IPC 复用；缺省按 userData 建一条。 */
  pendingResumeQueue?: PendingResumeQueue
  /** 卸载服务；没有装配时 uninstall.* 命令一律报错而不是静默跳过。 */
  uninstall?: import('./uninstall').UninstallService
  /** helper 已经起好之后的通知：主进程据此退出，helper 才能删掉被占用的 EXE。 */
  onUninstallStarted?: () => void
}) {
  const { userData, settings } = options
  const storage = options.storage
  const control = createPackControl({
    userData,
    registryPath: path.join(userData, 'packs.json'),
    readSettings: () => settings.readStored(),
    resolveSettings: async (record, config) => {
      const base = await settings.readStored()
      const home = record.homePath ?? base.dshHome
      let executable = base.launchExecutable
      if (record.dshVersion) {
        const installed = (await findManagedDshVersions(base.dshInstallPath)).find(v => v.version === record.dshVersion)
        if (!installed) throw new Error('Install the required DSH version first: ' + record.dshVersion)
        executable = installed.executable
      }
      return { ...base, activePackId: record.id, dshHome: home, dshVersion: record.dshVersion ?? base.dshVersion, profileName: record.id, launchExecutable: executable, launchArgs: config.launchArgs ?? ['web'], workspace: config.workspace || base.workspace, webPort: config.port, openAfterLaunch: false }
    },
    runtimeOptions: record => ({
      prepareNodeRuntime: options.prepareNodeRuntime,
      prepareOfficeCliTool: options.prepareOfficeCliTool,
      fallbackWorkspace: options.fallbackWorkspace,
      emitOutput: (_level, text) => options.emitOutput('[' + record.name + '] ' + text),
      emitState: () => undefined,
      openExternal: url => { void options.openExternal(url) },
      legacyCredentialsBackupRoot: path.join(userData, 'dsh-credentials-compat'),
      credentialsRefRepairRoot: path.join(userData, 'dsh-credentials-ref-repair'),
      packageStoreRoot: path.join(userData, 'plugin-store'),
    }),
    beforeStart: async (record, target) => {
      const base = await settings.read()
      if (options.legacyRuntimeRunning() && path.resolve(base.dshHome) === path.resolve(target.dshHome)) throw new Error('This pack is already running through the legacy launch controls')
      const node = await options.prepareNodeRuntime()
      await ensureLauncherControlSkill({ packHome: target.dshHome, cliPath: options.cliPath, userData, packId: record.id, nodePath: node.node })
    },
    openExternal: options.openExternal,
    lifecycle: async (command, id, args) => {
      if (command === 'pack.create') {
        if (typeof args.name !== 'string' || (args.dshVersion !== undefined && args.dshVersion !== null && typeof args.dshVersion !== 'string')) throw new Error('Invalid pack creation arguments')
        return options.packManager.createBlankPack({ name: args.name, dshVersion: args.dshVersion as string | null ?? null })
      }
      if (!id) throw new Error('packId required')
      if (command === 'pack.rename') {
        if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('Pack name required')
        return options.packManager.renamePack(id, args.name)
      }
      if (command === 'pack.delete') return options.packManager.removePack(id)
      throw new Error('Unsupported lifecycle command')
    },
    market: async (command, target, args) => {
      const installer = createInstaller({
        readSettings: async () => target,
        saveSettings: async () => { throw new Error('Explicit pack installs cannot change global settings') },
        prepareNodeRuntime: options.prepareNodeRuntime,
        preparePnpmRuntime: options.preparePnpmRuntime,
        pluginSourceRoot: path.join(userData, 'plugin-sources'),
        pluginReceiptsPath: path.join(target.dshHome, '.launcher-plugin-receipts.json'),
        presetReceiptsPath: path.join(target.dshHome, '.launcher-preset-receipts.json'),
        skillReceiptsPath: path.join(target.dshHome, '.launcher-skill-receipts.json'),
        skillSourceRoot: path.join(userData, 'skill-sources'),
        packageStoreRoot: path.join(userData, 'plugin-store'),
        emitOutput: (_level, text) => options.emitOutput(text), emitProgress: () => undefined,
        isRuntimeRunning: () => false, githubFetch: options.fetchImpl,
      })
      if (command.startsWith('pack.skillMarket.')) {
        const request = args.request as Record<string, unknown> | undefined
        if (!request || typeof request !== 'object') throw new Error('Skill request required')
        if (command === 'pack.skillMarket.install') {
          const t = request.target as SkillInstallTarget | undefined
          if (typeof request.repository !== 'string' || !isSafeRepositoryName(request.repository) || !t || typeof t.name !== 'string' || typeof t.id !== 'string' || typeof t.sourcePath !== 'string' || typeof t.revision !== 'string' || !['bundle', 'flat'].includes(t.format)) throw new Error('Invalid skill target')
          return installer.installSkillFromMarket({ repository: request.repository, target: t })
        }
        if (command !== 'pack.skillMarket.installByName' || typeof request.sourceRepository !== 'string' || !isSafeRepositoryName(request.sourceRepository) || typeof request.skillId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(request.skillId)) throw new Error('Invalid skill request')
        for (const branch of ['main', 'master']) {
          const analysis = await installer.analyzeSkillArchive(request.sourceRepository, branch).catch(() => null)
          const t = analysis && matchSkillsShTarget(analysis.targets, request.skillId)
          if (t) return installer.installSkillFromMarket({ repository: request.sourceRepository, target: t })
        }
        throw new Error('Skill not found in source repository')
      }
      if (typeof args.name !== 'string' || !args.name.trim()) throw new Error('Market plugin name required')
      const market = createDshMarketService({ readSettings: async () => target, prepareNodeRuntime: options.prepareNodeRuntime, preparePnpmRuntime: options.preparePnpmRuntime, fetchImpl: options.fetchImpl, packageStoreRoot: path.join(userData, 'plugin-store'), emitProgress: () => undefined, emitOutput: (_level, text) => options.emitOutput(text) })
      if (command === 'pack.market.install') return market.install(args.name)
      if (command === 'pack.market.remove') return installer.remove(args.name, target.profileName)
      throw new Error('Unsupported targeted market command')
    },
  })
  const pendingResumeQueue = options.pendingResumeQueue ?? createPendingResumeQueue({ file: path.join(userData, 'pending-resumes.json'), fetch: options.fetchImpl })
  // 续接要在包重启前就登记好，所以 CLI 的 pack restart --resume 走「先入队、再重启」。
  const runtimeUrlOf = async (packId: string): Promise<string | null> => {
    const listed = (await control.execute({ command: 'pack.list' })) as { packs?: Array<{ id?: string; runtime?: { running?: boolean; url?: string } }> }
    const pack = listed?.packs?.find(item => item?.id === packId)
    if (!pack?.runtime?.running || typeof pack.runtime.url !== 'string') return null
    return pack.runtime.url
  }
  // 包一启动好就把积压的续接请求发回去；发送失败只留在队列里，不改变启动结果。
  const deliverPending = (request: LauncherControlRequest, result: unknown): unknown => {
    const target = pendingDeliveryFor(request, result)
    if (target) void pendingResumeQueue.deliver(target.packId, target.url).catch(() => undefined)
    return result
  }
  const pendingResumes = {
    list: () => pendingResumeQueue.list(),
    async retry(id: string) {
      const targetId = typeof id === 'string' ? id.trim() : ''
      if (!targetId) throw new Error('缺少续接请求 ID。')
      const entries = await pendingResumeQueue.list()
      const entry = entries.find(item => item.id === targetId)
      if (!entry) throw new Error('未找到续接请求：' + targetId)
      const baseUrl = await runtimeUrlOf(entry.packId)
      if (!baseUrl) {
        const next = await pendingResumeQueue.retry(targetId)
        return { ok: false, error: '整合包 ' + entry.packId + ' 未在运行，续接请求已保留，待该包启动后再发送。', entries: next }
      }
      const next = await pendingResumeQueue.retry(targetId, baseUrl)
      const updated = next.find(item => item.id === targetId)
      const sent = updated?.status === 'sent'
      return { ok: sent, error: sent ? null : (updated?.error ?? '续接消息未能发送。'), entries: next }
    },
    discard: (id: string) => pendingResumeQueue.discard(id),
  }
  // 目录迁移：设置里的 dshHome / dshInstallPath 是唯一来源；旧目录先备份，有包在跑就留着不删。
  const paths = {
    migrate: (kind: MigratablePath, target: string) => migratePath({
      kind,
      target,
      current: async () => {
        const latest = await settings.readStored()
        return kind === 'dshHome' ? latest.dshHome : latest.dshInstallPath
      },
      save: async next => {
        const latest = await settings.readStored()
        await settings.save(kind === 'dshHome' ? { ...latest, dshHome: next } : { ...latest, dshInstallPath: next })
      },
      isBusy: () => control.isRunning(),
      launcherDataDir: userData,
    }),
  }
  // 启动器级 API 库与「每包勾选」都只认 userData，与具体整合包无关。
  const apiLibraryStore = createApiLibrary(userData)
  const packApis = createPackApis({ userData, registryPath: path.join(userData, 'packs.json'), readSettings: () => settings.readStored(), isPackRunning: packId => control.isPackRunning(packId) })
  // 库是唯一来源：库条目改动后把新值重新同步进已授予该 API 的包，删除条目则级联撤销。
  const apiLibrary: ApiLibrary = {
    list: () => apiLibraryStore.list(),
    async save(input) {
      const previousRoute = typeof input?.originalRoute === 'string' ? input.originalRoute.trim() : ''
      const entries = await apiLibraryStore.save(input)
      const route = typeof input?.route === 'string' ? input.route.trim() : ''
      if (route) await packApis.resyncGranted(route, previousRoute || undefined)
      return entries
    },
    async remove(route) {
      await packApis.revokeGranted(route)
      return apiLibraryStore.remove(route)
    },
  }
  // 启动器自身随登录启动：设置里的 launchAtLogin 是唯一开关（包 autoStart 只管启动器起来后拉包）。
  const uninstallService = (): import('./uninstall').UninstallService => {
    const service = options.uninstall
    if (!service) throw new Error('当前进程没有装配卸载引擎：主进程没有传入 uninstall 服务。')
    return service
  }
  const applyLaunchAtLogin = async (patch: Record<string, unknown>): Promise<{ launchAtLogin: boolean }> => {
    let enabled = (await settings.readStored()).launchAtLogin === true
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== 'boolean') throw new Error('launchAtLogin 必须是布尔值。')
      enabled = patch.enabled
      const next = settingsQueue.catch(() => undefined).then(async () => settings.save({ ...await settings.readStored(), launchAtLogin: enabled }))
      settingsQueue = next
      await next
    }
    options.loginRegistration(enabled)
    return { launchAtLogin: enabled }
  }
  let settingsQueue: Promise<unknown> = Promise.resolve()
  return {
    ...control,
    apiLibrary,
    packApis,
    pendingResumeQueue,
    pendingResumes,
    paths,
    async execute(request: LauncherControlRequest): Promise<unknown> {
      if (request?.command === 'settings.launchAtLogin') {
        const patch = request.args ?? {}
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => key !== 'enabled')) throw new Error('Unsupported launcher setting')
        return applyLaunchAtLogin(patch)
      }
      if (request?.command === 'api.list') return apiLibrary.list()
      if (request?.command === 'api.save') return apiLibrary.save((request.args ?? {}) as unknown as LauncherApiEntryInput)
      if (request?.command === 'api.remove') {
        const route = request.args?.route
        if (typeof route !== 'string' || !route.trim()) throw new Error('缺少 API 路由：api remove <route>')
        return apiLibrary.remove(route)
      }
      if (request?.command === 'pack.api.list') {
        if (!request.packId) throw new Error('缺少整合包 ID：pack api list <pack-id>')
        return packApis.getState(request.packId)
      }
      if (request?.command === 'pack.api.set') {
        if (!request.packId) throw new Error('缺少整合包 ID：pack api enable|disable <pack-id> <route>')
        const route = request.args?.route
        const enabled = request.args?.enabled
        if (typeof route !== 'string' || !route.trim()) throw new Error('缺少 API 路由：pack api enable|disable <pack-id> <route>')
        if (typeof enabled !== 'boolean') throw new Error('pack.api.set 需要 enabled 布尔值')
        return packApis.setGrant(request.packId, route, enabled)
      }
      if (request?.command === 'settings.get') {
        const s = await settings.readStored()
        return { openAfterLaunch: s.openAfterLaunch, uiTheme: s.uiTheme, appearance: s.appearance, network: s.network }
      }
      if (request?.command === 'settings.set') {
        const patch = request.args ?? {}
        if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['openAfterLaunch','uiTheme','appearance','network'].includes(k))) throw new Error('Unsupported launcher setting')
        const next = settingsQueue.catch(() => undefined).then(async () => settings.save({ ...await settings.readStored(), ...patch }))
        settingsQueue = next
        await next
        const saved = await settings.readStored()
        return { openAfterLaunch: saved.openAfterLaunch, uiTheme: saved.uiTheme, appearance: saved.appearance, network: saved.network }
      }
      if (request?.command === 'storage.info') return storage.get()
      if (request?.command === 'storage.set') {
        const dir = request.args?.dir
        if (typeof dir !== 'string' || !dir.trim()) throw new Error('storage.set 需要一个绝对路径参数 dir，例如 {"dir":"D:\\launcher-data"}。')
        if (!path.isAbsolute(dir)) throw new Error('storage.set 的 dir 必须是绝对路径，当前收到：' + dir + '。请改用完整路径，例如 D:\\launcher-data。')
        return storage.set(dir)
      }
      if (request?.command === 'pending.list') return pendingResumes.list()
      if (request?.command === 'pending.retry') {
        const id = request.args?.id
        if (typeof id !== 'string' || !id.trim()) throw new Error('缺少续接请求 ID：pending retry <id>')
        return pendingResumes.retry(id)
      }
      if (request?.command === 'pending.discard') {
        const id = request.args?.id
        if (typeof id !== 'string' || !id.trim()) throw new Error('缺少续接请求 ID：pending discard <id>')
        return pendingResumes.discard(id)
      }
      if (request?.command === 'path.migrate') {
        const kind = request.args?.kind
        const target = request.args?.target
        if (kind !== 'dshHome' && kind !== 'dshInstallPath') throw new Error('path migrate 需要 dshHome 或 dshInstallPath，例如 path migrate dshHome D:\\dsh-home。')
        if (typeof target !== 'string' || !target.trim()) throw new Error('path migrate 需要一个目标目录：path migrate <dshHome|dshInstallPath> <绝对路径目录>')
        return paths.migrate(kind, target)
      }
      // 先入队、再重启：入队失败就不重启，AI 留下的那句话不会丢。
      if (request?.command === 'pack.restart' && request.args?.resume !== undefined) {
        if (!request.packId) throw new Error('缺少整合包 ID：pack restart <pack-id> --resume "…"')
        const resume = readResumeInput(request.args.resume)
        const rest = { ...request.args }
        delete rest.resume
        const { entry, result } = await enqueueBeforeRestart(
          { enqueue: input => pendingResumeQueue.enqueue(input), restart: () => control.execute({ ...request, args: rest }) },
          { packId: request.packId, ...resume },
        )
        return { resume: entry, runtime: deliverPending(request, result) }
      }
      if (request?.command === 'storage.reset') return storage.reset()
      if (request?.command === 'uninstall.plan') return uninstallService().plan()
      if (request?.command === 'uninstall.script') {
        const out = request.args?.out
        if (typeof out !== 'string' || !out.trim()) throw new Error('uninstall script 需要一个导出目录，例如 uninstall script --out D:\\卸载脚本。')
        if (!path.isAbsolute(out)) throw new Error('uninstall script 的 --out 必须是绝对路径，当前收到：' + out + '。')
        return uninstallService().exportScript(out, { deleteData: request.args?.deleteData === true })
      }
      if (request?.command === 'uninstall.run') {
        if (request.args?.confirm !== true) throw new Error('卸载会删除启动器文件，必须带 --yes 确认：uninstall now --yes')
        const result = await uninstallService().run({ deleteData: request.args?.deleteData === true })
        // CLI 和界面走的是两条路：IPC 那条在自己的 handler 里退出，这条只有 facade 能通知父级。
        options.onUninstallStarted?.()
        return result
      }
      return deliverPending(request, await control.execute(request))
    },
  }
}
/**
 * 哪些成功结果该触发续接投递：只有包启动/重启、且拿到了运行时 URL 的那一次。
 * 抽成纯函数是为了不为了测这一行去起真实运行时。
 */
export function pendingDeliveryFor(request: LauncherControlRequest, result: unknown): { packId: string; url: string } | null {
  if (!request || (request.command !== 'pack.start' && request.command !== 'pack.restart')) return null
  const packId = typeof request.packId === 'string' ? request.packId : ''
  const url = (result as { url?: unknown } | null)?.url
  if (!packId || typeof url !== 'string' || !url) return null
  return { packId, url }
}
function readResumeInput(raw: unknown): { prompt: string; sessionId?: string } {
  if (typeof raw === 'string') {
    if (!raw.trim()) throw new Error('--resume 需要一段续接内容。')
    return { prompt: raw }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('--resume 需要一段续接内容。')
  const value = raw as Record<string, unknown>
  const prompt = typeof value.prompt === 'string' ? value.prompt : ''
  if (!prompt.trim()) throw new Error('--resume 需要一段续接内容。')
  const sessionId = typeof value.sessionId === 'string' && value.sessionId.trim() ? value.sessionId.trim() : undefined
  return { prompt, ...(sessionId ? { sessionId } : {}) }
}
