import { app, BrowserWindow, dialog, ipcMain, net, Notification, safeStorage, shell } from 'electron'
import { mkdirSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLauncherControl } from './launcher-control'
import { createLauncherControlServer } from './launcher-control-server'
import { createUninstallService } from './uninstall'
import { registerUninstallIpc } from './uninstall-ipc'
import type { UninstallPlanInput } from './uninstall-plan'
import { fileURLToPath } from 'node:url'
import type { AppSettings, OfficialPackRelease, OfficialPackStatus, PackInstallResult, RuntimeOutput, WindowMode } from '../src/types'
import { ACP_RUNTIME_DIRNAME, CREDENTIALS_LOCK_DIRNAME, createAiInstaller, healCredentialsLock, type AiInstaller } from './ai-install'
import { registerAppearanceProtocol, registerAppearanceScheme } from './appearance-protocol'
import { registerBackupsIpc } from './backups-ipc'
import { registerPathMigrationIpc } from './path-migration-ipc'
import { registerPendingResumesIpc } from './pending-resume-ipc'
import { readRunningSessions } from './pending-resume'
import { createIdleShutdownService, type IdleShutdownService } from './idle-shutdown'
import { registerIdleShutdownIpc } from './idle-shutdown-ipc'
import { registerLauncherPluginsIpc } from './launcher-plugins-ipc'
import { createWorkspaceSkillsService } from './workspace-skills'
import { registerWorkspaceSkillsIpc } from './workspace-skills-ipc'
import { createApplicationAddonManager, type ApplicationAddonManager } from './application-addons'
import { applyWindowMode, createMainWindow, createRendererChannel } from './app-window'
import { createCatalogSyncService, type CatalogSyncService } from './catalog-sync'
import { createCopilotSessionManager, type CopilotSessionManager } from './copilot-sessions'
import { createDshMarketService, type DshMarketService } from './dsh-market'
import { createDesktopPluginsService, type DesktopPluginsService } from './desktop-plugins'
import { runCommand } from './command'
import { readDeepSeekApiKey } from './credentials'
import { resolveAgentApiForModel, resolveCopilotAgentApi } from './copilot-api'
import { findInstalledDsh } from './dsh-install'
import { compareVersions } from './dsh-release'
import { waitForBootMarker, writeBootMarker } from './elevation-handshake'
import { buildPluginCommandArgs, createInstaller, syncProfilePnpmConfig, validateLocalPluginDirectory, type Installer } from './installer'
import { registerIpcHandlers } from './ipc'
import { createLauncherUpdater, type LauncherUpdater } from './launcher-update'
import { loginItemSettings, syncLaunchAtLogin } from './login-item'
import { isProcessElevated } from './process-elevation'
import {
  buildElevatedRelaunchArgs,
  isElevatedRelaunchFlag,
  orchestrateElevationRelaunch,
  relaunchElevated,
  shouldRelaunchElevated,
} from './startup-elevation'
import { createGitHubAuthService, type GitHubAuthService } from './github-auth'
import { buildNetworkEnvironment, npmRegistryCandidates, refreshWindowsSystemProxy } from './proxy'
import {
  ensureNodeRuntime,
  ensurePnpmRuntime,
  findSystemNodeRuntime,
  resolveNodeExecutable,
  type NodeRuntime,
  type NodeRuntimeProgress,
  type PnpmRuntime,
} from './node-runtime'
import { createProxyAwareFetch } from './network'
import { packUsesOfficeCliSkills, resolveOfficeCliExecutable } from './officecli-tool'
import { ensureOfficialPackVersion, listOfficialPackVersions, type OfficialPackListDeps } from './official-pack'
import { createPackManager, type InstallInstaller, type PackInstallTarget, type PackManager } from './pack'
import { migrateToPackHomesV2 } from './pack-migration'
import { readPackRegistry } from './pack-registry'
import { createPluginTrialManager, type PluginTrialManager } from './plugin-trial'
import { readPluginReceipts, recordPluginInstall } from './plugin-receipts'
import { approveAllIgnoredBuilds } from './plugin-install'
import { configureProcessTracker, shutdownTrackedProcesses, withExecutableDirectoryOnPath } from './process'
import { createProcessSupervisor, type ProcessSupervisor } from './process-supervisor'
import { readProfile, reorderPlugins, togglePlugin } from './profile'
import { createRecommendedWebUiService, type RecommendedWebUiService } from './recommended-web-ui'
import { consolidatePluginPool, createProfileService, ensureProfileWorkspaceConfig, migrateLegacyPacks, type ProfileService } from './profile-service'
import { installPresetFromDirectory } from './preset-install'
import { installSkillFromDirectory } from './skill-install'
import { createRendererEvents } from './renderer-events'
import { createRuntimeController, type RuntimeController } from './runtime'
import { createRuntimeVersionService, ensureDshVersionInstalled, findManagedDshVersions, type RuntimeVersionService } from './runtime-versions'
import { createSettingsStore, defaultSettings, type SettingsStore } from './settings'
import { createTray, type TrayController } from './tray'
import { recoverLegacyCredentials } from './dsh-credentials-compat'
import { createStorageController, LEGACY_DATA_DIRNAME, resolveStorage, STORAGE_BROWSER_DATA_DIRNAME, type StorageResolution } from './storage-root'
import { captureUiShots, uiShotDirectory } from './ui-shot'

/**
 * 应用入口与装配根。
 * 这里只负责「谁依赖谁」，具体行为都在各自的模块里。
 */

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
// 自定义协议必须在 app ready 之前登记（Electron 的硬性顺序要求）。
registerAppearanceScheme()
// 窗口图标与托盘图标共用同一资源；dev 取 public/，打包取 dist/。
const launcherIconPath = path.join(moduleDirectory, app.isPackaged ? '../dist/launcher-icon.png' : '../public/launcher-icon.png')

/**
 * 随包运行时的根目录（Node 与 pnpm）。当前**只有开发态生效**：
 * electron-builder 的 extraResources 会无条件剥掉 node_modules，而 npm 就住在
 * `vendor/node/node_modules/npm` 里，所以打包态没有可用的随包 Node（见
 * `usableRuntime()` 的 npm 存在性守卫与 scripts/fetch-node-runtime.mts 顶部说明）。
 * 发布版因此走：本机 Node（**版本达标才用**）→ 托管下载（镜像优先）→ 再用 npm 装 pnpm。
 * 「本机装了老 Node 就装不上」那个 bug 的修复点是那道版本门，不是随包本身。
 * 目录不存在时 ensureNodeRuntime / ensurePnpmRuntime 自己会退回托管路径，这里不做存在性判断。
 */
const bundledNodeRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'node')
  : path.resolve(moduleDirectory, '../vendor/node')

const bundledPnpmRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'pnpm')
  : path.resolve(moduleDirectory, '../vendor/pnpm')

/**
 * 数据目录：必须在 requestSingleInstanceLock() 之前定好。
 * 单实例锁、Chromium 的缓存目录和后面所有 path.join(userData, ...) 都取自
 * app.getPath('userData')，所以这里改一次，全项目的数据就一起搬过去。
 * 打包态默认落在 EXE 旁边的 launcher-data —— 同一台机器上放在不同文件夹的多份
 * 启动器因此各自 userData 不同，单实例锁与 packs.json 都不再互相干扰。
 */
const storageBootstrap = { isPackaged: app.isPackaged, execPath: process.execPath, env: process.env, appDataPath: app.getPath('appData') }

/** 把 userData/sessionData 指到数据目录；建不出目录就抛错，由调用方退回备用目录。 */
function applyStorageLocation(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(path.join(dataDir, STORAGE_BROWSER_DATA_DIRNAME), { recursive: true })
  app.setPath('userData', dataDir)
  // Chromium 的 Cache/GPUCache 单独收进子目录，launcher-data 顶层才一眼看得清哪份是数据。
  app.setPath('sessionData', path.join(dataDir, STORAGE_BROWSER_DATA_DIRNAME))
}

function installStorageLocation(): StorageResolution {
  try {
    const resolution = resolveStorage({ ...storageBootstrap, argv: process.argv })
    try {
      applyStorageLocation(resolution.dataDir)
      return resolution
    } catch (error) {
      // 数据目录写不进去（U 盘只读、杀软拦截……）不该让启动器起不来：退回开发态默认位置。
      const fallback = path.join(storageBootstrap.appDataPath, LEGACY_DATA_DIRNAME)
      console.error('[storage] 数据目录 ' + resolution.dataDir + ' 不可用，改用 ' + fallback + '。', error)
      applyStorageLocation(fallback)
      const reason = resolution.warning ? resolution.warning + ' ' : ''
      return { ...resolution, dataDir: fallback, source: 'development', warning: reason + '原数据目录 ' + resolution.dataDir + ' 不可用，本次运行改用 ' + fallback + '。' }
    }
  } catch (error) {
    console.error('[storage] 解析数据目录失败，继续使用 Electron 默认 userData。', error)
    return { dataDir: app.getPath('userData'), source: 'development', portableDir: null, pointerFile: null, warning: '数据目录解析失败，本次运行使用 Electron 的默认目录。' }
  }
}

const storageResolution = installStorageLocation()
const storageController = createStorageController({ resolution: storageResolution, appDataPath: storageBootstrap.appDataPath })

/** 重启启动器：丢掉会把新目录覆盖回去的 --data-dir / --user-data-dir；portable 版要重开 EXE 而不是解包出来的进程。 */
function relaunchLauncher(): void {
  app.relaunch({
    execPath: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    args: process.argv.slice(1).filter(argument => !argument.startsWith('--data-dir') && !argument.startsWith('--user-data-dir')),
  })
  app.exit(0)
}

let mainWindow: BrowserWindow | null = null
let processSupervisor: ProcessSupervisor | null = null
let quitCleanupStarted = false
let allowFinalQuit = false
// 关闭按钮只隐藏到托盘；before-quit 置位后放行真正的关闭。
let isQuitting = false
let tray: TrayController | null = null
let backgroundNoticeShown = false

const getWindow = (): BrowserWindow | null => mainWindow
const events = createRendererEvents(createRendererChannel(getWindow))

interface Services {
  packControl: ReturnType<typeof createLauncherControl>
  launcherControl: ReturnType<typeof createLauncherControl>['execute']
  /** 所有整合包都空闲后自动关机的状态机；IPC、CLI、设置保存都指向这一份。 */
  idleShutdown: IdleShutdownService
  settings: SettingsStore
  /** 启动器级 API 库（跨整合包共享）。 */
  apiLibrary: ReturnType<typeof createLauncherControl>['apiLibrary']
  /** 每个整合包从库里勾选启用了哪些 API。 */
  packApis: ReturnType<typeof createLauncherControl>['packApis']
  /** 立即应用「启动器随登录启动」开关。 */
  loginRegistration: (enabled: boolean) => void
  pluginReceiptsPath: string
  runtime: RuntimeController
  installer: Installer
  pluginTrial: PluginTrialManager
  aiInstaller: AiInstaller
  copilot: CopilotSessionManager
  packManager: PackManager
  launcherUpdater: LauncherUpdater
  githubAuth: GitHubAuthService
  applicationAddons: ApplicationAddonManager
  catalogSync: CatalogSyncService
  dshMarket: DshMarketService
  desktopPlugins: DesktopPluginsService
  recommendedWebUi: RecommendedWebUiService
  runtimeVersions: RuntimeVersionService
  profiles: ProfileService
  profilePoolReady: Promise<void>
  /** 手动恢复官方整合包（整合包页按钮）；失败抛错给渲染层。 */
  restoreOfficialPack: () => Promise<PackInstallResult>
  /** 列出 Release 上所有官方整合包版本（按版本降序）。 */
  listOfficialPackVersions: () => Promise<OfficialPackRelease[]>
  /** 卸载引擎与它的路径快照（dshHome 等设置读出来之后由 whenReady 填进去）。 */
  uninstall: ReturnType<typeof createUninstallService>
  uninstallPlan: UninstallPlanInput
  /** 官方整合包状态；`force` = 强制重新查 GitHub，否则用启动核对的缓存。 */
  readOfficialPackStatus: (force?: boolean) => Promise<OfficialPackStatus>
  /** 下载并导入指定版本的官方整合包；失败抛错给渲染层。 */
  installOfficialPackVersion: (version: string) => Promise<PackInstallResult>
  /** 启动核对：无官方包则自动装推荐版本，有更新则只通知不改动。 */
  officialPackBootstrap: () => Promise<void>
}

// app.getPath 依赖 app 就绪，因此服务在 whenReady 之后才装配。
let services: Services | null = null
let controlServer: { close(): Promise<void> } | null = null

/**
 * 设置存储的装配参数只写一次：提权判定要在服务装配之前读设置，两次共用同一个实例，
 * 才不会重复探测 Node 运行时，也不会出现两份互不相干的缓存（IPC 存的设置必须落在这一个上）。
 */
function createLauncherSettingsStore(userData: string): SettingsStore {
  const managedDshRoot = path.join(userData, 'dsh-runtime')
  return createSettingsStore({
    filePath: path.join(userData, 'settings.json'),
    createDefaults: () => defaultSettings({
      dshHomeFromEnvironment: process.env.DSH_HOME,
      homeDirectory: os.homedir(),
      documentsDirectory: app.getPath('documents'),
      systemNpx: findSystemNodeRuntime()?.npx,
      dshInstallPath: managedDshRoot,
    }),
    detectInstalledDsh: (settings: AppSettings) => findInstalledDsh({
      managedRoot: settings.dshInstallPath,
      configuredExecutable: settings.launchExecutable,
    }),
    // 整合包真隔离的咽喉点：read() 返回的 dshHome 即激活包的私有家目录（缺省 = 默认家目录）。
    resolvePackHome: async current => {
      if (!current.activePackId) return null
      const records = await readPackRegistry(path.join(userData, 'packs.json'))
      return records.find(record => record.id === current.activePackId)?.homePath ?? null
    },
  })
}

/** bootSettings = 提权判定之前就读好的那个实例，装配时直接接管，避免读两次设置。 */
function createServices(bootSettings?: SettingsStore): Services {
  const userData = app.getPath('userData')
  const managedDshRoot = path.join(userData, 'dsh-runtime')
  const managedNodeRoot = path.join(userData, 'node-runtime')
  const managedPnpmRoot = path.join(userData, 'pnpm-runtime')
  const pluginSourceRoot = path.join(userData, 'plugin-sources')
  const pluginReceiptsPath = path.join(userData, 'plugin-installs.json')
  const presetReceiptsPath = path.join(userData, 'preset-installs.json')
  const skillReceiptsPath = path.join(userData, 'skill-installs.json')
  const skillSourceRoot = path.join(userData, 'skill-sources')
  const applicationRoot = path.join(userData, 'application-addons')
  const packsJsonPath = path.join(userData, 'packs.json')
  const packsRoot = path.join(userData, 'dsh-packs')
  // 机器级外部工具（officecli 等）的托管根目录：跨整合包共享，不随快照进包。
  const officeCliToolsRoot = path.join(userData, 'dsh-tools')
  const proxyAwareFetch = createProxyAwareFetch((input, init) => net.fetch(input, init))
  const githubAuth = createGitHubAuthService({
    filePath: path.join(userData, 'github-auth.bin'),
    clientId: process.env.DSH_LAUNCHER_GITHUB_CLIENT_ID,
    fetchImpl: proxyAwareFetch,
    cipher: {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value),
    },
  })
  const catalogSync = createCatalogSyncService({
    fetchImpl: githubAuth.fetch,
    getAuthStatus: () => githubAuth.getStatus(),
    pendingDir: path.join(userData, 'catalog', 'pending'),
    onFlush: result => events.output('plugin', result.submitted > 0 ? 'success' : 'error', result.message),
  })

  let settings: SettingsStore

  /**
   * 准备 Node.js 运行环境，并把下载进度写进日志。
   * 进度每跨越 10% 记一条，避免刷屏。
   */
  const prepareNodeRuntime = (
    source: RuntimeOutput['channel'],
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ): Promise<NodeRuntime> => {
    let lastBucket = -1
    return settings.read().then(currentSettings => ensureNodeRuntime(managedNodeRoot, progress => {
      const bucket = Math.floor(progress.percent / 10)
      if (bucket !== lastBucket || progress.percent === 100) {
        lastBucket = bucket
        events.output(source, 'info', `${progress.message}（${progress.percent}%）`)
      }
      onProgress?.(progress)
    }, currentSettings.nodeVersion, (level, text) => events.output(source, level, text), {
      bundledRoot: bundledNodeRoot,
    }))
  }

  const preparePnpmRuntime = (
    source: RuntimeOutput['channel'],
    nodeRuntime: NodeRuntime,
    onProgress?: (progress: NodeRuntimeProgress) => void,
  ): Promise<PnpmRuntime> => {
    let lastBucket = -1
    // 镜像候选来自用户设置；只有没命中随包/已装、真要联网装 pnpm 时才会用到它。
    return settings.read().then(currentSettings => ensurePnpmRuntime(managedPnpmRoot, nodeRuntime, progress => {
      const bucket = Math.floor(progress.percent / 10)
      if (bucket !== lastBucket || progress.percent === 100) {
        lastBucket = bucket
        events.output(source, 'info', `${progress.message}（${progress.percent}%）`)
      }
      onProgress?.(progress)
    }, (level, text) => events.output(source, level, text), {
      bundledRoot: bundledPnpmRoot,
      registryCandidates: npmRegistryCandidates(buildNetworkEnvironment(currentSettings).npmRegistry),
    }))
  }

  /**
   * 启动前准备 officecli：包里有 officecli 技能才动；下载进度既写日志
   * （runtime 通道，由控制器输出）也进整合包活动横幅（packActivity，5% 分桶节流），
   * 结束（成功或失败）清空横幅。永不抛异常。
   */
  const prepareOfficeCliTool = async (
    current: AppSettings,
    onProgress: (received: number, total: number | null) => void,
  ): Promise<string | null> => {
    let bannerShown = false
    let lastPercent = -1
    try {
      if (!(await packUsesOfficeCliSkills(current.dshHome))) return null
      return await resolveOfficeCliExecutable(current.dshHome, officeCliToolsRoot, {
        mirror: current.network?.githubMirror,
        fetchImpl: proxyAwareFetch,
        onProgress: (received, total) => {
          onProgress(received, total)
          const percent = total && total > 0 ? Math.floor((received / total) * 100) : -1
          if (percent !== lastPercent) {
            lastPercent = percent
            bannerShown = true
            events.packProgress({ kind: 'status', message: `正在准备 Office 工具（首次约 33MB）${percent >= 0 ? `：${percent}%` : ''}…` })
          }
        },
      })
    } catch {
      return null
    } finally {
      if (bannerShown) events.packProgress({ kind: 'status', message: '' })
    }
  }

  settings = bootSettings ?? createLauncherSettingsStore(userData)

  let applicationAddons: ApplicationAddonManager
  let installer: Installer
  let packControl: ReturnType<typeof createLauncherControl> | null = null
  const runtime = createRuntimeController({
    readSettings: async () => { const value = await settings.read(); if (packControl?.hasRunningHome(value.dshHome)) throw new Error('This pack is already running through multi-pack controls'); return value },
    prepareNodeRuntime: () => prepareNodeRuntime('runtime'),
    fallbackWorkspace: () => app.getPath('documents'),
    emitOutput: (level, text) => events.output('runtime', level, text),
    emitState: state => events.runtimeState(state),
    openExternal: url => void shell.openExternal(url),
    resolveApplicationLaunchPlan: () => applicationAddons.launchPlan(),
    legacyCredentialsBackupRoot: path.join(userData, 'dsh-credentials-compat'),
    // 非法凭据引用名的原始备份。目录必须独立于上面那个：开机时的旧格式恢复会把
    // dsh-credentials-compat 里的记录逐条覆盖回目标文件，混在一起会把改名结果冲掉。
    credentialsRefRepairRoot: path.join(userData, 'dsh-credentials-ref-repair'),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    prepareOfficeCliTool,
  })
  const profileService = createProfileService({
    dshHome: () => settings.read().then(value => value.dshHome),
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    pluginReceiptsPath,
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    packBodiesRoot: () => settings.read().then(value => path.join(value.dshHome, '.dsh-launcher-pack-bodies')),
    isRuntimeRunning: () => runtime.isRunning() || (packControl?.isRunning() ?? false),
    fillMissingDependencies: async (profileName, missing) => {
      const current = await settings.read()
      const receipts = await readPluginReceipts(pluginReceiptsPath)
      const pluginStoreRoot = path.join(userData, 'plugin-store')
      const profileRoot = path.join(current.dshHome, 'profiles')
      const targetProfileDir = path.join(profileRoot, profileName)
      // A link-only repair must never auto-install DSH peer packages from npm.
      // Normalize legacy/imported Profiles before invoking pnpm so unpublished
      // preview peers remain supplied by the selected DSH runtime.
      await ensureProfileWorkspaceConfig(targetProfileDir)

      // Legacy/imported Profiles can contain only `*` dependency ranges even
      // though another Profile already has the exact local source. Reuse that
      // source before asking pnpm for offline registry metadata; this preserves
      // one physical plugin body while keeping each Profile's link layer and
      // activation order independent.
      const sourceSpecs = new Map<string, string>()
      const siblingEntries = await readdir(profileRoot, { withFileTypes: true }).catch(() => [])
      for (const sibling of siblingEntries) {
        if (!sibling.isDirectory() || sibling.name === profileName) continue
        const siblingManifestPath = path.join(profileRoot, sibling.name, 'package.json')
        let siblingManifest: { dependencies?: Record<string, unknown> } | null = null
        try {
          siblingManifest = JSON.parse(await readFile(siblingManifestPath, 'utf8')) as { dependencies?: Record<string, unknown> }
        } catch {
          continue
        }
        for (const packageName of missing) {
          if (sourceSpecs.has(packageName)) continue
          const candidate = siblingManifest.dependencies?.[packageName]
          if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.trim() === '*') continue
          if (candidate.startsWith('file:')) {
            const rawPath = candidate.slice('file:'.length)
            const sourcePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(path.dirname(siblingManifestPath), rawPath)
            try {
              const sourceManifest = JSON.parse(await readFile(path.join(sourcePath, 'package.json'), 'utf8')) as { version?: unknown }
              const version = typeof sourceManifest.version === 'string' && sourceManifest.version.trim()
                ? sourceManifest.version.trim().replace(/[^0-9A-Za-z._+-]/g, '_')
                : 'local'
              const sharedSource = path.join(current.dshHome, '.dsh-launcher-plugin-bodies', ...packageName.split('/'), version)
              if (path.resolve(sourcePath) !== path.resolve(sharedSource)) {
                await mkdir(path.dirname(sharedSource), { recursive: true })
                try {
                  await readFile(path.join(sharedSource, 'package.json'), 'utf8')
                } catch {
                  await cp(sourcePath, sharedSource, { recursive: true })
                }
              }
              sourceSpecs.set(packageName, `file:${sharedSource}`)
            } catch {
              // Stale file references are not reusable sources.
            }
          } else if (/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.trim())) {
            sourceSpecs.set(packageName, candidate.trim())
          }
        }
      }

      if (sourceSpecs.size > 0) {
        const targetManifestPath = path.join(targetProfileDir, 'package.json')
        try {
          const targetManifest = JSON.parse(await readFile(targetManifestPath, 'utf8')) as { dependencies?: Record<string, string> }
          const dependencies = { ...(targetManifest.dependencies ?? {}) }
          const repaired: string[] = []
          for (const packageName of missing) {
            const currentSpec = dependencies[packageName]
            const sourceSpec = sourceSpecs.get(packageName)
            if (!sourceSpec || (currentSpec && currentSpec !== '*' && !/[<>=*^~]/.test(currentSpec))) continue
            dependencies[packageName] = sourceSpec
            repaired.push(`${packageName} → ${sourceSpec}`)
          }
          if (repaired.length > 0) {
            await writeFile(targetManifestPath, `${JSON.stringify({ ...targetManifest, dependencies }, null, 2)}\n`, 'utf8')
            events.output('plugin', 'info', `已从其他整合包复用 ${repaired.length} 个插件来源：${repaired.join('、')}`)
          }
        } catch {
          // The subsequent pnpm command reports a precise manifest error.
        }
      }

      let offlineNode: NodeRuntime | null = null
      let offlinePnpm: PnpmRuntime | null = null
      let offlineInstallAttempted = false
      for (const packageName of missing) {
        const receipt = receipts.find(item => item.packId === profileName && item.packageName === packageName)
        if (!receipt) {
          // A cloned/imported Profile may have no launcher receipt while its
          // exact package is already present in the shared pnpm store. Try an
          // offline link-only install before asking the user to source it.
          if (!offlineInstallAttempted) {
            offlineInstallAttempted = true
            offlineNode ??= await prepareNodeRuntime('plugin')
            offlinePnpm ??= await preparePnpmRuntime('plugin', offlineNode)
            await syncProfilePnpmConfig(targetProfileDir, buildNetworkEnvironment(current).npmRegistry, pluginStoreRoot)
            const result = await runCommand(offlinePnpm.executable, ['install', '--dir', targetProfileDir, '--offline', '--no-frozen-lockfile', '--config.auto-install-peers=false', '--store-dir', pluginStoreRoot], {
              cwd: targetProfileDir,
              env: withExecutableDirectoryOnPath(offlinePnpm.executable, withExecutableDirectoryOnPath(offlineNode.node, {
                ...process.env,
                DSH_HOME: current.dshHome,
                npm_config_store_dir: pluginStoreRoot,
                NPM_CONFIG_STORE_DIR: pluginStoreRoot,
                pnpm_config_store_dir: pluginStoreRoot,
                PNPM_CONFIG_STORE_DIR: pluginStoreRoot,
                CI: 'true',
              })),
              onOutput: (text, level) => events.output('plugin', level, text),
            })
            if (result.exitCode !== 0) throw new Error(`插件「${packageName}」无法从共享插件池补齐，请检查来源记录。`)
          }
          continue
        }
        const repository = receipt.repository.match(/^(?:https?:\/\/github\.com\/|github:)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/i)?.[1]
        if (receipt.source === 'npm') {
          await installer.installNpmPackage({ packageName, version: receipt.version ?? undefined }, profileName)
        } else if (repository) {
          await installer.installPluginTarget({
            repository,
            defaultBranch: receipt.defaultBranch ?? 'main',
            targetId: receipt.targetId ?? `${packageName}:.`,
            ...(receipt.commit ? { commit: receipt.commit } : {}),
          }, profileName)
        } else {
          throw new Error(`插件「${packageName}」的来源记录无效，无法自动补齐。`)
        }
      }
      // Keep the selected DSH home/profile invariant explicit for future
      // installers that consult settings while repairing links.
      if (current.dshHome !== (await settings.read()).dshHome) throw new Error('DSH_HOME 在补齐依赖期间发生变化。')
    },
  })

  /** 整合包导入期间补装 DSH 运行时：把安装进度接力到整合包页的进度条（见上面的 emitProgress）。 */
  let relayDshProgressToPack = false

  const runtimeVersions = createRuntimeVersionService({
    dshRoot: managedDshRoot,
    nodeRoot: managedNodeRoot,
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    isRuntimeRunning: () => runtime.isRunning() || (packControl?.isRunning() ?? false),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => {
      events.installProgress(progress)
      // 整合包导入过程中会先补装缺失的 DSH 运行时（约 100MB），那段时间整合包页只有一条死进度条；
      // 把这一段并进 packProgress，用户在包页也能看到「正在准备 DSH x.y.z · 45%」。
      if (relayDshProgressToPack && progress.kind === 'dsh') {
        events.packProgress({ kind: 'stage', label: progress.message, percent: progress.percent })
      }
    },
    githubFetch: githubAuth.fetch,
    // 装一个 DSH 版本只下载版本本体；整合包仅由「新建 / 导入」产生。
  })

  applicationAddons = createApplicationAddonManager({
    registryPath: path.join(userData, 'application-addons.json'),
    installRoot: applicationRoot,
    readSettings: () => settings.read(),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => events.installProgress(progress),
    isRuntimeRunning: () => runtime.isRunning() || (packControl?.isRunning() ?? false),
    githubFetch: githubAuth.fetch,
    packageStoreRoot: path.join(userData, 'plugin-store'),
  })

  installer = createInstaller({
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    prepareNodeRuntime: onProgress => prepareNodeRuntime('plugin', onProgress),
    preparePnpmRuntime: (nodeRuntime, onProgress) => preparePnpmRuntime('plugin', nodeRuntime, onProgress),
    pluginSourceRoot,
    pluginReceiptsPath,
    packageStoreRoot: path.join(userData, 'plugin-store'),
    presetReceiptsPath,
    skillReceiptsPath,
    skillSourceRoot,
    skillMarketCachePath: path.join(userData, 'skill-market-cache.json'),
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitProgress: progress => events.installProgress(progress),
    isRuntimeRunning: () => runtime.isRunning() || (packControl?.isRunning() ?? false),
    githubFetch: githubAuth.fetch,
  })

  // 官方推荐整合包（DSH Web UI 全家桶）：用 installer 装 latest，
  // 避免依赖市场目录与 git 子路径回退。
  const recommendedWebUi = createRecommendedWebUiService({
    readSettings: () => settings.read(),
    installer,
  })

  // This service deliberately does not use the unified resource-market
  // analyzers or installers. It mirrors dsh-market's curated registry and
  // package command rules behind a separate API surface.
  const dshMarket = createDshMarketService({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('plugin'),
    preparePnpmRuntime: node => preparePnpmRuntime('plugin', node),
    fetchImpl: githubAuth.fetch,
    packageStoreRoot: path.join(userData, 'plugin-store'),
    cachePath: path.join(userData, 'dsh-market-cache.json'),
    emitProgress: progress => events.dshMarketProgress(progress),
    emitOutput: (level, text) => events.output('plugin', level, text),
  })

  // 官方桌面端的插件管理：独立一条链路，走它自带的 dsh 命令，不碰 installer/dsh-market
  // 那套（那些会往 profile 里写 store-dir 与我们的收据）。家目录用未派生的 readStored，
  // 因为桌面端永远住在默认家目录，不跟着激活包漂移。
  const desktopPlugins = createDesktopPluginsService({
    readStoredSettings: () => settings.readStored(),
    emitOutput: (level, text) => events.output('plugin', level, text),
    journalRoot: path.join(userData, 'desktop-mirror-backups'),
  })

  const pluginTrial = createPluginTrialManager({
    readSettings: () => settings.read(),
    prepareNodeRuntime: () => prepareNodeRuntime('plugin'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('plugin', nodeRuntime),
    trialRoot: path.join(userData, 'plugin-trials'),
    resultsPath: path.join(userData, 'plugin-trial-results.json'),
    emitOutput: (level, text) => events.output('test', level, text),
    emitResult: result => events.pluginTrial(result),
    isRuntimeRunning: () => runtime.isRunning() || (packControl?.isRunning() ?? false),
    isInstallerBusy: () => installer.isBusy(),
  })

  let packManager: PackManager | null = null
  const copilot = createCopilotSessionManager({
    filePath: path.join(userData, 'copilot-sessions.json'),
    runtimeRoot: path.join(userData, ACP_RUNTIME_DIRNAME),
    snapshotRoot: path.join(userData, 'ai-snapshots'),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    readSettings: () => settings.read(),
    readApiKey: dshHome => readDeepSeekApiKey(dshHome),
    resolveAgentApi: dshHome => resolveCopilotAgentApi(dshHome),
    resolveAgentApiForModel: (dshHome, provider, model) => resolveAgentApiForModel(dshHome, provider, model),
    prepareNodeRuntime: () => prepareNodeRuntime('ai'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('ai', nodeRuntime),
    emitEvent: event => events.aiSessionEvent(event),
    emitOutput: (level, text) => events.output('ai', level, text),
    mutationBlockReason: () => {
      if (runtime.isRunning()) return '请先停止 DSH 运行时'
      if (installer.isBusy()) return '资源安装正在进行'
      if (pluginTrial.isBusy()) return '插件试运行正在进行'
      if (applicationAddons.isBusy()) return '应用加载项操作正在进行'
      if (dshMarket.isBusy()) return 'DSH Market 操作正在进行'
      if (desktopPlugins.isBusy()) return '官方桌面端插件操作正在进行'
      if (packManager?.isBusy()) return '整合包操作正在进行'
      return null
    },
  })

  const aiInstaller = createAiInstaller({
    readSettings: () => settings.read(),
    packageStoreRoot: path.join(userData, 'plugin-store'),
    prepareNodeRuntime: () => prepareNodeRuntime('ai'),
    preparePnpmRuntime: nodeRuntime => preparePnpmRuntime('ai', nodeRuntime),
    acpRuntimeRoot: path.join(userData, ACP_RUNTIME_DIRNAME),
    snapshotRoot: path.join(userData, 'ai-snapshots'),
    emitOutput: (level, text) => events.output('ai', level, text),
    emitEvent: event => {
      events.aiInstallEvent(event)
      void copilot.updateLegacy(event)
    },
    isRuntimeRunning: () => runtime.isRunning() || (packControl?.isRunning() ?? false),
    isInstallerBusy: () => installer.isBusy(),
    analyzePlugin: (repository, defaultBranch) => installer.analyzePlugin(repository, defaultBranch),
    readApiKey: dshHome => readDeepSeekApiKey(dshHome),
    githubFetch: githubAuth.fetch,
  })

  /**
   * 整合包离线导入（zip 内的 plugin-bodies）用 `file:` specifier 安装。
   * 真实 installer 的 installPluginTarget 只接受 GitHub 仓库分析，无法直接
   * 安装本地目录，因此这里在组装层用 DSH CLI 插件命令补上最小通路。
   */
  async function installPackLocalDirectory(target: PackInstallTarget): Promise<void> {
    const originalDirectory = validateLocalPluginDirectory(target.localDirectory)
    // Windows 下 pnpm 的 `file:` spec 无法解析含空格/非 ASCII 的路径（spec 会在空格处被
    // 截断，pnpm 报 ERR_PNPM_SPEC_NOT_SUPPORTED_BY_ANY_RESOLVER）。用户主目录常含空格
    // （如 C:\Users\Miyazawa i\…），因此先把本体复制到盘根的无空格 staging 目录再安装；
    // pnpm 会把内容硬链接进其 store，staging 装完即删，不影响已安装插件。
    const needsStaging = process.platform === 'win32' && /[\s\u00A0]/.test(originalDirectory)
    const installDirectory = needsStaging ? await stageBodyForPnpm(originalDirectory) : originalDirectory
    const current = await settings.read()
    const nodeRuntime = await prepareNodeRuntime('plugin')
    const pnpmRuntime = await preparePnpmRuntime('plugin', nodeRuntime)
    const executable = resolveNodeExecutable(current.launchExecutable, nodeRuntime)
    const commandArgs = buildPluginCommandArgs(current, executable, ['add', `file:${installDirectory.replace(/\\/g, '/')}`], target.profileName)
    const environment = withExecutableDirectoryOnPath(
      pnpmRuntime.executable,
      withExecutableDirectoryOnPath(nodeRuntime.node, {
        ...process.env,
        DSH_HOME: current.dshHome,
        // CI 模式让 pnpm 用 append-only reporter：无 TTY 时也实时输出解析/下载进度行，
        // 否则导入对话框的日志区在拉取依赖的几分钟里看起来像卡死。
        CI: 'true',
        npm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
        NPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
        pnpm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
        PNPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
        FORCE_COLOR: '0',
      }),
    )
    const onOutput = (text: string, level: string) => events.output('plugin', level as 'error' | 'info' | 'success', text)
    // pnpm 的输出走插件日志通道，导入对话框看不到；这里把关键进度行节流转发进
    // packProgress 流，让对话框日志区在拉取依赖的几分钟里持续有新内容。
    let lastRelayAt = 0
    const relayToDialog = (line: string) => {
      const now = Date.now()
      if (now - lastRelayAt < 4000) return
      lastRelayAt = now
      const trimmed = line.trim().slice(0, 160)
      if (trimmed) events.packProgress({ kind: 'status', message: trimmed })
    }
    const onInstallOutput = (text: string, level: string) => {
      onOutput(text, level)
      for (const line of text.split(/\r?\n/)) {
        if (line.includes('Progress:') || line.includes('Done in') || line.includes('ERR_PNPM')) relayToDialog(line)
      }
    }
    const runAdd = () => runCommand(executable, commandArgs, {
      cwd: current.workspace,
      env: environment,
      onOutput: onInstallOutput,
    })
    try {
      events.packProgress({ kind: 'status', message: '离线本体安装：该包未内置依赖，正在联网拉取（约几分钟）。用新版启动器重新导出，即可把依赖打进包内实现免联网安装。' })
      let result = await runAdd()
      // pnpm 默认拒绝依赖里的构建脚本（cloudflared/node-pty 等）并以非零码退出。
      // 与官方安装链路一致：批准被忽略的构建后自动重试一次。
      if (result.exitCode !== 0 && result.output.includes('ERR_PNPM_IGNORED_BUILDS')) {
        const workspacePath = path.join(current.dshHome, 'profiles', target.profileName, 'pnpm-workspace.yaml')
        const approved = await approveAllIgnoredBuilds(workspacePath, result.output)
        if (approved.length > 0) {
          onOutput(`已允许 ${approved.length} 个被忽略的构建脚本，正在自动重试。`, 'info')
          result = await runAdd()
        }
      }
      if (result.exitCode !== 0) throw new Error(`插件安装失败（代码 ${result.exitCode}），请查看运行日志。`)
    } finally {
      // staging 目录用完即删（成功或失败都清），避免在盘根留垃圾。
      if (installDirectory !== originalDirectory) {
        await rm(installDirectory, { recursive: true, force: true }).catch(() => undefined)
      }
    }
    let version: string | null = null
    try {
      const packageManifest = JSON.parse(await readFile(path.join(originalDirectory, 'package.json'), 'utf8')) as { version?: unknown }
      version = typeof packageManifest.version === 'string' ? packageManifest.version : null
    } catch {
      // 版本读取失败可忽略，receipt 的 version 允许为 null。
    }
    await recordPluginInstall(pluginReceiptsPath, {
      repository: `file:${originalDirectory}`,
      packageName: target.packageName,
      packId: target.profileName,
      source: 'local-directory',
      subdirectory: null,
      version,
      commit: '',
      installedAt: new Date().toISOString(),
    })
  }

  /** 在系统盘根的无空格目录下建唯一 staging 目录，把离线本体复制进去，返回其路径。 */
  async function stageBodyForPnpm(sourceDirectory: string): Promise<string> {
    const systemRoot = path.parse(process.env.windir ?? 'C:\\Windows').root || 'C:\\'
    const stagingRoot = path.join(systemRoot, 'dsh-import-bodies')
    await mkdir(stagingRoot, { recursive: true })
    const destination = await mkdtemp(path.join(stagingRoot, 'body-'))
    await cp(sourceDirectory, destination, { recursive: true })
    return destination
  }

  const packInstaller: InstallInstaller = {
    async installPluginTarget(target) {
      if (target.source === 'local-directory') {
        await installPackLocalDirectory(target)
        return
      }
      if (!target.repository) throw new Error('缺少来源仓库，无法安装。')
      // 真实 installer 按 analysis.targets 的 id 定位，id 形如 `<packageName>:<subdir|.>`。
      const targetId = target.subdirectory ? `${target.packageName}:${target.subdirectory}` : `${target.packageName}:.`
      const request: {
        repository: string
        defaultBranch: string
        targetId: string
        commit?: string
        version?: string
      } = { repository: target.repository, defaultBranch: 'main', targetId }
      // 转发整合包声明的 pin：github 用固定 commit，npm 用固定 version（0.0.0 是占位符，不转发）。
      if (target.source === 'github' && target.commit) request.commit = target.commit
      if (target.source === 'npm' && target.version && target.version !== '0.0.0') request.version = target.version
      await installer.installPluginTarget(request, target.profileName)
    },
    installNpmPackage: (request, profileOverride) => installer.installNpmPackage(request, profileOverride),
    remove: (packageName, profileName) => installer.remove(packageName, profileName),
    readProfile: (dshHome, profileName) => readProfile(dshHome, profileName, pluginReceiptsPath),
    togglePlugin: (dshHome, profileName, packageName, enabled) => togglePlugin(dshHome, profileName, packageName, enabled, pluginReceiptsPath),
    reorderPlugins: (dshHome, profileName, packageNames) => reorderPlugins(dshHome, profileName, packageNames, pluginReceiptsPath),
    // raw 整合包导入的技能：从本地 staging 目录全局安装（bundle 目录或 flat 单文件）。
    installSkillLocal: (dshHome, skill) => installSkillFromDirectory(dshHome, skill.name, skill.format, skill.sourceDir),
    installSkill: request => installer.installSkill(request),
    installSkillPinned: request => installer.installSkillPinned(request),
    toggleSkill: (name, enabled) => installer.toggleSkill(name, enabled),
    installPreset: request => installer.installPreset(request),
    installPresetLocal: (dshHome, preset) => installPresetFromDirectory(dshHome, preset.name, preset.sourceDir),
    togglePreset: (name, enabled) => installer.togglePreset(name, enabled),
  }

  packManager = createPackManager({
    isPackRunning: id => packControl?.isPackRunning(id) ?? false,
    beforeRemovePack: async id => { await packControl?.assertPackRemovable(id) },
    afterRemovePack: async id => { await packControl?.forgetPack(id) },
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    registryPath: packsJsonPath,
    manifestRoot: path.join(userData, 'pack-manifests'),
    snapshotRoot: path.join(userData, 'pack-snapshots'),
    pluginReceiptsPath,
    presetReceiptsPath,
    skillReceiptsPath,
    installer: packInstaller,
    applicationAddons,
    emitOutput: (level, text) => events.output('plugin', level, text),
    emitEvent: event => events.packProgress(event),
    isRuntimeRunning: () => runtime.isRunning() || (packControl?.isRunning() ?? false),
    isInstallerBusy: () => installer.isBusy(),
    unifiedProfiles: true,
    packsRoot,
    readStoredSettings: () => settings.readStored(),
    ensureDshVersionInstalled: async version => {
      const current = await settings.read()
      const installed = await findManagedDshVersions(current.dshInstallPath)
      if (installed.some(item => item.version === version)) return
      // 导入过程中补装运行时：先给一条明确的阶段提示，再把安装进度接力到整合包页。
      events.packProgress({ kind: 'stage', label: `正在准备 DSH ${version}（本机未安装，需要先下载运行时）`, percent: null })
      relayDshProgressToPack = true
      try {
        await ensureDshVersionInstalled(installed, next => runtimeVersions.installDsh(next), version)
      } catch (error) {
        // 补装失败就根本不会走到导入，也就没有后续事件来收掉上面那条阶段横幅；自己收口。
        events.packProgress({ kind: 'status', message: '' })
        throw error
      } finally {
        relayDshProgressToPack = false
      }
    },
    selectDshVersion: async version => {
      await runtimeVersions.selectDsh(version)
    },
    getNodeExecutable: async () => {
      try {
        return (await prepareNodeRuntime('plugin')).node
      } catch {
        return null
      }
    },
    offlinePackInstall: async ({ tarballDir, profileDir, onOutput }) => {
      const current = await settings.read()
      const nodeRuntime = await prepareNodeRuntime('plugin')
      const pnpmRuntime = await preparePnpmRuntime('plugin', nodeRuntime)
      const environment = withExecutableDirectoryOnPath(
        pnpmRuntime.executable,
        withExecutableDirectoryOnPath(nodeRuntime.node, {
          ...process.env,
          DSH_HOME: current.dshHome,
          npm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
          NPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
          pnpm_config_store_dir: path.join(app.getPath('userData'), 'plugin-store'),
          PNPM_CONFIG_STORE_DIR: path.join(app.getPath('userData'), 'plugin-store'),
          CI: 'true',
          FORCE_COLOR: '0',
        }),
      )
      const entries = (await readdir(tarballDir)).filter(file => file.endsWith('.tgz')).sort()
      if (entries.length === 0) throw new Error('离线包内没有依赖 tarball。')
      for (let index = 0; index < entries.length; index += 40) {
        const batch = entries.slice(index, index + 40).map(file => path.join(tarballDir, file).replace(/\\/g, '/'))
        const result = await runCommand(pnpmRuntime.executable, ['store', 'add', ...batch], {
          cwd: profileDir,
          env: environment,
          onOutput: (text, level) => onOutput(text),
        })
        if (result.exitCode !== 0) throw new Error(`离线依赖入库失败（代码 ${result.exitCode}）`)
      }
      // prefer-offline：store 里有的直接用，个别缺失的包联网补齐（比 --offline 全有全无更稳）。
      const install = await runCommand(pnpmRuntime.executable, ['install', '--prefer-offline'], {
        cwd: profileDir,
        env: environment,
        onOutput: (text, level) => onOutput(text),
      })
      if (install.exitCode !== 0) throw new Error(`离线安装失败（代码 ${install.exitCode}）`)
    },
  })

  /**
   * 官方默认整合包：列版本 / 读状态 / 按版本下载导入共用一份状态缓存
   * （启动核对也写它，渲染层随后读到的就是同一结果）。
   * 进度走 packProgress status 事件（整合包页横幅），导入成功广播 done 让渲染层刷新列表。
   */
  let officialStatusCache: OfficialPackStatus | null = null
  /** 进行中的核对：启动核对与渲染层同时要状态时合流成一次 GitHub 查询。 */
  let officialCheckInFlight: Promise<OfficialPackStatus> | null = null

  const officialListDeps = async (): Promise<OfficialPackListDeps> => {
    const current = await settings.read()
    return { fetchImpl: proxyAwareFetch, mirror: current.network?.githubMirror }
  }

  const readInstalledOfficialVersions = async (): Promise<string[]> => {
    const records = await readPackRegistry(packsJsonPath)
    const versions = new Set<string>()
    for (const record of records) {
      const version = record.officialVersion?.trim()
      if (version) versions.add(version)
    }
    // 版本号降序：第一项即本机最新的官方包。
    return [...versions].sort((left, right) => compareVersions(right, left))
  }

  const resolveOfficialPackStatus = async (force: boolean): Promise<OfficialPackStatus> => {
    if (!force && officialStatusCache) return officialStatusCache
    if (officialCheckInFlight) return officialCheckInFlight
    officialCheckInFlight = (async () => {
      const installedVersions = await readInstalledOfficialVersions()
      try {
        const releases = await listOfficialPackVersions(await officialListDeps())
        const recommended = releases[0]?.version ?? null
        const newestInstalled = installedVersions[0] ?? null
        officialStatusCache = {
          recommended,
          installedVersions,
          updateAvailable: Boolean(recommended && newestInstalled && compareVersions(newestInstalled, recommended) > 0),
          error: null,
          checkedAt: new Date().toISOString(),
        }
      } catch (error) {
        officialStatusCache = {
          recommended: null,
          installedVersions,
          updateAvailable: false,
          error: error instanceof Error ? error.message : String(error),
          checkedAt: new Date().toISOString(),
        }
      }
      return officialStatusCache
    })()
    try {
      return await officialCheckInFlight
    } finally {
      officialCheckInFlight = null
    }
  }

  /**
   * 下载并导入指定版本的官方整合包；`version` 缺省时用推荐版本（Release 里最新）。
   * `announce` = 用户主动触发：失败要抛错给界面；否则只记日志，不打扰启动。
   */
  const runOfficialPack = async (announce: boolean, version?: string): Promise<PackInstallResult | null> => {
    let target = version?.trim() ?? ''
    if (!target) {
      const status = await resolveOfficialPackStatus(true)
      if (!status.recommended) {
        if (announce) throw new Error(status.error ?? '没有可用的官方整合包版本。')
        if (status.error) events.output('plugin', 'error', `官方整合包版本核对失败：${status.error}`)
        return null
      }
      target = status.recommended
    }

    // 下载进度：250ms 节流（进度条够顺滑又不刷爆 IPC），速度用指数滑动平均抹平抖动，
    // 换源时速度重新起算（source 变了就丢弃旧速度，否则镜像的快速率会被直连的慢速率拖着）。
    let lastProgressAt = 0
    let lastReceived = 0
    let lastReceivedAt = Date.now()
    let smoothedSpeed = 0
    let lastSource = ''
    let announcedDownloadDone = false
    const outcome = await ensureOfficialPackVersion({
      registryPath: packsJsonPath,
      importPack: (filePath, items, options) => packManager!.importPack(filePath, items, options),
      fetchImpl: proxyAwareFetch,
      mirror: (await settings.read()).network?.githubMirror,
      downloadDir: path.join(userData, 'pack-snapshots'),
      onProgress: ({ received, total, source }) => {
        const now = Date.now()
        const finished = total != null && total > 0 && received >= total
        if (source !== lastSource) {
          lastSource = source
          smoothedSpeed = 0
          lastReceived = received
          lastReceivedAt = now
        }
        const elapsed = (now - lastReceivedAt) / 1000
        if (elapsed >= 0.5) {
          const instant = (received - lastReceived) / elapsed
          smoothedSpeed = smoothedSpeed > 0 ? smoothedSpeed * 0.6 + instant * 0.4 : instant
          lastReceived = received
          lastReceivedAt = now
        }
        if (now - lastProgressAt < 250 && !finished) return
        lastProgressAt = now
        events.packProgress({
          kind: 'download',
          label: `官方整合包 ${target}`,
          received,
          total: total && total > 0 ? total : null,
          speed: smoothedSpeed > 0 ? smoothedSpeed : null,
          source,
        })
        // 下载完成到真正导入完成之间还有写盘、解压、补装 DSH 运行时，几十秒到几分钟；
        // 这里立刻交棒给阶段提示，别让进度条停在 100% 一动不动。
        if (finished && !announcedDownloadDone) {
          announcedDownloadDone = true
          events.packProgress({ kind: 'stage', label: '下载完成，正在写入并解压整合包…', percent: null })
        }
      },
    }, target).catch((error: unknown) => {
      // 下载或导入中途失败时，后面的收口语句根本走不到，下载条/阶段横幅会一直挂在界面上。
      events.packProgress({ kind: 'status', message: '' })
      throw error
    })
    events.packProgress({ kind: 'status', message: '' })
    if (outcome.outcome === 'imported' && outcome.result) {
      officialStatusCache = null
      if (outcome.source) events.output('plugin', 'info', `官方整合包 ${target} 已下载（来源：${outcome.source}）。`)
      events.packProgress({ kind: 'done', result: outcome.result })
      return outcome.result
    }
    if (announce) {
      if (outcome.outcome === 'present') throw new Error(`官方整合包 ${target} 已存在。`)
      throw new Error(outcome.message ?? `官方整合包 ${target} 获取失败。`)
    }
    if (outcome.outcome === 'failed') {
      events.output('plugin', 'error', `官方整合包自动获取失败：${outcome.message ?? '未知原因'}`)
    }
    return null
  }

  const restoreOfficialPack = async (): Promise<PackInstallResult> => {
    const result = await runOfficialPack(true)
    if (!result) throw new Error('官方整合包获取失败。')
    return result
  }

  const installOfficialPackVersion = async (version: string): Promise<PackInstallResult> => {
    const result = await runOfficialPack(true, version)
    if (!result) throw new Error(`官方整合包 ${version} 获取失败。`)
    return result
  }

  /**
   * 启动核对：**首启不自动安装官方整合包**，只解析状态并广播给渲染层，让「有新版本」提示继续工作。
   * 是否安装由用户在整合包页手动触发（restoreOfficialPack / installOfficialPackVersion）。
   */
  const officialPackBootstrap = async () => {
    try {
      await resolveOfficialPackStatus(true)
      events.officialPackStatus(await resolveOfficialPackStatus(false))
    } catch (error) {
      events.output('plugin', 'error', `官方整合包自动获取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const launcherUpdater = createLauncherUpdater({
    getVersion: () => app.getVersion(),
    userDataPath: userData,
    githubFetch: githubAuth.fetch,
    emitProgress: progress => events.launcherUpdateProgress(progress),
  })

  // 启动自愈：上次 AI 会话若在凭据锁期间崩溃（进程被杀、finally 未跑），
  // .credentials.yaml 会滞留在锁目录，这里把它还原回 dshHome。
  void settings
    .read()
    .then(current => healCredentialsLock(current.dshHome, path.join(userData, CREDENTIALS_LOCK_DIRNAME)))
    .catch(() => { /* 设置未就绪可忽略，锁会在下次 AI 会话前置处理 */ })

  const profilePoolReady = migrateLegacyPacks({
    dshHome: () => settings.read().then(value => value.dshHome),
    readSettings: () => settings.read(),
    saveSettings: next => settings.save(next),
    pluginReceiptsPath,
    registryPath: path.join(userData, 'packs.json'),
    manifestRoot: path.join(userData, 'pack-manifests'),
    isRuntimeRunning: () => runtime.isRunning() || (packControl?.isRunning() ?? false),
  }).then(async () => {
    const current = await settings.read()
    const result = await consolidatePluginPool(current.dshHome)
    if (result.dependencies > 0) events.output('plugin', 'info', `已将 ${result.dependencies} 个整合包插件依赖归并到共享插件池。`)
  }).then(async () => {
    await migrateToPackHomesV2({
      registryPath: packsJsonPath,
      readStoredSettings: () => settings.readStored(),
      saveSettings: next => settings.save(next),
      isRuntimeRunning: () => runtime.isRunning() || (packControl?.isRunning() ?? false),
    })
  }).catch(error => events.output('plugin', 'error', `旧整合包/插件池迁移失败：${error instanceof Error ? error.message : String(error)}`))

  // 登录自启的注册动作：路径优先便携版 EXE（便携版进程路径在解包后的临时目录）。
  const loginRegistration = (enabled: boolean): void => {
    if (process.platform !== 'win32' || !app.isPackaged) return
    app.setLoginItemSettings(loginItemSettings(enabled, { executablePath: process.execPath, portableExecutablePath: process.env.PORTABLE_EXECUTABLE_FILE }))
  }
  // 卸载引擎：计划里的路径是可变快照，dshHome 要等设置读出来（数据目录在模块初始化时已定）。
  // 便携版的 process.execPath 指向 %TEMP% 解压目录，真正要删的是 PORTABLE_EXECUTABLE_FILE。
  const executablePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
  const uninstallPlan: UninstallPlanInput = {
    executablePath,
    installDir: path.dirname(executablePath),
    dataDir: app.getPath('userData'),
    legacyDataDir: path.join(app.getPath('appData'), LEGACY_DATA_DIRNAME),
    dshHome: '',
    tempDir: os.tmpdir(),
  }
  const uninstall = createUninstallService({ plan: uninstallPlan, stopAllPacks: () => packControl!.shutdown() })
  // 空闲自动关机：判定要读「谁在跑」和「包里的会话列」，两者都只能经 packControl 拿到；
  // packControl 在下一行才赋值，所以这里的依赖全部走闭包、在真正 tick 时才解引用。
  const idleShutdown = createIdleShutdownService({
    settings,
    listRunningPacks: async () => {
      // 走 pack.list：一次扫描就同时带回托管运行状态与「未托管实例」。
      // 未托管实例里可能正有会话在跑，而启动器停不掉它，只能算忙并把原因给用户看。
      const listed = await packControl!.execute({ command: 'pack.list' }) as {
        packs?: { id: string; name: string; runtime?: { running?: boolean; url?: string | null }; externalRuntime?: { pid: number } | null }[]
      }
      return (listed.packs ?? []).flatMap(pack => {
        if (pack.runtime?.running === true) return [{ id: pack.id, name: pack.name, url: pack.runtime.url ?? null }]
        if (pack.externalRuntime) {
          return [{ id: pack.id, name: pack.name, url: null, unmanaged: true, note: '有一份启动器没在托管的实例在运行（PID ' + pack.externalRuntime.pid + '），先在控制面板里停止它再关机' }]
        }
        return []
      })
    },
    countRunningSessions: async (url, signal) => (await readRunningSessions({ baseUrl: url, fetch: githubAuth.fetch, signal })).length,
    // 关机前停包不弹 UAC：此刻界面可能已经关了，没人能点确认。
    stopPack: async packId => { await packControl?.execute({ command: 'pack.stop', packId, args: { noElevated: true } }) },
    notify: (title, body) => {
      try {
        if (Notification.isSupported()) new Notification({ title, body }).show()
      } catch (error) {
        console.error('[idle-shutdown] 发送系统通知失败。', error)
      }
    },
    shutdown: async comment => {
      if (process.platform !== 'win32') return false
      await runCommand('shutdown.exe', ['/s', '/t', '0', '/c', comment], { cwd: os.tmpdir(), env: process.env, timeoutMs: 5_000 })
      return true
    },
  })
  packControl = createLauncherControl({
    userData, cliPath: path.join(app.getAppPath(), 'bin/launcher-control.cjs'), settings, packManager: packManager!, storage: storageController,
    prepareNodeRuntime: () => prepareNodeRuntime('runtime'),
    preparePnpmRuntime: node => preparePnpmRuntime('plugin', node),
    openExternal: url => shell.openExternal(url), fallbackWorkspace: () => app.getPath('documents'),
    fetchImpl: githubAuth.fetch, emitOutput: text => events.output('runtime', 'info', text),
    legacyRuntimeRunning: () => runtime.isRunning(), prepareOfficeCliTool,
    loginRegistration, uninstall, onUninstallStarted: quitAfterUninstallStarted, idleShutdown,
  })
  return { packControl, uninstall, uninstallPlan, idleShutdown, launcherControl: request => packControl!.execute(request), loginRegistration, apiLibrary: packControl.apiLibrary, packApis: packControl.packApis, settings, pluginReceiptsPath, runtime, installer, launcherUpdater, pluginTrial, aiInstaller, copilot, packManager: packManager!, githubAuth, applicationAddons, catalogSync, dshMarket, desktopPlugins, recommendedWebUi, runtimeVersions, profiles: profileService, profilePoolReady, restoreOfficialPack, listOfficialPackVersions: async () => listOfficialPackVersions(await officialListDeps()), readOfficialPackStatus: force => resolveOfficialPackStatus(force === true), installOfficialPackVersion, officialPackBootstrap }
}

// helper 已在 %TEMP% 里跑起来，主进程必须让位：EXE 被自己占着就永远删不掉。
// 延后一拍是为了先把 IPC/HTTP 的回复写完，别让响应跟着进程一起消失。
function quitAfterUninstallStarted(): void {
  setTimeout(() => app.quit(), 300)
}

function openMainWindow(): void {
  const window = createMainWindow({
    preloadPath: path.join(moduleDirectory, 'preload.mjs'),
    iconPath: launcherIconPath,
    devServerUrl: process.env.VITE_DEV_SERVER_URL,
    indexPath: path.join(moduleDirectory, '../dist/index.html'),
    onClosed: () => { mainWindow = null },
  })
  // 点 X 或 Alt+F4 只隐藏到托盘继续后台运行；托盘菜单「退出」经 app.quit()
  // 触发 before-quit 置位 isQuitting 后，这里才放行关闭。
  window.on('close', event => {
    if (isQuitting) return
    event.preventDefault()
    window.hide()
    if (!backgroundNoticeShown) {
      backgroundNoticeShown = true
      tray?.notifyBackground()
    }
  })
  mainWindow = window
}

/** 从托盘或第二实例唤起主窗口；窗口不存在时重建。 */
function showMainWindow(): void {
  const window = getWindow()
  if (!window || window.isDestroyed()) {
    openMainWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  // 无边框透明窗口从后台唤起时常抢不到焦点，短暂置顶可确保激活。
  window.setAlwaysOnTop(true, 'screen-saver')
  window.show()
  window.focus()
  window.setAlwaysOnTop(false, 'screen-saver')
}

// 第二个实例直接退出，由已运行实例通过 second-instance 唤起前台窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())
  // 提权后的这次先留痕：父进程正握着 20 秒预算等这个标记，看到就退出。
  // 写失败只 warn：父进程会按超时收尾，两个实例不会同时活着（锁已经保证了这点）。
  if (process.argv.slice(1).some(argument => isElevatedRelaunchFlag(argument))) {
    void writeBootMarker(app.getPath('userData')).catch(error => {
      console.warn('[elevation-handshake] 启动标记写失败，父进程将按超时处理。', error)
    })
  }
}

/**
 * 备份区恢复前要按路径反查整合包，而这条链路在 IPC handle 里是同步的：
 * 直接读注册表原文（与 readPackRegistry 同一信封），读不到就当没有包。
 */
function packRecordsForBackups(): { id: string; name: string; homePath?: string }[] {
  try {
    const value = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'packs.json'), 'utf8')) as {
      records?: { id?: unknown; name?: unknown; homePath?: unknown }[]
    }
    if (!Array.isArray(value.records)) return []
    const records: { id: string; name: string; homePath?: string }[] = []
    for (const record of value.records) {
      if (typeof record?.id !== 'string' || !record.id) continue
      records.push({
        id: record.id,
        name: typeof record.name === 'string' ? record.name : record.id,
        ...(typeof record.homePath === 'string' && record.homePath ? { homePath: record.homePath } : {}),
      })
    }
    return records
  } catch {
    return [] // 与 readPackRegistry 一致：文件缺失或损坏都按「没有包」处理
  }
}

app.whenReady().then(async () => {
  // 系统代理先探起来（异步，与下面的启动步骤并行）：之后所有子进程都只读缓存，
  // 不必再在事件循环上同步查注册表。等完再建服务，确保第一次装包/启动就带上代理。
  const systemProxyProbe = refreshWindowsSystemProxy()
  await recoverLegacyCredentials(path.join(app.getPath('userData'), 'dsh-credentials-compat')).catch(error => {
    console.error('[credentials] 旧版 DSH 凭据恢复失败。', error)
  })
  await systemProxyProbe
  // 设置要在服务装配之前读出来：提权判定必须早于 createServices——它一进去就开始跑旧整合包迁移，
  // 而提权重启会把那次迁移连根拔掉。
  const bootSettingsStore = createLauncherSettingsStore(app.getPath('userData'))
  const startupSettings = await bootSettingsStore.read()
  // 启动即提权：必须在开窗口、注册 IPC、迁移数据之前决断。
  // 失败（用户点「否」、UAC 被拦）就当没开这个设置继续，绝不因为提权失败而崩掉启动器；
  // argv 里的 --elevated-relaunch 保证提权后的那次不会再弹一次，不会无限重启。
  // 单实例锁此刻正被本进程持有，而提权子进程要靠它活着——所以先释放，重启失败再抢回来。
  if (
    shouldRelaunchElevated({
      launchElevated: startupSettings.launchElevated,
      argv: process.argv.slice(1),
      elevated: await isProcessElevated(),
    })
  ) {
    // 标记的来源时间要早于 spawn：早于它的启动标记是上一次启动留下的，不能拿来交班。
    const relaunchSince = Date.now()
    const outcome = await orchestrateElevationRelaunch({
      releaseLock: () => {
        app.releaseSingleInstanceLock()
      },
      acquireLock: () => app.requestSingleInstanceLock(),
      relaunch: async () => {
        const spawned = await relaunchElevated({
          executablePath: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
          args: buildElevatedRelaunchArgs({ argv: process.argv.slice(1), dataDir: app.getPath('userData') }),
        })
        if (!spawned) return false
        // Start-Process 成功只说明系统接手了启动：提权进程仍可能起不来（被杀、缺依赖）。
        // 等到它写下启动标记再交班，否则父进程一退就成了「点了以后什么都没开」。
        return await waitForBootMarker(app.getPath('userData'), { since: relaunchSince })
      },
    })
    // 只有 continued 才继续启动：relaunched = 新实例已接手，handed-over = 锁已被别的实例拿走。
    if (outcome !== 'continued') {
      app.quit()
      return
    }
  }
  try {
    processSupervisor = await createProcessSupervisor({
      root: path.join(app.getPath('userData'), 'process-supervisor'),
      onError: message => console.error(`[process-supervisor] ${message}`),
    })
    configureProcessTracker(processSupervisor)
  } catch (error) {
    console.error('[process-supervisor] 启动失败，退出时只能执行普通清理。', error)
  }
  services = createServices(bootSettingsStore)
  // 备份区必须早于任何「会删用户数据的启动路径」：三条删除链路在没装配引擎时会拒绝删除，
  // 而装配本身同步且零成本（tar.exe / PowerShell 探测推迟到第一次备份）。
  try {
    registerBackupsIpc({
      ipcMain,
      root: app.getPath('userData'),
      isPackRunning: id => services?.packControl.isPackRunning(id) ?? false,
      packLabel: id => packRecordsForBackups().find(record => record.id === id)?.name ?? null,
      // 恢复前拦活着的包：同一家目录可能有多个包共用，优先报正在跑的那个。
      packForPath: target => {
        const resolved = path.resolve(target).toLowerCase()
        const matches = packRecordsForBackups().filter(record => {
          const home = record.homePath ?? startupSettings.dshHome
          if (!home) return false
          const prefix = path.resolve(home).toLowerCase()
          return resolved === prefix || resolved.startsWith(prefix + path.sep)
        })
        if (matches.length === 0) return null
        const running = matches.find(record => services?.packControl.isPackRunning(record.id))
        return (running ?? matches[0]).id
      },
      revealPath: target => shell.showItemInFolder(target),
    })
  } catch (error) {
    // 吞掉异常会让启动器能开、但所有删除都失败，等同于把用户卡在半坏状态。
    dialog.showErrorBox('备份区初始化失败', error instanceof Error ? error.message : String(error))
    app.quit()
    return
  }
  // 启动器插件：目录可能不存在，先建出来再装配；代码插件最多跑 10 秒，不挡开窗。
  const pluginsDirectory = path.join(app.getPath('userData'), 'launcher-plugins')
  mkdirSync(pluginsDirectory, { recursive: true })
  const launcherPlugins = registerLauncherPluginsIpc({
    ipcMain,
    directory: pluginsDirectory,
    openFolder: async directory => {
      mkdirSync(directory, { recursive: true })
      await shell.openPath(directory)
    },
  })
  void launcherPlugins.refresh()
  // 工作区 skill 的根是 DSH 家目录（<dshHome>/skills 与 <dshHome>/storages/workspace.json），
  // 家目录可在设置里改，所以每次调用都取当前值而不是启动快照。
  let workspaceSkillsHome = startupSettings.dshHome
  registerWorkspaceSkillsIpc({
    ipcMain,
    service: createWorkspaceSkillsService({ home: () => workspaceSkillsHome }),
    revealPath: target => shell.showItemInFolder(target),
  })
  // 续接队列与目录迁移：队列实例由 facade 持有，IPC 复用同一份，界面「重试」才看得到 CLI 排的条目。
  registerPendingResumesIpc({
    ipcMain,
    queue: services.packControl.pendingResumeQueue,
    baseUrlOf: packId => services?.packControl.runtimeUrl(packId) ?? null,
  })
  registerPathMigrationIpc({ ipcMain, migrate: (kind, target) => services!.packControl.paths.migrate(kind, target) })
  // 空闲自动关机：布防状态以设置为准，启动时先对齐一次，开关为 true 才会进入 waiting。
  registerIdleShutdownIpc({ ipcMain, service: services.idleShutdown })
  void services.idleShutdown.applySettings(startupSettings).catch(error => console.error('[idle-shutdown] 启动时同步设置失败。', error))
  // 卸载：dshHome 决定计划里哪一行算「用户自己的数据」，所以等设置读出来再补上；helper 起来后主进程直接退出。
  services.uninstallPlan.dshHome = startupSettings.dshHome
  registerUninstallIpc({
    ipcMain,
    service: services.uninstall,
    dataDir: app.getPath('userData'),
    onStarted: quitAfterUninstallStarted,
  })
  // 启动时按设置校正一次登录项：缺省 false 会主动注销历史遗留的旧注册项。
  syncLaunchAtLogin(startupSettings, services.loginRegistration)
  controlServer = await createLauncherControlServer({ userData: app.getPath('userData'), execute: request => services!.launcherControl(request) })
  // 外观图片统一落在 userData/appearance/，渲染层经 dsh-appearance:// 读取。
  const appearanceDirectory = path.join(app.getPath('userData'), 'appearance')
  registerAppearanceProtocol(appearanceDirectory)
  registerIpcHandlers({
    ...services,
    skillsShIndexPath: path.join(app.getPath('userData'), 'skills-sh-index.json'),
    newsCachePath: path.join(app.getPath('userData'), 'juya-news-cache.json'),
    appearanceDirectory,
    storage: { ...storageController, relaunch: relaunchLauncher },
    getWindow,
    setWindowMode: (mode: WindowMode) => applyWindowMode(mainWindow, mode),
    // 家目录换了以后工作区 skill 必须跟着换根，否则会继续列旧目录。
    onSettingsSaved: saved => {
      workspaceSkillsHome = saved.dshHome
      void services?.idleShutdown.applySettings(saved).catch(error => console.error('[idle-shutdown] 同步设置失败。', error))
    },
  })
  await services.profilePoolReady
  void services.packControl.autoStart()
  openMainWindow()
  if (process.argv.includes('--background')) mainWindow?.hide()
  // 开发者自查界面用：传了 --ui-shots=<目录> 才逐栏目截图，正常启动什么都不做。
  const uiShotDir = uiShotDirectory(process.argv)
  if (uiShotDir && mainWindow) {
    void captureUiShots(mainWindow, uiShotDir).then(
      files => console.log('[ui-shots]', files.length, 'files'),
      error => console.error('[ui-shots]', error),
    )
  }
  // 官方整合包首启/更新核对：后台进行，不挡窗口。
  void services.officialPackBootstrap()
  tray = createTray({ iconPath: launcherIconPath, showMainWindow })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function waitForIdle(check: () => boolean): Promise<void> {
  if (!check()) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setInterval(() => {
      if (!check()) {
        clearInterval(timer)
        resolve()
      }
    }, 100)
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function shutdownLauncherProcesses(): Promise<void> {
  const current = services
  // 先让监督器对仍在运行的根进程做快照；若 DSH 派生了脱离父进程树的服务，
  // 必须在正常停止根进程前收集它们，否则关闭后无法再定位微信机器人 PID。
  const supervisorShutdown = processSupervisor?.shutdown().catch(error => {
    console.error('[process-supervisor] 清理子进程失败。', error)
  }) ?? Promise.resolve()
  const gracefulTasks: Promise<unknown>[] = []
  if (controlServer) gracefulTasks.push(controlServer.close())
  if (current) gracefulTasks.push(current.packControl.shutdown())
  if (current) gracefulTasks.push(current.idleShutdown.dispose())
  if (current?.runtime.isRunning()) gracefulTasks.push(current.runtime.stop())
  if (current?.pluginTrial.isBusy()) gracefulTasks.push(current.pluginTrial.cancel())
  if (current?.aiInstaller.isBusy()) gracefulTasks.push(current.aiInstaller.cancel())
  if (current?.copilot.isBusy()) gracefulTasks.push(current.copilot.shutdown())
  if (current?.packManager.isBusy()) gracefulTasks.push(waitForIdle(() => current.packManager.isBusy()))
  if (current?.installer.isBusy()) gracefulTasks.push(waitForIdle(() => current.installer.isBusy()))
  if (current?.applicationAddons.isBusy()) gracefulTasks.push(waitForIdle(() => current.applicationAddons.isBusy()))

  const graceful = Promise.allSettled(gracefulTasks)
  await Promise.race([Promise.all([graceful, supervisorShutdown]), delay(2_000)])
  await supervisorShutdown
  // 监督器处理完整树后，主进程再用本地句柄兜底，覆盖通信丢失或快速关闭。
  await shutdownTrackedProcesses().catch(error => {
    console.error('[process-tracker] 清理子进程失败。', error)
  })
  configureProcessTracker(null)
  await Promise.race([graceful, delay(800)])

  if (current) {
    try {
      const settings = await current.settings.read()
      await healCredentialsLock(
        settings.dshHome,
        path.join(app.getPath('userData'), CREDENTIALS_LOCK_DIRNAME),
      )
    } catch (error) {
      console.error('[shutdown] AI 凭据文件还原失败。', error)
    }
  }
}

// 无论是正常关闭还是安装过程中退出，所有由启动器登记的进程树都必须一起结束。
app.on('before-quit', event => {
  if (allowFinalQuit) return
  event.preventDefault()
  if (quitCleanupStarted) return
  quitCleanupStarted = true
  // 放行窗口 close：清理完成后窗口随退出流程正常关闭。
  isQuitting = true
  void shutdownLauncherProcesses().finally(() => {
    allowFinalQuit = true
    app.quit()
  })
})

// will-quit 在 before-quit 清理完成后触发，此时移除托盘图标。
app.on('will-quit', () => {
  tray?.destroy()
  tray = null
})
