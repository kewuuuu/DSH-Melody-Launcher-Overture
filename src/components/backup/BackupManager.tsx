import { Archive, FolderOpen, LoaderCircle, Lock, LockOpen, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useLauncherApi } from '../../api/client'
import type { BackupEntry, BackupOpKind, BackupOverview } from '../../types'
import './backup-manager.css'

/**
 * 设置页「备份管理」：删除/迁移留下的文件都打包收在这里。
 * 恢复与删除都走两步确认（会覆盖或丢东西，不可逆）；锁定只影响容量清理。
 */

/** 备份来源在界面上的说法；新增 op 时这里必须同步，否则列里只剩英文。 */
export const BACKUP_OP_LABELS: Record<BackupOpKind, string> = {
  'pack.delete': '整合包删除',
  'plugin.delete': '插件删除',
  'skill.delete': 'Skill 删除',
  'preset.delete': '预设删除',
  'resource.unlink': '资源移除',
  'version.delete': '版本删除',
  'path.migrate': '路径迁移',
  manual: '手动备份',
}

export type BackupLimitUnit = 'MB' | 'GB'

export const BACKUP_LIMIT_UNIT_BYTES: Record<BackupLimitUnit, number> = {
  MB: 1024 * 1024,
  GB: 1024 * 1024 * 1024,
}

/** 字节数转人读文本；只用于展示，不参与计算。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const digits = unit === 0 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0
  return `${value.toFixed(digits)} ${units[unit]}`
}

/** 固定成 YYYY-MM-DD HH:mm，避免 toLocaleString 随系统区域变化。 */
export function formatBackupTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 上限输入换算成字节；非法输入返回 null，0 表示不限制。 */
export function limitInputToBytes(value: string, unit: BackupLimitUnit): number | null {
  const text = value.trim()
  if (text === '') return null
  const amount = Number(text)
  if (!Number.isFinite(amount) || amount < 0) return null
  if (amount === 0) return 0
  const bytes = Math.round(amount * BACKUP_LIMIT_UNIT_BYTES[unit])
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null
}

/** 已保存的上限回填到输入框：整 GB 用 GB，其余用 MB。 */
function limitToInput(bytes: number): { value: string; unit: BackupLimitUnit } {
  if (!Number.isFinite(bytes) || bytes <= 0) return { value: '0', unit: 'GB' }
  if (bytes % BACKUP_LIMIT_UNIT_BYTES.GB === 0) return { value: String(bytes / BACKUP_LIMIT_UNIT_BYTES.GB), unit: 'GB' }
  return { value: String(Math.round(bytes / BACKUP_LIMIT_UNIT_BYTES.MB)), unit: 'MB' }
}

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback

interface Props {
  /** 当前整合包的安装目录；「把当前整合包备份一份」备份的就是它。 */
  packDir: string
  /** 当前整合包名，随备份一起记录，恢复时能看出属于哪个包。 */
  packId: string
}

export function BackupManager({ packDir, packId }: Props) {
  const api = useLauncherApi()
  // null = 还没读到；读到之后所有操作都用返回值整份替换，省一次往返。
  const [overview, setOverview] = useState<BackupOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [working, setWorking] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<{ id: string; action: 'restore' | 'remove' } | null>(null)
  const [limitOpen, setLimitOpen] = useState(false)
  const [limitValue, setLimitValue] = useState('0')
  const [limitUnit, setLimitUnit] = useState<BackupLimitUnit>('GB')

  const load = useCallback(async () => {
    const backups = api.backups
    if (!backups) { setError('当前环境没有提供备份接口。'); return }
    setLoading(true)
    setError(null)
    try { setOverview(await backups.list()) }
    catch (cause) { setError(errorText(cause, '读取备份列表失败，请稍后重试。')) }
    finally { setLoading(false) }
  }, [api])

  useEffect(() => { void load() }, [load])

  /** 统一处理一次动作：成功用返回值刷新清单，失败原样展示主进程给的错误。 */
  const run = async (key: string, action: () => Promise<BackupOverview>, fallback: string): Promise<boolean> => {
    setWorking(key)
    setError(null)
    try {
      setOverview(await action())
      setConfirming(null)
      return true
    } catch (cause) {
      setError(errorText(cause, fallback))
      return false
    } finally { setWorking(null) }
  }

  const toggleLock = (entry: BackupEntry) => {
    const backups = api.backups
    if (!backups) return
    void run(`lock:${entry.id}`, () => backups.setLocked(entry.id, !entry.locked), '切换锁定状态失败。')
  }
  const confirmAction = (entry: BackupEntry) => {
    const backups = api.backups
    if (!backups || !confirming) return
    void run(
      `${confirming.action}:${entry.id}`,
      () => (confirming.action === 'restore' ? backups.restore(entry.id) : backups.remove(entry.id)),
      confirming.action === 'restore' ? '恢复备份失败，旧文件保持不变。' : '删除备份失败。',
    )
  }
  const saveLimit = async () => {
    const backups = api.backups
    if (!backups) return
    const bytes = limitInputToBytes(limitValue, limitUnit)
    if (bytes === null) {
      setError('容量上限要填非负数字：填 0 表示不限制。')
      return
    }
    if (await run('limit', () => backups.setLimit(bytes), '保存容量上限失败。')) setLimitOpen(false)
  }
  const createManual = () => {
    const backups = api.backups
    if (!backups) return
    void run('create', () => backups.create({
      paths: packDir ? [packDir] : [],
      label: `手动备份 · ${packId}`,
      op: 'manual',
      packId,
    }), '创建备份失败，请确认整合包目录是否存在。')
  }

  const openLimitEditor = () => {
    const next = limitToInput(overview?.limitBytes ?? 0)
    setLimitValue(next.value)
    setLimitUnit(next.unit)
    setLimitOpen(open => !open)
  }

  const entries = overview?.entries ?? []

  return (
    <section className="settings-panel settings-home-panel backup-panel" aria-label="备份管理">
      <div className="settings-panel-heading">
        <div className="settings-panel-title"><span className="settings-group-icon"><Archive size={16} /></span><span>备份管理</span></div>
        <button type="button" className="secondary-button compact" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} />{loading ? '读取中…' : '刷新'}
        </button>
      </div>
      <p className="settings-hint">删除、迁移前的文件都会打包放在这里，可以随时恢复；锁定后不参与容量清理。</p>

      {error && <div className="error-banner" role="alert">{error}</div>}

      <div className="backup-usage">
        <span className="backup-usage-value">
          {overview
            ? `已用 ${formatBytes(overview.totalBytes)} / 上限 ${overview.limitBytes > 0 ? formatBytes(overview.limitBytes) : '不限制'}`
            : '正在读取备份区…'}
        </span>
        <button type="button" className="secondary-button compact" onClick={openLimitEditor}>
          {limitOpen ? '收起上限设置' : '设置上限'}
        </button>
        {overview && <span className="backup-usage-directory" title={overview.directory}>{overview.directory}</span>}
      </div>

      {limitOpen && (
        <div className="backup-limit-form" role="group" aria-label="备份容量上限">
          <label className="backup-limit-field">
            容量上限
            <input aria-label="备份上限数值" type="number" min={0} step={1} value={limitValue} onChange={event => setLimitValue(event.target.value)} />
          </label>
          <label className="backup-limit-field">
            单位
            <select aria-label="备份上限单位" value={limitUnit} onChange={event => setLimitUnit(event.target.value as BackupLimitUnit)}>
              <option value="MB">MB</option>
              <option value="GB">GB</option>
            </select>
          </label>
          <span className="backup-limit-hint">填 0 表示不限制；超出后按最久优先清理未锁定备份。</span>
          <button type="button" className="secondary-button" onClick={() => setLimitOpen(false)}>取消</button>
          <button type="button" className="primary-command" disabled={working === 'limit'} onClick={() => void saveLimit()}>保存上限</button>
        </div>
      )}

      {entries.length === 0 ? (
        <p className="backup-empty">{overview ? '备份区还是空的。删除插件、迁移目录时都会自动在这里留一份。' : '正在读取备份列表…'}</p>
      ) : (
        <div className="backup-table-wrap">
          <table className="backup-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>名称</th>
                <th>大小</th>
                <th>锁定</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(entry => (
                <tr key={entry.id} className={entry.locked ? 'is-locked' : ''}>
                  <td className="backup-time">{formatBackupTime(entry.createdAt)}</td>
                  <td><span className={`backup-op ${entry.op === 'path.migrate' ? 'is-migration' : ''}`}>{BACKUP_OP_LABELS[entry.op]}</span></td>
                  <td className="backup-name">
                    <strong>{entry.label}</strong>
                    <small>{entry.fileCount} 个文件{entry.restoredAt ? ` · 已恢复于 ${formatBackupTime(entry.restoredAt)}` : ''}</small>
                  </td>
                  <td className="backup-size">{formatBytes(entry.sizeBytes)}</td>
                  <td className={`backup-lock ${entry.locked ? 'is-locked' : ''}`}>{entry.locked ? '已锁定' : '未锁定'}</td>
                  <td>
                    {confirming?.id === entry.id ? (
                      <div className="backup-row-actions">
                        <span className="backup-confirm-text">
                          {confirming.action === 'restore' ? '恢复会覆盖当前文件，继续？' : '删除后无法找回，继续？'}
                        </span>
                        <button
                          type="button"
                          className={confirming.action === 'remove' ? 'danger-button compact' : 'secondary-button compact'}
                          disabled={working !== null}
                          onClick={() => confirmAction(entry)}
                        >
                          {confirming.action === 'restore' ? '确认恢复' : '确认删除'}
                        </button>
                        <button type="button" className="secondary-button compact" onClick={() => setConfirming(null)}>取消</button>
                      </div>
                    ) : (
                      <div className="backup-row-actions">
                        <button type="button" className="secondary-button compact" onClick={() => setConfirming({ id: entry.id, action: 'restore' })}>
                          <RotateCcw size={12} />恢复
                        </button>
                        <button type="button" className="secondary-button compact" onClick={() => setConfirming({ id: entry.id, action: 'remove' })}>
                          <Trash2 size={12} />删除
                        </button>
                        <button type="button" className="secondary-button compact" disabled={working !== null} onClick={() => toggleLock(entry)}>
                          {entry.locked ? <LockOpen size={12} /> : <Lock size={12} />}{entry.locked ? '解锁' : '锁定'}
                        </button>
                        <button type="button" className="secondary-button compact" onClick={() => { const backups = api.backups; if (backups) void backups.reveal(entry.id) }}>
                          <FolderOpen size={12} />打开所在目录
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="backup-footer">
        <button type="button" className="primary-command" disabled={!packDir || working === 'create'} onClick={createManual}>
          {working === 'create' ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />}把当前整合包备份一份
        </button>
        <small>{packDir ? `备份范围：${packDir}` : '还没配置 DSH_HOME，无法确定整合包目录。'}</small>
      </div>
    </section>
  )
}
