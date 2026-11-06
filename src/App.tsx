import { Suspense, lazy, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Layers3, LoaderCircle } from 'lucide-react'
import { LauncherApiProvider, resolveLauncherApi, useLauncherApi } from './api/client'
import { PackDashboard } from './components/PackDashboard'
import { StartView, updateNeedsDialog } from './components/start/StartView'
import { TopBar } from './components/TopBar'
import { Toast } from './components/Toast'
import { DshFailureDialog } from './components/dialogs/DshFailureDialog'
import { UpdateDialog } from './components/dialogs/UpdateDialog'
import { DSH_REPOSITORY } from './constants'
import { BUSY } from './hooks/use-async-action'
import { useLauncherStore } from './hooks/use-launcher-store'
import { useNavigation } from './hooks/use-navigation'
import { usePackInstall } from './hooks/use-pack-install'
import { isInstallProgressActive } from './lib/install-progress'
import { HOME_TAB_ORDER } from './lib/nav'
import { isDshVersionOlderThan } from './lib/dsh-version'
import { APPEARANCE_VARIABLE_KEYS, appearanceImageUrl, appearanceVariables } from './lib/appearance'
import type { AppearanceSettings, DshInstallationStatus, DshUpdateStatus, HomeTab, InstallProgress, LauncherUpdateStatus, RuntimeState } from './types'

// 启动页只用到 StartView 与顶栏；整合包/插件/技能/预设/版本这一整块面板（以及导入对话框）
// 拆成按需加载的 chunk，首屏要解析的 JS 就少一截。
const SettingsPanels = lazy(() => import('./views/SettingsView').then(module => ({ default: module.SettingsPanels })))
// 设置页整页化后与其余面板同批按需加载：首屏只留启动页。
const SettingsHomeView = lazy(() => import('./views/SettingsHomeView').then(module => ({ default: module.SettingsHomeView })))
const PackInstallDialog = lazy(() => import('./components/dialogs/PackInstallDialog').then(module => ({ default: module.PackInstallDialog })))
const SessionImportDialog = lazy(() => import('./components/dialogs/SessionImportDialog').then(module => ({ default: module.SessionImportDialog })))
const PackExportDialog = lazy(() => import('./components/dialogs/PackExportDialog').then(module => ({ default: module.PackExportDialog })))
const PackVersionCloneDialog = lazy(() => import('./components/dialogs/PackVersionCloneDialog').then(module => ({ default: module.PackVersionCloneDialog })))

/** 产品名：前端可见文案与窗口标题统一用它（electron 主进程标题不在这里改）。 */
const APP_TITLE = 'DSH启动器：KEWU'

/**
 * 应用根。
 * 只做三件事：提供主进程 API、组装状态与视图、挂载对话框。
 * 业务逻辑在 hooks 里，展示逻辑在 components 与 views 里。
 * 管理界面（开发人员选项）已随「暴力整合包模式」路线整体移除。
 */
export default function App() {
  const api = useMemo(() => resolveLauncherApi(), [])
  return (
    <LauncherApiProvider value={api}>
      <LauncherShell />
    </LauncherApiProvider>
  )
}

function LauncherShell() {
  const api = useLauncherApi()
  const store = useLauncherStore()
  const navigation = useNavigation()
  // 整合包创建/导入是流式任务；结算后刷新包列表与快照状态。
  const packInstall = usePackInstall(() => {
    void store.refreshPacks()
    void store.refreshPackSnapshots()
  }, store.showToast)

  /** 本机已安装的 DSH 版本集合：导入的整合包若要求缺失版本，安装前需确认下载。 */
  const installedDshVersions = useMemo(
    () => new Set((store.runtimeEnvironment?.dshInstalled ?? []).map(item => item.version)),
    [store.runtimeEnvironment],
  )
  /** 新建整合包的可选版本（按安装顺序）。 */
  const dshVersionChoices = useMemo(
    () => (store.runtimeEnvironment?.dshInstalled ?? []).map(item => item.version),
    [store.runtimeEnvironment],
  )

  // 对话框开关是纯展示状态，不进 store。
  const [updateOpen, setUpdateOpen] = useState(false)
  // 启动页手动「检查更新」的结果：比后台检查更新，用户当场看到的应是这一次。
  const [manualUpdate, setManualUpdate] = useState<LauncherUpdateStatus | null>(null)
  // 设置面板拖动时先预览、后保存：null 表示不预览，回到已保存的 appearance。
  const [previewAppearance, setPreviewAppearance] = useState<AppearanceSettings | null>(null)
  // 「导入会话」的目标包 id（入口长在那个包的卡片上）。
  const [sessionImportTarget, setSessionImportTarget] = useState<string | null>(null)
  // 「导出」对话框对应的包 id（隐私勾选项在那里决定）。
  const [exportTarget, setExportTarget] = useState<string | null>(null)
  // 「切换版本」（升版副本）对话框对应的包 id。
  const [cloneTarget, setCloneTarget] = useState<string | null>(null)
  // keep-mounted 集合：访问过的一级 tab 保持挂载，切换只切可见性。
  const visitedTabs = useRef(new Set<HomeTab>(['start']))

  const theme = store.settings?.uiTheme ?? 'deepseek'
  const effectiveAppearance = previewAppearance ?? store.settings?.appearance
  // 品牌改名只落在渲染层：index.html 的 <title> 是父级契约文件，不动它。
  useEffect(() => {
    document.title = APP_TITLE
  }, [])
  // 外观变量挂在根元素：设置面板的实时预览与保存后的生效走同一条路径，
  // 取消时把 previewAppearance 置 null 就会按已保存设置重算，天然还原。
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = theme
    for (const key of APPEARANCE_VARIABLE_KEYS) root.style.removeProperty(key)
    for (const [key, value] of Object.entries(appearanceVariables(effectiveAppearance, theme))) {
      root.style.setProperty(key, value)
    }
  }, [theme, effectiveAppearance])

  const installingResource = isInstallProgressActive(store.installProgress)
  const installingDsh = store.busy === BUSY.dshInstall
    || (installingResource && store.installProgress?.kind === 'dsh')
  const installingApplication = installingResource && store.installProgress?.kind === 'application'
  // 安装会写入整合包、Skill 或应用注册表；跨页时仍需阻止这些写操作。
  const profileMutationLocked = installingResource
  // The selector itself must not be latched by a stale install-progress event.
  // The main-process mutation guard remains authoritative while a real
  // installer is still active; only an in-flight Profile switch disables it.
  const profileSwitcherLocked = store.busy?.startsWith('profile-switch:') === true
  const runtimeBusy = store.busy === BUSY.runtime || installingResource || installingApplication || Boolean(store.busy?.startsWith('application'))
  const launcherUpdateBusy = store.busy === 'launcher-update-download' || store.busy === 'launcher-update-apply'
  // 包级弹窗按 id 回查那个包；查不到就用 id 兜底，标题里不留空白。
  const packById = (id: string) => store.packs.find(pack => pack.id === id) ?? null
  const packNameById = (id: string) => packById(id)?.name ?? id
  // 三个包级弹窗共用的写锁：store 正忙，或整合包注册表被安装占用。
  const packDialogBusy = store.busy !== null || profileMutationLocked

  const toggleRuntime = async () => {
    await store.toggleRuntime()
  }

  const openHarness = () => {
    if (store.runtime.url) void api.openExternal(store.runtime.url)
  }

  const closeWindow = () => void api.closeWindow()
  const minimizeWindow = () => void api.minimizeWindow()

  /** 「导入整合包」：选文件 → analyze 拿预览 → PackInstallDialog 展示 preview 态。 */
  const handlePackImport = async () => {
    const path = await api.pickPackFile()
    if (!path) return
    await packInstall.startImport(path)
  }

  if (store.loading || !store.settings || !store.profile) {
    return (
      <div className="app-loading">
        <div className="brand-mark"><Layers3 size={22} /></div>
        <LoaderCircle className="spin" size={22} />
        <span>正在读取 DSH 配置</span>
      </div>
    )
  }

  const { settings, profile } = store
  // 版本号让同一路径换图后 URL 也变化：背景层与头像 <img> 才会重新取图。
  const backgroundUrl = appearanceImageUrl(effectiveAppearance?.backgroundPath, effectiveAppearance?.backgroundVersion)
  const logoSrc = appearanceImageUrl(effectiveAppearance?.logoPath, effectiveAppearance?.logoVersion)
  // 启动页手动检查的结果优先：用户刚点过，就该看到这一次的结论。
  const launcherUpdate = manualUpdate ?? store.launcherUpdate
  visitedTabs.current.add(navigation.homeTab)

  // 一级面板（整合包/版本/插件/技能/预设）只建一次元素：整合包页把它接在控制面板下面，
  // 其余 tab 直接整页展示，避免两份 60 行的 props 拷贝。
  const panelsFor = (tab: Exclude<HomeTab, 'start'>) => (
    <SettingsPanels
      tab={tab}
      settings={settings}
      profile={profile}
      dshInstallation={store.dshInstallation}
      runtimeEnvironment={store.runtimeEnvironment}
      installedSkills={store.installedSkills}
      installedPresets={store.installedPresets}
      packs={store.packs}
      busy={store.busy}
      onUninstallSkill={store.uninstallSkill}
      profileMutationLocked={profileMutationLocked}
      installProgress={store.installProgress}
      onRefresh={() => {
        void store.refreshProfile()
        void store.refreshSecondaryResources()
        void store.refreshPacks()
        void store.refreshRuntimeEnvironment(true)
      }}
      onImportPack={() => void handlePackImport()}
      onImportPackPath={path => { void packInstall.startImport(path) }}
      onRestoreOfficialPack={() => { void store.restoreOfficialPack() }}
      officialStatus={store.officialStatus}
      officialVersions={store.officialVersions}
      officialVersionsError={store.officialVersionsError}
      officialVersionsBusy={store.officialVersionsBusy}
      onReadOfficialPackStatus={store.readOfficialPackStatus}
      onRefreshOfficialVersions={store.refreshOfficialVersions}
      onInstallOfficialPackVersion={store.installOfficialPackVersion}
      onInstallDshVersion={async version => {
        const ok = await store.installDshVersion(version)
        // 装版本会自动补发同名整合包（零包时还会自动激活成为当前包），
        // 刷新包列表与整合包/插件/技能读数让新环境立刻可见。
        if (ok) {
          await Promise.all([store.refreshPacks(), store.refreshProfile(), store.refreshSecondaryResources()])
        }
        return ok
      }}
      onRemoveDshVersion={store.removeDshVersion}
      onTogglePlugin={store.togglePlugin}
      onUninstallPlugin={async plugin => { await store.uninstallPlugin(plugin); return true }}
      onToggleSkill={store.toggleSkill}
      onTogglePreset={store.togglePreset}
      onSkillInstalled={result => {
        store.applyCatalogSkillInstall(result)
        // 包行计数是实时探测家目录的：装完技能刷一次让计数立刻可见。
        void store.refreshPacks()
      }}
      onProfileChanged={() => {
        void store.refreshProfile()
        // 插件安装/启停只写包家目录，包行计数实时探测自家目录：一并刷新。
        void store.refreshPacks()
      }}
      onActivatePack={store.activatePack}
      packActivity={store.packActivity}
      packDownload={store.packDownload}
      packStage={store.packStage}
      onRenamePack={store.renamePack}
      onCreateBlankPack={(name, dshVersion) => store.createBlankPack({ name, dshVersion })}
      onPackDiskUsage={store.packDiskUsage}
      onRemovePack={store.removePack}
      onRequestExport={packId => setExportTarget(packId)}
      onImportSessions={packId => setSessionImportTarget(packId)}
      onCloneVersion={packId => setCloneTarget(packId)}
      onOpenDshFolder={() => void api.openDshFolder()}
      onOpenPluginFolder={packageName => { void api.openProfilePluginFolder(packageName) }}
      onOpenPath={targetPath => { void api.openPath(targetPath) }}
      onNavigateTab={navigation.goHome}
    />
  )

  return (
    <div
      className="app-root"
      data-has-bg={backgroundUrl ? '1' : undefined}
      style={backgroundUrl ? ({ '--bg-image': `url("${backgroundUrl}")` } as CSSProperties) : undefined}
    >
      {backgroundUrl && <div className="home-bg-layer" aria-hidden="true" />}
      <TopBar
        activeTab={navigation.homeTab}
        openWebVisible={store.runtime.running && Boolean(store.runtime.url)}
        onSelectTab={navigation.goHome}
        onOpenHarness={openHarness}
        onMinimize={minimizeWindow}
        onClose={closeWindow}
      />
      <div className="app-content">
        <div className="surface-stage surface-launcher">
          <div className="surface-host launcher-surface-host">
            {HOME_TAB_ORDER.filter(tab => visitedTabs.current.has(tab)).map(tab => (
              <div key={tab} className={`home-tab-pane ${navigation.homeTab === tab ? '' : 'view-hidden'}`}>
                {tab === 'start' ? (
                  <StartView
                    logoSrc={logoSrc}
                    update={launcherUpdate}
                    busy={launcherUpdateBusy}
                    onUpdateChecked={next => {
                      setManualUpdate(next)
                      if (updateNeedsDialog(next)) setUpdateOpen(true)
                    }}
                    onOpenSettings={() => navigation.goHome('settings')}
                  />
                ) : tab === 'settings' ? (
                  <Suspense fallback={null}>
                    <SettingsHomeView
                      settings={settings}
                      busy={store.busy === BUSY.settings || profileMutationLocked}
                      onPreview={setPreviewAppearance}
                      onSave={async next => {
                        const ok = await store.saveSettings(next)
                        if (ok) setPreviewAppearance(null)
                        return ok
                      }}
                      onCheckUpdate={() => setUpdateOpen(true)}
                      onOpenPath={targetPath => { void api.openPath(targetPath) }}
                      onOpenDshFolder={() => void api.openDshFolder()}
                    />
                  </Suspense>
                ) : tab === 'packs' ? (
                  <div className="packs-view">
                    <PacksRuntimeBar
                      runtime={store.runtime}
                      dshInstallation={store.dshInstallation}
                      dshUpdate={store.dshUpdate}
                      installProgress={store.installProgress?.repository === DSH_REPOSITORY ? store.installProgress : null}
                      busy={runtimeBusy}
                      installingDsh={installingDsh}
                      onOpenWeb={openHarness}
                      onStop={() => void toggleRuntime()}
                      onUpdateDsh={() => { void store.updateDsh() }}
                    />
                    <PackDashboard
                      installedDshVersions={dshVersionChoices}
                      onCreate={async (name, dshVersion) => {
                        const created = await store.createBlankPack({ name, dshVersion })
                        if (created) void store.refreshPacks()
                        return Boolean(created)
                      }}
                      onImport={() => void handlePackImport()}
                      onExport={setExportTarget}
                      onImportSessions={setSessionImportTarget}
                      onCloneVersion={setCloneTarget}
                      onOpenVersions={() => navigation.goHome('versions')}
                    />
                    {/* 控制面板已经在上面接管了包列表；重命名/导出/会话导入/官方包这些动作仍由设置面板承担，收进折叠区避免同一页出现两份列表。 */}
                    <details className="packs-more">
                      <summary>更多整合包操作（重命名 · 导出 · 会话导入 · 官方包）</summary>
                      <Suspense fallback={null}>{panelsFor('packs')}</Suspense>
                    </details>
                  </div>
                ) : (
                  <Suspense fallback={null}>{panelsFor(tab)}</Suspense>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {packInstall.phase !== 'idle' && (
        <Suspense fallback={null}>
          <PackInstallDialog
          phase={packInstall.phase}
          events={packInstall.events}
          result={packInstall.result}
          error={packInstall.error}
          analysis={packInstall.analysis}
          itemProgress={packInstall.itemProgress}
          hasSnapshot={packInstall.hasSnapshot}
          packSnapshotsAvailable={store.packSnapshotsAvailable}
          installedDshVersions={installedDshVersions}
          busy={store.busy !== null || packInstall.busy !== null}
          onConfirmImport={(items, name) => void packInstall.confirmImport(packInstall.importPath ?? '', items, name)}
          onRollback={() => void packInstall.rollback()}
          onActivate={packId => {
            void (async () => {
              if (await store.activatePack(packId)) packInstall.reset()
            })()
          }}
          onClose={packInstall.reset}
        />
        </Suspense>
      )}
      {sessionImportTarget && (
        <Suspense fallback={null}>
          <SessionImportDialog
            targetPackId={sessionImportTarget}
            targetPackName={packNameById(sessionImportTarget)}
            // 记录格式只升不降：比目标包新的那些包搬过来，目标包的 DSH 读不动，所以根本不列。
            packs={store.packs.filter(pack => !isDshVersionOlderThan(pack.dshVersion, packById(sessionImportTarget)?.dshVersion))}
            busy={packDialogBusy}
            onPreview={sourcePackId => store.previewSessionImport(sourcePackId, sessionImportTarget)}
            onImport={async sourcePackId => {
              const done = await store.importSessionHistory(sourcePackId, sessionImportTarget)
              if (done) void store.refreshPacks()
              return done
            }}
            onUndo={undoId => store.undoSessionImport(undoId)}
            onClose={() => setSessionImportTarget(null)}
          />
        </Suspense>
      )}
      {exportTarget && (
        <Suspense fallback={null}>
          <PackExportDialog
            packName={packNameById(exportTarget)}
            busy={packDialogBusy}
            onExport={privacy => store.exportPack(exportTarget, privacy)}
            onClose={() => setExportTarget(null)}
          />
        </Suspense>
      )}
      {cloneTarget && (
        <Suspense fallback={null}>
          <PackVersionCloneDialog
            packName={packNameById(cloneTarget)}
            currentVersion={packById(cloneTarget)?.dshVersion ?? null}
            installedVersions={(store.runtimeEnvironment?.dshInstalled ?? []).map(item => item.version)}
            availableVersions={(store.runtimeEnvironment?.dshAvailable ?? []).map(item => item.version)}
            busy={packDialogBusy}
            onClone={async request => {
              const created = await store.createVersionClone(cloneTarget, request)
              if (created) void store.refreshPacks()
              return created
            }}
            onDownloadFirst={version => {
              // 关窗 → 跳到「DSH版本」页 → 走那套带进度条的下载流程。
              // 复制动作等用户装完再回来点，别在这个弹窗里偷偷下一个 100MB。
              setCloneTarget(null)
              navigation.goHome('versions')
              void store.installDshVersion(version)
            }}
            onClose={() => setCloneTarget(null)}
          />
        </Suspense>
      )}
      {updateOpen && launcherUpdate && (
        <UpdateDialog
          status={launcherUpdate}
          progress={store.launcherUpdateProgress}
          busy={launcherUpdateBusy}
          onDownload={() => { void store.downloadLauncherUpdate() }}
          onApply={() => { void store.applyLauncherUpdate() }}
          onClose={() => setUpdateOpen(false)}
        />
      )}
      {store.dshFailure && (
        <DshFailureDialog failure={store.dshFailure} onClose={store.dismissDshFailure} />
      )}
      {store.toast && <Toast toast={store.toast} onClose={store.dismissToast} />}
    </div>
  )
}

/**
 * 整合包页顶部的运行时工具条：本地运行时状态 + DSH 安装/更新。
 * 旧启动页 <details> 里「运行时安装、更新与启动器工具」的入口迁到这里；
 * 具体某个整合包的启动/停止仍在下面控制面板的表格里。
 */
function PacksRuntimeBar({ runtime, dshInstallation, dshUpdate, installProgress, busy, installingDsh, onOpenWeb, onStop, onUpdateDsh }: {
  runtime: RuntimeState
  dshInstallation: DshInstallationStatus
  dshUpdate: DshUpdateStatus | null
  installProgress: InstallProgress | null
  busy: boolean
  installingDsh: boolean
  onOpenWeb: () => void
  onStop: () => void
  onUpdateDsh: () => void
}) {
  const version = dshInstallation.version ?? '未安装'
  const updateLabel = installingDsh
    ? (installProgress?.indeterminate ? '正在安装…' : `正在安装 ${installProgress?.percent ?? 0}%`)
    : dshUpdate?.state === 'update-available'
      ? `可更新到 ${dshUpdate.remoteVersion ?? '新版本'}`
      : dshUpdate?.state === 'up-to-date'
        ? '已是最新'
        : dshUpdate?.state === 'error' ? '检查失败' : dshInstallation.installed ? '未检查更新' : '未安装'
  return (
    <section className="packs-runtime">
      <div className="packs-runtime-state">
        <span className={`packs-runtime-dot ${runtime.running ? 'is-running' : ''}`} aria-hidden="true" />
        <strong>{runtime.running ? '本地运行时运行中' : '本地运行时未运行'}</strong>
        <small>{runtime.running ? runtime.url ?? '已启动' : '在下面的控制面板里点「启动」拉起本地服务'}</small>
      </div>
      <div className="packs-runtime-meta">
        <span>DSH {version}</span>
        <span>{updateLabel}</span>
      </div>
      <div className="packs-runtime-actions">
        {runtime.running && runtime.url && <button type="button" className="secondary-button" onClick={onOpenWeb}>打开网页</button>}
        {runtime.running && <button type="button" className="secondary-button" onClick={onStop} disabled={busy}>停止运行时</button>}
        <button type="button" className="primary-command" onClick={onUpdateDsh} disabled={busy}>
          {installingDsh ? '安装中…' : dshInstallation.installed ? '更新 DSH' : '安装 DSH'}
        </button>
      </div>
    </section>
  )
}
