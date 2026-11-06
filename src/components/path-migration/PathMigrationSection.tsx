import { ArrowRightLeft, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useLauncherApi } from '../../api/client'
import type { MigratablePath, PathMigrationResult } from '../../types'
import './path-migration.css'

/**
 * 设置页「启动器」里的目录迁移入口：选新目录 → 二次确认 → 主进程复制、写设置、旧目录进备份。
 * 二次确认必须把代价说清楚：旧目录会先备份；包还在跑时旧目录先留着，不会被直接删掉。
 */

interface Props {
  kind: MigratablePath
  /** 界面上怎么称呼这条路径：本体安装目录 / DSH_HOME。 */
  label: string
  /** 设置里已保存的当前路径。 */
  current: string
  /** 迁移成功后把新路径同步进设置草稿。 */
  onMigrated?: (result: PathMigrationResult) => void
}

const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback

export function PathMigrationSection({ kind, label, current, onMigrated }: Props) {
  const api = useLauncherApi()
  const [target, setTarget] = useState<string | null>(null)
  const [result, setResult] = useState<PathMigrationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const start = async () => {
    setError(null)
    setResult(null)
    try {
      const chosen = await api.chooseDirectory(kind)
      if (chosen) setTarget(chosen)
    } catch (cause) {
      setError(errorText(cause, '打开目录选择器失败。'))
    }
  }

  const confirm = async () => {
    if (!target || working) return
    setWorking(true)
    setError(null)
    try {
      const paths = api.paths
      if (!paths) throw new Error('当前环境没有提供目录迁移接口。')
      const migrated = await paths.migrate(kind, target)
      setResult(migrated)
      setTarget(null)
      onMigrated?.(migrated)
    } catch (cause) {
      setError(errorText(cause, '迁移失败，旧目录保持不变。'))
    } finally {
      setWorking(false)
    }
  }

  return (
    <div className="path-migration" aria-label={`${label}迁移`}>
      <div className="path-migration-head">
        <span className="path-migration-current" title={current}>当前：{current || '未设置'}</span>
        <button type="button" className="secondary-button compact" disabled={working} onClick={() => void start()}>
          <ArrowRightLeft size={13} />迁移到…
        </button>
      </div>

      {target && (
        <div className="path-migration-confirm" role="group" aria-label={`${label}迁移确认`}>
          <p className="path-migration-target">把「{label}」迁移到 <code>{target}</code>？</p>
          <p className="path-migration-note">旧目录会先打包进备份区，可以随时恢复；如果有整合包正在运行，旧目录会保留到它停止后再清理，不会立刻删除。</p>
          <div className="path-migration-actions">
            <button type="button" className="primary-command" disabled={working} onClick={() => void confirm()}>
              {working ? <LoaderCircle className="spin" size={14} /> : null}{working ? '迁移中…' : '确认迁移'}
            </button>
            <button type="button" className="secondary-button" disabled={working} onClick={() => setTarget(null)}>取消</button>
          </div>
        </div>
      )}

      {error && <p className="path-migration-error" role="alert">{error}</p>}

      {result && (
        <dl className="path-migration-result" aria-label={`${label}迁移结果`}>
          <div><dt>当前位置</dt><dd>{result.current}</dd></div>
          <div><dt>备份编号</dt><dd>{result.backupId ?? '未生成备份（旧目录没有内容）'}</dd></div>
          <div><dt>旧目录</dt><dd>{result.removedOld ? '已删除' : '已保留，停止运行的整合包后再清理'}</dd></div>
          {result.warning && <div className="is-warning"><dt>提醒</dt><dd>{result.warning}</dd></div>}
        </dl>
      )}
    </div>
  )
}
