import { Download, FolderOpen, LoaderCircle, ScanSearch, Trash2, TriangleAlert } from 'lucide-react'
import { useCallback, useState } from 'react'
import { useLauncherApi } from '../../api/client'
import { formatBytes } from '../../lib/format'
import type { UninstallItem, UninstallPlan } from '../../types'
import './uninstall-panel.css'

/**
 * 设置页「清理与卸载」区块。
 * 核心理念：只删这个版本自己创建的东西——程序目录与本版数据目录。
 * 旧版启动器数据（%APPDATA%\dsh-launcher）与 DSH 家目录（~/.dsh）由主进程标成 keep，
 * 界面只负责照原样展示每条的原因；两枚卸载按钮都要两步确认，第一次点击只是把确认行展开。
 *
 * 扫描只由用户点出来：plan() 要读完程序目录与本版数据目录里的每个文件（24 万个文件约十几秒），
 * 挂载时静默扫描会把整个设置页卡住，所以首屏只给一句说明和「扫描本版内容」。
 */

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback

/** 脚本所在的文件夹：主进程给的是 Windows 路径，顺带兼容 /。 */
function folderOf(target: string): string {
  const index = Math.max(target.lastIndexOf('\\'), target.lastIndexOf('/'))
  return index > 0 ? target.slice(0, index) : target
}

function UninstallRow({ item }: { item: UninstallItem }) {
  return (
    <li className={`uninstall-row is-${item.action}`}>
      <div className="uninstall-row-main">
        <strong>{item.label}</strong>
        <span>{formatBytes(item.sizeBytes)}</span>
      </div>
      <code>{item.path}</code>
      <p className="uninstall-row-meta">
        {item.kind === 'registry' ? `注册表项 · ${item.fileCount} 个键` : `${item.fileCount} 个文件`}
      </p>
      {item.reason && <p className="uninstall-row-reason">{item.reason}</p>}
    </li>
  )
}

function PlanGroup({ title, items, empty }: { title: string; items: UninstallItem[]; empty: string }) {
  return (
    <div className="uninstall-group">
      <div className="uninstall-group-title"><span>{title}</span><span>{items.length} 项</span></div>
      {items.length === 0
        ? <p className="uninstall-empty">{empty}</p>
        : <ul className="uninstall-list">{items.map(item => <UninstallRow key={item.id} item={item} />)}</ul>}
    </div>
  )
}

export function UninstallPanel() {
  const api = useLauncherApi()
  // plan 只在组件 state 里：离开设置页再回来不保留，也就不写全局缓存。
  const [plan, setPlan] = useState<UninstallPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState<'export' | 'confirm' | null>(null)
  const [pending, setPending] = useState<'keep' | 'data' | null>(null)
  const [scriptPath, setScriptPath] = useState<string | null>(null)
  const [started, setStarted] = useState(false)

  /** 只有用户点「扫描本版内容 / 重新扫描 / 重试」才扫描；已有 plan 时不自动重扫。 */
  const scan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      const uninstall = api.uninstall
      // 老版本接口没有 uninstall：宁可显示一句提示，也不要让整页设置跟着抛错。
      if (!uninstall || typeof uninstall.plan !== 'function') {
        setError('当前接口没有卸载能力，请升级启动器。')
        return
      }
      setPlan(await uninstall.plan())
    } catch (cause) {
      setError(errorText(cause, '读取卸载计划失败。'))
    } finally {
      setScanning(false)
    }
  }, [api])

  const exportScript = async () => {
    if (busy || started) return
    setBusy('export')
    setError(null)
    try {
      const result = await api.uninstall.exportScript()
      // 用户在目录选择框里取消：返回 null，界面状态一个字都不动。
      if (result) setScriptPath(result.scriptPath)
    } catch (cause) {
      setError(errorText(cause, '导出卸载脚本失败。'))
    } finally {
      setBusy(null)
    }
  }

  const run = async (deleteData: boolean) => {
    if (busy || started) return
    setBusy('confirm')
    setError(null)
    try {
      const result = await api.uninstall.run({ deleteData })
      setPending(null)
      if (result.started) setStarted(true)
      else setError('卸载没有启动，什么也没有删除。可以重试，或者改用「生成卸载脚本」手动执行。')
    } catch (cause) {
      setPending(null)
      setError(errorText(cause, '启动卸载失败。'))
    } finally {
      setBusy(null)
    }
  }

  const deleteItems = plan ? plan.items.filter(item => item.action === 'delete') : []
  const keepItems = plan ? plan.items.filter(item => item.action === 'keep') : []
  const disabled = busy !== null || started || scanning
  const scanDisabled = scanning || busy !== null || started

  return (
    <section className="settings-panel" aria-label="清理与卸载" aria-busy={busy !== null || scanning}>
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><Trash2 size={17} /><span>清理与卸载</span></div>
      </div>
      <div className="settings-hint">只删这个版本自己创建的东西：程序目录与本版数据目录。旧版启动器数据（%APPDATA%\dsh-launcher）和 DSH 家目录（~/.dsh）一律保留，下面的计划里写明每一条的原因。</div>

      <div className="uninstall-scan">
        <p className="uninstall-scan-hint">
          {plan
            ? '下面是上次扫描的结果。这期间装过或删过东西的话，先重新扫描一次再动手。'
            : '扫描要读完程序目录和本版数据目录里的每个文件（24 万个文件大约十几秒），所以不会自动开始；点右边的按钮只扫这一次。'}
        </p>
        <button
          type="button"
          className="secondary-button"
          disabled={scanDisabled}
          aria-busy={scanning}
          onClick={() => { void scan() }}
        >
          {scanning ? <LoaderCircle className="spin" size={14} /> : <ScanSearch size={14} />}
          {scanning ? '正在扫描…' : plan ? '重新扫描' : '扫描本版内容'}
        </button>
      </div>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button type="button" disabled={scanDisabled} onClick={() => { void scan() }}>重试</button>
        </div>
      )}

      {plan && (
        <>
          {plan.warnings.length > 0 && (
            <ul className="uninstall-warnings" role="status">
              {plan.warnings.map(warning => <li key={warning}>{warning}</li>)}
            </ul>
          )}

          <PlanGroup title="将被删除" items={deleteItems} empty="这个版本没有创建需要删除的内容。" />
          <PlanGroup title="保留" items={keepItems} empty="没有额外保留的内容。" />

          <div className="uninstall-summary">
            <div><span>将删除</span><strong>{formatBytes(plan.deleteBytes)}</strong></div>
            <div><span>保留</span><strong>{formatBytes(plan.keepBytes)}</strong></div>
          </div>

          <div className="uninstall-actions">
            <button type="button" className="secondary-button" disabled={disabled} aria-busy={busy === 'export'} onClick={() => { void exportScript() }}>
              {busy === 'export' ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}生成卸载脚本
            </button>
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => setPending(pending === 'keep' ? null : 'keep')}>
              <Trash2 size={14} />立即卸载（保留数据）
            </button>
            <button type="button" className="danger-button" disabled={disabled} onClick={() => setPending(pending === 'data' ? null : 'data')}>
              <Trash2 size={14} />立即卸载并删除本版数据
            </button>
          </div>

          {pending && (
            <div className="uninstall-confirm" role="group" aria-label="卸载确认">
              <TriangleAlert size={14} />
              <span>将删除 <strong>{formatBytes(plan.deleteBytes)}</strong>{pending === 'data' ? '，其中包含本版数据目录' : '，数据目录保留'}。删除不可恢复。</span>
              <button type="button" className="danger-button" disabled={busy === 'confirm'} aria-busy={busy === 'confirm'} onClick={() => { void run(pending === 'data') }}>
                {busy === 'confirm' ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />}确认删除
              </button>
              <button type="button" className="secondary-button" disabled={busy === 'confirm'} onClick={() => setPending(null)}>取消</button>
            </div>
          )}

          {scriptPath && (
            <div className="uninstall-script" role="status">
              <code>{scriptPath}</code>
              <button type="button" className="secondary-button" onClick={() => { void api.openPath?.(folderOf(scriptPath)) }}>
                <FolderOpen size={14} />打开所在文件夹
              </button>
            </div>
          )}

          {started && (
            <div className="uninstall-started" role="status"><LoaderCircle className="spin" size={14} /><span>正在退出，卸载脚本会在后台完成删除。</span></div>
          )}
        </>
      )}
    </section>
  )
}
