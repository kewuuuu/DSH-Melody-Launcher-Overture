import { ArrowDown, ArrowUp, ExternalLink, LoaderCircle, Pin, Play, RefreshCw, Settings2, Square, Trash2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { usePackControl } from '../hooks/use-pack-control'
import { sortPacks, type ControlledPack, type PackControlConfig, type PackSort } from '../lib/pack-control'
import { PackControlDialog } from './dialogs/PackControlDialog'
import './pack-dashboard.css'

interface Props {
  /** 本机已安装的 DSH 版本：新建整合包时要选一个。 */
  installedDshVersions: string[]
  /** 新建整合包（名称 + DSH 版本）；成功返回 true，错误由调用方提示。 */
  onCreate: (name: string, dshVersion: string) => Promise<boolean>
  onImport: () => void
  onExport: (id: string) => void
  onImportSessions: (id: string) => void
  onCloneVersion: (id: string) => void
  /** 删除整合包（后端负责先备份进备份区）；成功返回 true。 */
  onRemove: (id: string) => Promise<boolean>
  /** 原地切换这个整合包认的 DSH 版本（只能升不能降）；成功返回 true。 */
  onUpgradeVersion: (id: string, version: string) => Promise<boolean>
  /** 一个版本都没装时的引导：去「DSH版本」页下载。 */
  onOpenVersions: () => void
}

/**
 * 「整合包」页的控制面板：运行操作 / 端口 / 管理员 / 配置 / 自启全在这张表里。
 * 顶部工具栏的「新建整合包」「导入整合包」复用设置面板那套调用（packsCreate / packsImport），
 * 表单骨架沿用全局的 .settings-pack-create 样式，不另造一套。
 */
export function PackDashboard(props: Props) {
  const control = usePackControl()
  const [sort, setSort] = useState<PackSort>('name')
  const [descending, setDescending] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newVersion, setNewVersion] = useState('')
  const [creatingBusy, setCreatingBusy] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const packs = useMemo(() => sortPacks(control.packs.filter(pack => pack.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())), sort, descending), [control.packs, query, sort, descending])
  const selectedPack = control.packs.find(pack => pack.id === selected)
  /** 不是本启动器托管的运行实例（启动器退出、提权监督进程消失后留下的进程）：单独计数，不算进「正在运行」。 */
  const externalCount = control.packs.filter(pack => pack.externalRuntime).length
  const patch = (pack: ControlledPack, values: Partial<PackControlConfig>) => control.run('pack.config.set', pack.id, values)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const remove = async (pack: ControlledPack) => {
    if (removing) return
    setRemoving(pack.id)
    try {
      // 运行中的包先停：后端删除前会检查，这里替用户把「先停止」那一步做掉。
      if (pack.runtime.running && !await control.run('pack.stop', pack.id)) return
      if (!await props.onRemove(pack.id)) return
      setConfirmRemove(null)
    } finally { setRemoving(null) }
  }
  const openCreate = () => {
    setCreating(true)
    setNewVersion(current => current || props.installedDshVersions[0] || '')
    requestAnimationFrame(() => nameInputRef.current?.focus())
  }
  const submitCreate = async () => {
    const name = newName.trim()
    if (name === '' || newVersion === '' || creatingBusy) return
    setCreatingBusy(true)
    try {
      if (!await props.onCreate(name, newVersion)) return
      setCreating(false)
      setNewName('')
      await control.refresh()
    } finally { setCreatingBusy(false) }
  }
  return <section className="pack-dashboard">
    <header className="pack-dashboard-heading"><div><span className="pack-eyebrow">DSH启动器 · KEWU</span><h1>整合包 <span>{control.packs.length}</span></h1><p>各自独立，随时启动。让工作按你的节奏展开。</p></div><div className="pack-toolbar"><button type="button" className="secondary-button" onClick={openCreate}>{creating ? '收起新建' : '新建整合包'}</button><button type="button" className="secondary-button" onClick={props.onImport}>导入整合包</button></div></header>
    {creating && <div className="settings-pack-create pack-create">
      <input
        ref={nameInputRef}
        className="settings-pack-name-input"
        aria-label="整合包名称"
        placeholder="整合包名称（字母/数字/-_）"
        value={newName}
        onChange={event => setNewName(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') void submitCreate() }}
      />
      <select className="settings-pack-version-select" aria-label="DSH 版本" value={newVersion} onChange={event => setNewVersion(event.target.value)}>
        {props.installedDshVersions.length === 0
          ? <option value="" disabled>暂无已安装版本</option>
          : props.installedDshVersions.map(version => <option key={version} value={version}>DSH {version}</option>)}
      </select>
      <button type="button" className="primary-button" disabled={creatingBusy || newName.trim() === '' || newVersion === ''} onClick={() => void submitCreate()}>创建</button>
      <button type="button" className="secondary-button" onClick={() => setCreating(false)}>取消</button>
    </div>}
    {creating && props.installedDshVersions.length === 0 && <div className="settings-pack-create-hint"><span>还没有已安装的 DSH 版本，先去下载一个，再创建整合包。</span><button type="button" className="secondary-button" onClick={props.onOpenVersions}>去下载版本</button></div>}
    <div className="pack-list-toolbar"><input aria-label="搜索整合包" placeholder="搜索整合包…" value={query} onChange={event => setQuery(event.target.value)} /><div><label>排序 <select aria-label="整合包排序" value={sort} onChange={event => setSort(event.target.value as PackSort)}><option value="name">名称</option><option value="created">创建时间</option><option value="port">端口</option></select></label><button className="icon-button" aria-label={descending ? '切换为升序' : '切换为降序'} title={descending ? '当前降序' : '当前升序'} onClick={() => setDescending(!descending)}>{descending ? <ArrowDown size={16} /> : <ArrowUp size={16} />}</button><button className="icon-button" aria-label="刷新整合包" onClick={() => void control.refresh()}><RefreshCw size={15} /></button></div></div>
    {control.error && <div role="alert" className="pack-error">{control.error}<button onClick={() => void control.refresh()}>重试</button></div>}
    <div className="pack-table-scroll"><table className="pack-table"><thead><tr><th><Pin size={13} aria-label="置顶" /></th><th>整合包名称</th><th>端口</th><th>运行操作</th><th>管理员</th><th>配置</th><th>自启</th><th>删除</th></tr></thead><tbody>
      {packs.map(pack => {
        const busy = control.busy.includes(pack.id)
        const external = pack.externalRuntime ?? null
        return <tr key={pack.id} className={pack.config.pinnedAt ? 'pack-pinned' : undefined}>
          <td><button className={'icon-button ' + (pack.config.pinnedAt ? 'is-pinned' : '')} title={pack.config.pinnedAt ? '取消置顶' : '置顶'} aria-label={(pack.config.pinnedAt ? '取消置顶 ' : '置顶 ') + pack.name} aria-pressed={Boolean(pack.config.pinnedAt)} disabled={busy} onClick={() => void patch(pack, { pinnedAt: pack.config.pinnedAt ? null : new Date().toISOString() })}><Pin size={15} /></button></td>
          <td><button className="pack-name" onClick={() => setSelected(pack.id)}>{pack.name}</button><small><i className={pack.runtime.running ? 'running' : external ? 'external' : ''} />{busy ? '正在处理' : pack.runtime.running ? '运行中' : external ? '外部运行中' : '未运行'} · DSH {pack.dshVersion ?? '未指定'}{pack.native ? ' · 共用家目录' : ''}</small></td>
          <td><PortEditor key={pack.id + ':' + pack.config.port + ':' + pack.config.portMode} pack={pack} disabled={busy} onSave={values => void patch(pack, values)} /></td>
          <td><div className="pack-row-actions">{busy ? <LoaderCircle size={16} className="spin" /> : pack.runtime.running ? <><button className="secondary-button" onClick={() => void control.run('pack.stop', pack.id)} title="停止"><Square size={13} />停止</button><button className="icon-button" aria-label={'重启 ' + pack.name} onClick={() => void control.run('pack.restart', pack.id)}><RefreshCw size={15} /></button><button className="icon-button" aria-label={'打开网页 ' + pack.name} disabled={!pack.runtime.url} onClick={() => void control.run('pack.openWeb', pack.id)}><ExternalLink size={15} /></button></> : <button className="primary-button" disabled={external !== null} title={external ? '先停止未托管的实例' : '启动'} onClick={() => void control.run('pack.start', pack.id)}><Play size={13} />启动</button>}</div>
            {/* 未托管实例不在内存里的运行控制器里，只能就地认领再停：给它单独一行状态和一个停止按钮。 */}
            {external && !busy && <div className="pack-external">
              <span className="pack-external-state" title="不是本启动器托管的实例，停止会中断它上面正在进行的对话">外部运行中 · PID {external.pid}{external.port === null ? '' : ' · :' + external.port}</span>
              <button type="button" className="secondary-button" aria-label={'停止未托管实例 ' + pack.name} title="不是本启动器托管的实例，停止会中断它上面正在进行的对话" onClick={() => void control.run('pack.stop', pack.id, undefined, { inlineError: true })}><Square size={13} />停止</button>
            </div>}
            {!busy && control.inlineErrors[pack.id] && <p className="pack-external-error" role="alert">{control.inlineErrors[pack.id]}</p>}
          </td>
          <td><input type="checkbox" aria-label={'以管理员运行 ' + pack.name} checked={pack.config.runAsAdmin} disabled={busy} onChange={event => void patch(pack, { runAsAdmin: event.target.checked })} /></td>
          <td><button className="icon-button" aria-label={'配置 ' + pack.name} onClick={() => setSelected(pack.id)}><Settings2 size={17} /></button></td>
          <td><input type="checkbox" aria-label={'自动启动 ' + pack.name} checked={pack.config.autoStart} disabled={busy} onChange={event => void patch(pack, { autoStart: event.target.checked })} /></td>
          <td><div className="pack-row-actions">{confirmRemove === pack.id
            ? <><button className="danger-button" disabled={removing === pack.id} onClick={() => void remove(pack)}>{removing === pack.id ? '删除中…' : '确认删除'}</button><button className="secondary-button" disabled={removing === pack.id} onClick={() => setConfirmRemove(null)}>取消</button></>
            : <button className="icon-button" aria-label={'删除 ' + pack.name} title="删除整合包（先停止运行，再整份备份进备份区）" disabled={busy} onClick={() => setConfirmRemove(pack.id)}><Trash2 size={15} /></button>}</div></td>
        </tr>
      })}
    </tbody></table></div>
    {control.loading && <div className="pack-empty"><LoaderCircle className="spin" size={18} />正在读取整合包…</div>}
    {!control.loading && !control.error && packs.length === 0 && <div className="pack-empty">{query ? '没有匹配的整合包' : '还没有整合包。新建一个，或导入一个。'}</div>}
    <footer className="pack-dashboard-footer"><span>{control.packs.filter(pack => pack.runtime.running).length} 个正在运行</span>{externalCount > 0 && <span className="pack-external-count">另有 {externalCount} 个未托管实例在运行</span>}<span>置顶按时间排列 · 启动参数在下次启动时生效</span></footer>
    {selectedPack && <PackControlDialog key={selectedPack.id} pack={selectedPack} busy={control.busy.includes(selectedPack.id)} onClose={() => setSelected(null)} onSave={values => patch(selectedPack, values)} onRefresh={control.refresh} onExport={() => props.onExport(selectedPack.id)} onImportSessions={() => props.onImportSessions(selectedPack.id)} onCloneVersion={() => props.onCloneVersion(selectedPack.id)} installedDshVersions={props.installedDshVersions} onUpgradeVersion={version => props.onUpgradeVersion(selectedPack.id, version)} />}
  </section>
}
function PortEditor({ pack, disabled, onSave }: { pack: ControlledPack; disabled: boolean; onSave: (patch: Partial<PackControlConfig>) => void }) {
  const [port, setPort] = useState(String(pack.config.port))
  const [invalid, setInvalid] = useState(false)
  const save = () => {
    const value = Number(port)
    if (!Number.isInteger(value) || value < 1 || value > 65535) { setInvalid(true); return }
    setInvalid(false)
    if (value !== pack.config.port) onSave({ port: value })
  }
  return <div className="pack-port"><select aria-label={'端口模式 ' + pack.name} value={pack.config.portMode} disabled={disabled} onChange={event => onSave({ portMode: event.target.value as 'auto' | 'fixed' })}><option value="auto">自动</option><option value="fixed">固定</option></select>{pack.config.portMode === 'fixed' ? <input aria-label={'固定端口 ' + pack.name} aria-invalid={invalid} title={invalid ? '请输入 1–65535 的端口' : '下次启动时使用'} type="number" min="1" max="65535" value={port} disabled={disabled} onChange={event => setPort(event.target.value)} onBlur={save} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /> : <span>{pack.runtime.port ?? '—'}</span>}</div>
}
