import { ArrowLeft, Download, LoaderCircle, RefreshCw, Settings2, Store, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useLauncherApi } from '../../api/client'
import { launcherControl, type ControlledPack, type PackControlConfig } from '../../lib/pack-control'
import type { InstalledSkill, InstalledPreset, ManagedPlugin } from '../../types'
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
}
export function PackControlDialog(props: Props) {
  const { pack } = props
  const api = useLauncherApi()
  const [tab, setTab] = useState<'overview' | 'settings' | Kind | 'export'>('overview')
  const [market, setMarket] = useState(false)
  const [items, setItems] = useState<Resource[]>([])
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [workspace, setWorkspace] = useState(pack.config.workspace ?? '')
  const [launchArgs, setLaunchArgs] = useState((pack.config.launchArgs ?? []).join('\n'))
  const [saved, setSaved] = useState(false)
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
  return <ModalShell titleId="pack-control-title" title={<>整合包配置 · {pack.name}</>} icon={<Settings2 size={19} />} className="pack-control-modal" onClose={props.onClose} closeDisabled={working || props.busy}>
    <div className="pack-target-banner"><span className="pack-target-dot" />当前操作对象 <strong>{pack.name}</strong><code>{pack.id}</code></div>
    <nav className="pack-config-tabs" aria-label="整合包配置">{([['overview', '概览'], ['settings', '启动设置'], ['plugins', '插件'], ['skills', '技能'], ['presets', '预设'], ['export', '导出与迁移']] as const).map(([key, label]) => <button key={key} disabled={working} aria-current={tab === key ? 'page' : undefined} className={tab === key ? 'active' : ''} onClick={() => { setTab(key); setMarket(false); setError(null) }}>{label}</button>)}</nav>
    {error && <div className="pack-error" role="alert">{error}</div>}
    {tab === 'overview' && <div className="pack-overview"><div><span>运行状态</span><strong>{pack.runtime.running ? '运行中' : '未运行'}</strong><small>{pack.runtime.url ?? '启动后可以打开工作台'}</small></div><div><span>DSH 版本</span><strong>{pack.dshVersion ?? '未指定'}</strong><small>{pack.native ? '共用家目录，请留意资源影响范围' : '独立的整合包环境'}</small></div><div><span>创建时间</span><strong>{new Date(pack.installedAt).toLocaleDateString('zh-CN')}</strong><small>{pack.description || '为每一种工作保留合适的环境。'}</small></div></div>}
    {tab === 'settings' && <form className="pack-config-form" onSubmit={event => { event.preventDefault(); setSaved(false); setError(null); void props.onSave({ workspace, launchArgs: launchArgs.split('\n').filter(Boolean) }).then(ok => { setSaved(ok); if (!ok) setError('保存设置失败，请检查参数后重试。') }) }}><label>工作区<input value={workspace} onChange={event => { setWorkspace(event.target.value); setSaved(false) }} placeholder="使用默认工作区" /></label><label>附加启动参数 <small>每行一个参数</small><textarea rows={5} value={launchArgs} onChange={event => { setLaunchArgs(event.target.value); setSaved(false) }} /></label><p>端口、管理员权限和自动启动可在首页直接调整。运行中的整合包将在下次启动时应用设置。</p><button className="primary-button" disabled={props.busy} type="submit">{props.busy ? '正在保存…' : '保存设置'}</button>{saved && <span role="status">设置已保存</span>}</form>}
    {kind && <div className="pack-resource-panel">{market ? <><button className="secondary-button" onClick={() => { setMarket(false); void load() }}><ArrowLeft size={14} />返回 {pack.name} 的{title}列表</button><p className="settings-hint">安装目标：{pack.name} · 完成后返回此列表</p>{kind === 'plugins' ? <DshMarketView embedded activeProfileName={null} targetPackId={pack.id} onProfileChanged={load} /> : <SkillMarketPanel targetPackId={pack.id} installedSkills={items as InstalledSkill[]} busy={working} busyKey={null} onToggleSkill={(item, enabled) => void mutate('pack.resources.enabled', item, enabled)} onUninstallSkill={item => mutate('pack.resources.remove', item)} onInstalled={() => { void load(); void props.onRefresh() }} onRefresh={() => void load()} refreshLocked={working} />}</> : <><div className="pack-resource-heading"><h3>已安装{title}</h3><div>{kind !== 'presets' && <button className="primary-button" onClick={() => setMarket(true)}><Store size={14} />安装{title}</button>}<button className="icon-button" aria-label="刷新资源" disabled={working} onClick={() => void load()}><RefreshCw size={15} /></button></div></div>{loading && <div className="pack-empty"><LoaderCircle size={17} className="spin" />正在读取…</div>}{!loading && items.length === 0 && !error && <div className="pack-empty">这个整合包还没有安装{title}。</div>}{items.map(item => {
      const name = 'packageName' in item ? item.packageName : item.name
      const shared = item.shared || Boolean(item.sourcePackId)
      const locked = 'locked' in item && item.locked
      return <div className={shared ? "pack-resource-row is-shared" : "pack-resource-row"} key={name}><div><strong>{'displayName' in item ? item.displayName : name}</strong><small>{'description' in item ? item.description : 'path' in item ? item.path : name}</small><span className={shared ? 'pack-source shared' : 'pack-source'}>{shared ? '共享引用 · ' + (item.sourcePackName ?? item.sourcePackId ?? '共享来源') : 'builtin' in item && item.builtin ? '内置资源' : '本包资源'}</span></div><div><label><input aria-label={'启用 ' + name} type="checkbox" checked={item.enabled} disabled={working || locked} onChange={event => void mutate('pack.resources.enabled', item, event.target.checked)} />启用</label>{!locked && <button className="icon-button" aria-label={'移除 ' + name} disabled={working} onClick={() => { if (window.confirm('从「' + pack.name + '」移除「' + name + '」？')) void mutate('pack.resources.remove', item) }}><Trash2 size={15} /></button>}</div></div>
    })}{kind === 'presets' && <p className="settings-hint">内置预设仍可在全局「预设」页查看；此处管理本包安装的预设。</p>}</>}</div>}
    {tab === 'export' && <div className="pack-export-options"><h3>将「{pack.name}」带到下一个环境</h3><p>导出沿用现有打包流程，可在下一步选择是否包含凭据与会话。</p><button className="primary-button" onClick={props.onExport}><Download size={15} />导出整合包</button><button className="secondary-button" onClick={props.onImportSessions}>导入会话到此包</button><button className="secondary-button" onClick={props.onCloneVersion}>创建其他版本副本</button></div>}
  </ModalShell>
}
