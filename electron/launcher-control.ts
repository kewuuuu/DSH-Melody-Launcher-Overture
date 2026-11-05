import path from 'node:path'
import type { LauncherControlRequest, SkillInstallTarget } from '../src/types'
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

const STORAGE_UNAVAILABLE = 'storage 不可用：启动器未装配数据目录控制器，请在界面里切换数据目录，或重启启动器后重试。'

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
  storage?: StorageController
  legacyRuntimeRunning: () => boolean
  prepareOfficeCliTool?: import('./runtime').RuntimeControllerOptions['prepareOfficeCliTool']
}) {
  const { userData, settings } = options
  const storage: StorageController = options.storage ?? {
    get() { throw new Error(STORAGE_UNAVAILABLE) },
    set() { throw new Error(STORAGE_UNAVAILABLE) },
    reset() { throw new Error(STORAGE_UNAVAILABLE) },
  }
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
    onAutoStartChange: options.loginRegistration,
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
  let settingsQueue: Promise<unknown> = Promise.resolve()
  return {
    ...control,
    async execute(request: LauncherControlRequest): Promise<unknown> {
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
      if (request?.command === 'storage.reset') return storage.reset()
      return control.execute(request)
    },
  }
}
