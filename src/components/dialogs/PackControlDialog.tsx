import { ArrowLeft, Download, FolderOpen, LoaderCircle, Pencil, RefreshCw, Settings2, Store, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLauncherApi } from '../../api/client'
import { launcherControl, type ControlledPack, type PackControlConfig } from '../../lib/pack-control'
import type { InstalledSkill, InstalledPreset, ManagedPlugin, PackApiGrantState } from '../../types'
import { DshMarketView } from '../../views/DshMarketView'
import { SkillMarketPanel } from '../../views/SettingsView'
import { ModalShell } from './ModalShell'

type Kind = 'plugins' | 'skills' | 'presets'
type Resource = (ManagedPlugin | InstalledSkill | InstalledPreset) & { shared?: boolean; sourcePackId?: string; sourcePackName?: string; source?: string }
interface Props {
  pack: ControlledPack
  busy: boolean
  onClose: () => void
  onSave: (config: Partial<PackControlConfig>) => Promise<boolean>
  onRefresh: () => Promise<void>
  onExport: () => void
  onImportSessions: () => void
  onCloneVersion: () => void
  /** 本机已安装的 DSH 版本：切换版本只能选这些。 */
  installedDshVersions: string[]
  /** 原地切换本包认的 DSH 版本（只能升不能降）；成功返回 true。 */
  onUpgradeVersion: (version: string) => Promise<boolean>
}
export function PackControlDialog(props: Props) {
  const { pack } = props
  const api = useLauncherApi()
  const [tab, setTab] = useState<'overview' | 'settings' | 'api' | Kind | 'export'>('overview')
  const [market, setMarket] = useState(false)
  const [items, setItems] = useState<Resource[]>([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 改名与打开文件夹：名字以主进程返回的 PackStatus 为准，homePath 只在运行时记录里有。
  const homePath = (pack as ControlledPack & { homePath?: string | null }).homePath ?? ''
  const [packName, setPackName] = useState(pack.name)
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(pack.name)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)
  useEffect(() => { setPackName(pack.name); setNameDraft(pack.name); setRenameError(null) }, [pack.name])
  const cancelRename = () => { setRenaming(false); setNameDraft(packName); setRenameError(null) }
  const commitRename = async () => {
    const name = nameDraft.trim()
    if (!name) { setRenameError('整合包名称不能为空。'); return }
    if (name === packName) { cancelRename(); return }
    setRenameBusy(true); setRenameError(null)
    try {
      const updated = await api.renamePack(pack.id, name)
      setPackName(updated.name)
      setRenaming(false)
      await props.onRefresh()
    } catch (cause) {
      setRenameError(cause instanceof Error ? cause.message : String(cause))
    } finally { setRenameBusy(false) }
  }
  const openFolder = async () => {
    setRenameError(null)
    try { await api.openPath(homePath) }
    catch (cause) { setRenameError(`打开文件夹失败：${cause instanceof Error ? cause.message : String(cause)}`) }
  }
  const [workspace, setWorkspace] = useState(pack.config.workspace ?? '')
  const [launchArgs, setLaunchArgs] = useState((pack.config.launchArgs ?? []).join('\n'))
  const [saved, setSaved] = useState(false)
  // 「启动设置 → DSH 版本」：换版本只改记录里的版本号，数据原地不动。
  const currentVersion = pack.dshVersion ?? ''
  const [targetVersion, setTargetVersion] = useState(() => currentVersion && props.installedDshVersions.includes(currentVersion) ? currentVersion : props.installedDshVersions[0] ?? '')
  const [versionBusy, setVersionBusy] = useState(false)
  const [versionSaved, setVersionSaved] = useState(false)
  const switchVersion = async () => {
    if (!targetVersion || targetVersion === currentVersion || versionBusy || pack.runtime.running) return
    setVersionBusy(true); setVersionSaved(false)
    try {
      if (await props.onUpgradeVersion(targetVersion)) { setVersionSaved(true); await props.onRefresh() }
    } finally { setVersionBusy(false) }
  }
  // 「API」子页：available 是启动器 API 库全量，enabled 是已授予本包的部分。
  const [apiGrants, setApiGrants] = useState<PackApiGrantState | null>(null)
  const [apiLoading, setApiLoading] = useState(false)
  const [apiError, setApiError] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const kind = tab === 'plugins' || tab === 'skills' || tab === 'presets' ? tab : null
  const load = useCallback(async () => {
    const version = ++requestVersion.current
    if (!kind) return
    setLoading(true); setError(null)
    try { const result = await launcherControl(api, 'pack.resources.list', pack.id, { kind }) as { items: Resource[] }; if (version === requestVersion.current) setItems(result.items) }
    catch (cause) { if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (version === requestVersion.current) setLoading(false) }
  }, [api, kind, pack.id])
  useEffect(() => { setItems([]); void load() }, [load])
  const loadApis = useCallback(async () => {
    setApiLoading(true); setApiError(null)
    try { setApiGrants(await api.packApis.get(pack.id)) }
    catch (cause) { setApiError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setApiLoading(false) }
  }, [api, pack.id])
  // 只在这个子页打开时读库：省掉每次开窗都打一次 IPC。
  useEffect(() => { if (tab === 'api') { setApiGrants(null); void loadApis() } }, [tab, loadApis])
  const toggleApi = async (route: string, enabled: boolean) => {
    setWorking(true); setApiError(null)
    try { setApiGrants(await api.packApis.set(pack.id, route, enabled)) }
    // 失败后先重新读一遍（可能别人改过），再把错误留在界面上：loadApis 会清空 apiError。
    catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); await loadApis(); setApiError(message) }
    finally { setWorking(false) }
  }
  const mutate = async (command: string, item: Resource, enabled?: boolean) => {
    setWorking(true); setError(null)
    try {
      await launcherControl(api, command, pack.id, { kind, name: 'packageName' in item ? item.packageName : item.name, enabled })
      await load(); await props.onRefresh()
      return true
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return false }
    finally { setWorking(false) }
  }
  const title = tab === 'plugins' ? '插件' : tab === 'skills' ? '技能' : '预设'
  return <ModalShell titleId="pack-control-title" title={<>整合包配置 · {packName}</>} icon={<Settings2 size={19} />} className="pack-control-modal" onClose={props.onClose} closeDisabled={working || props.busy}>
    <div className="pack-target-banner"><span className="pack-target-dot" />当前操作对象 <strong>{packName}</strong><code>{pack.id}</code></div>
    <div className="pack-header-actions">
      <button type="button" className="secondary-button" disabled={working || renameBusy} onClick={() => { setRenaming(true); setNameDraft(packName); setRenameError(null) }}><Pencil size={14} />改名</button>
      <button type="button" className="secondary-button" disabled={!homePath} title={homePath || '这个整合包没有记录安装目录，无法打开文件夹。'} onClick={() => void openFolder()}><FolderOpen size={14} />打开文件夹</button>
    </div>
    {renaming && <div className="pack-rename-row">
      <input
        aria-label="整合包名称"
        autoFocus
        value={nameDraft}
        disabled={renameBusy}
        onChange={event => { setNameDraft(event.target.value); setRenameError(null) }}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); void commitRename() }
          else if (event.key === 'Escape') { event.preventDefault(); cancelRename() }
        }}
      />
      <button type="button" className="primary-button" disabled={renameBusy} onClick={() => void commitRename()}>{renameBusy ? '正在改名…' : '保存名称'}</button>
      <button type="button" className="secondary-button" disabled={renameBusy} onClick={cancelRename}>取消</button>
    </div>}
    {renameError && <div className="pack-rename-error" role="alert">{renameError}</div>}
    <nav className="pack-config-tabs" aria-label="整合包配置">{([['overview', '概览'], ['settings', '启动设置'], ['api', 'API'], ['plugins', '插件'], ['skills', '技能'], ['presets', '预设'], ['export', '导出与迁移']] as const).map(([key, label]) => <button key={key} disabled={working} aria-current={tab === key ? 'page' : undefined} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setMarket(false); setError(null) }}>{label}</button>)}</nav>
    {error && <div className="pack-error" role="alert">{error}</div>}
    {(tab === 'plugins' || tab === 'skills') && pack.runtime.running && <div className="pack-runtime-notice" role="status">整合包正在运行：这里的开关与安装会在下次启动时生效。</div>}
    {tab === 'overview' && <div className="pack-overview"><div><span>运行状态</span><strong>{pack.runtime.running ? '运行中' : '未运行'}</strong><small>{pack.runtime.url ?? '启动后可以打开工作台'}</small></div><div><span>DSH 版本</span><strong>{pack.dshVersion ?? '未指定'}</strong><small>{pack.native ? '共用家目录，请留意资源影响范围' : '独立的整合包环境'}</small></div><div><span>创建时间</span><strong>{new Date(pack.installedAt).toLocaleDateString('zh-CN')}</strong><small>{pack.description || '为每一种工作保留合适的环境。'}</small></div></div>}
    {tab === 'settings' && <form className="pack-config-form" onSubmit={event => { event.preventDefault(); setSaved(false); setError(null); void props.onSave({ workspace, launchArgs: launchArgs.split('\n').filter(Boolean) }).then(ok => { setSaved(ok); if (!ok) setError('保存设置失败，请检查参数后重试。') }) }}><label>工作区<input value={workspace} onChange={event => { setWorkspace(event.target.value); setSaved(false) }} placeholder="使用默认工作区" /></label><label>附加启动参数 <small>每行一个参数</small><textarea rows={5} value={launchArgs} onChange={event => { setLaunchArgs(event.target.value); setSaved(false) }} /></label><p>端口、管理员权限和自动启动可在首页直接调整。运行中的整合包将在下次启动时应用设置。</p><button className="primary-button" disabled={props.busy} type="submit">{props.busy ? '正在保存…' : '保存设置'}</button>{saved && <span role="status">设置已保存</span>}</form>}
    {tab === 'settings' && <div className="pack-config-form pack-version-form">
      <h3>DSH 版本</h3>
      <p>当前版本：<strong>{currentVersion || '未指定'}</strong></p>
      <label>切换到<select aria-label="目标 DSH 版本" value={targetVersion} disabled={props.busy || versionBusy} onChange={event => { setTargetVersion(event.target.value); setVersionSaved(false) }}>{props.installedDshVersions.length === 0 ? <option value="" disabled>暂无已安装版本</option> : props.installedDshVersions.map(version => <option key={version} value={version}>DSH {version}</option>)}</select></label>
      <button type="button" className="primary-button" disabled={props.busy || versionBusy || pack.runtime.running || targetVersion === '' || targetVersion === currentVersion} onClick={() => void switchVersion()}>{versionBusy ? '正在切换…' : '切换版本'}</button>
      {pack.runtime.running && <p role="status">整合包正在运行，停止后才能切换版本。</p>}
      {versionSaved && <span role="status">已切换到 DSH {targetVersion}，下次启动生效。</span>}
      <p className="settings-hint">只能升级不能降级；切换后插件可能需要重新安装。</p>
    </div>}
    {tab === 'api' && <div className="pack-resource-panel">
      <div className="pack-resource-heading"><h3>API 授权</h3><div><button className="icon-button" aria-label="刷新 API 库" disabled={working || apiLoading} onClick={() => void loadApis()}><RefreshCw size={15} /></button></div></div>
      <p className="settings-hint">勾选后「{packName}」就能使用启动器 API 库里的这个服务；取消勾选立即收回。</p>
      {apiError && <div className="pack-error" role="alert">{apiError}</div>}
      {apiGrants?.error && <div className="pack-error" role="alert">{apiGrants.error}</div>}
      {apiGrants?.restartRequired && <div className="settings-current" role="status"><span>该包正在运行，重启后生效。</span></div>}
      {apiLoading && !apiGrants && <div className="pack-empty"><LoaderCircle size={17} className="spin" />正在读取 API 库…</div>}
      {apiGrants && apiGrants.available.length === 0 && <div className="pack-empty">启动器 API 库还是空的：先到「设置 → API 库」添加服务，再回来按包授予。</div>}
      {apiGrants && apiGrants.available.map(entry => {
        const enabled = apiGrants.enabled.includes(entry.route)
        return <div className="pack-resource-row is-shared" key={entry.route}><div><strong>{entry.displayName}</strong><small>{entry.baseUrl}</small><span className="pack-source shared">来自启动器 API 库 · {entry.route}</span><span className="pack-source">{entry.modelIds.length} 个模型 · {entry.hasApiKey ? '已保存密钥' : '无需鉴权'}</span></div><div><label><input aria-label={'授予 ' + entry.route} type="checkbox" checked={enabled} disabled={working} onChange={event => void toggleApi(entry.route, event.target.checked)} />授予</label></div></div>
      })}
    </div>}
    {kind && <div className="pack-resource-panel">{market ? <><button className="secondary-button" onClick={() => { setMarket(false); void load() }}><ArrowLeft size={14} />返回 {packName} 的{title}列表</button><p className="settings-hint">安装目标：{packName} · 完成后返回此列表</p>{kind === 'plugins' ? <DshMarketView embedded activeProfileName={null} targetPackId={pack.id} onProfileChanged={load} /> : <SkillMarketPanel targetPackId={pack.id} installedSkills={items as InstalledSkill[]} busy={working} busyKey={null} onToggleSkill={(item, enabled) => void mutate('pack.resources.enabled', item, enabled)} onUninstallSkill={item => mutate('pack.resources.remove', item)} onInstalled={() => { void load(); void props.onRefresh() }} onRefresh={() => void load()} refreshLocked={working} />}</> : <><div className="pack-resource-heading"><h3>已安装{title}</h3><div>{kind !== 'presets' && <button className="primary-button" onClick={() => setMarket(true)}><Store size={14} />安装{title}</button>}<button className="icon-button" aria-label="刷新资源" disabled={working} onClick={() => void load()}><RefreshCw size={15} /></button></div></div>{loading && <div className="pack-empty"><LoaderCircle size={17} className="spin" />正在读取…</div>}{!loading && items.length === 0 && !error && <div className="pack-empty">这个整合包还没有安装{title}。</div>}{items.map(item => {
      const name = 'packageName' in item ? item.packageName : item.name
      const shared = item.shared || Boolean(item.sourcePackId)
      const locked = 'locked' in item && item.locked
      return <div className={shared ? "pack-resource-row is-shared" : "pack-resource-row"} key={name}><div><strong>{'displayName' in item ? item.displayName : name}</strong><small>{'description' in item ? item.description : 'path' in item ? item.path : name}</small><span className={shared ? 'pack-source shared' : 'pack-source'}>{shared ? '共享引用 · ' + (item.sourcePackName ?? item.sourcePackId ?? '共享来源') : 'builtin' in item && item.builtin ? '内置资源' : '本包资源'}</span></div><div><label><input aria-label={'启用 ' + name} type="checkbox" checked={item.enabled} disabled={working || locked} onChange={event => void mutate('pack.resources.enabled', item, event.target.checked)} />启用</label>{!locked && <button className="icon-button" aria-label={'移除 ' + name} disabled={working} onClick={() => { if (window.confirm('从「' + packName + '」移除「' + name + '」？')) void mutate('pack.resources.remove', item) }}><Trash2 size={15} /></button>}</div></div>
    })}{kind === 'presets' && <p className="settings-hint">内置预设仍可在全局「预设」页查看；此处管理本包安装的预设。</p>}</>}</div>}
    {tab === 'export' && <div className="pack-export-options"><h3>将「{packName}」带到下一个环境</h3><p>导出沿用现有打包流程，可在下一步选择是否包含凭据与会话。</p><button className="primary-button" onClick={props.onExport}><Download size={15} />导出整合包</button><button className="secondary-button" onClick={props.onImportSessions}>导入会话到此包</button><button className="secondary-button" onClick={props.onCloneVersion}>创建其他版本副本</button></div>}
  </ModalShell>
}
