import { Check, ExternalLink, LoaderCircle, RefreshCw, X } from 'lucide-react'
import { useLauncherApi } from '../../api/client'
import { formatBytes } from '../../lib/format'
import type { LauncherUpdateProgress, LauncherUpdateStatus } from '../../types'

/** 启动器自更新：显示检测结果、下载进度，下完提示一键应用并重启。 */

interface UpdateDialogProps {
  status: LauncherUpdateStatus
  progress: LauncherUpdateProgress | null
  busy: boolean
  onDownload: () => void
  onApply: () => void
  onClose: () => void
}

export function UpdateDialog({ status, progress, busy, onDownload, onApply, onClose }: UpdateDialogProps) {
  const api = useLauncherApi()
  const transfer = progress?.phase === 'downloading' ? progress : null
  const total = transfer?.totalBytes || status.assetSize
  const saving = transfer?.downloadedBytes != null && total != null && total > 0 && transfer.downloadedBytes === total
  const percent = saving ? 100 : transfer && total != null && total > 0 ? Math.min(99, transfer.percent) : null
  const downloadLabel = saving ? '正在确认并保存安装包…' : transfer ? '正在下载新版本' : '正在准备下载…'

  const openRelease = () => { if (status.releaseUrl) void api.openExternal(status.releaseUrl) }

  const downloading = status.state === 'downloading' || (status.state === 'update-available' && transfer !== null)
  const ready = status.state === 'downloaded'
  const failed = status.state === 'error'
  // 版本号相同（或本地更新）也是 up-to-date：这时候不能给「下载更新」，否则点了只会报「没有可下载的更新」。
  const upToDate = status.state === 'up-to-date'

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <header>
          <div>
            <h2 id="update-title">
              {failed ? '更新失败' : ready ? '更新已就绪' : upToDate ? '启动器已是最新版本' : `发现启动器新版本 v${status.remoteVersion ?? ''}`}
            </h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭更新窗口"><X size={18} /></button>
        </header>
        <div className="modal-content">
          <dl className="update-meta">
            <div><dt>本地版本</dt><dd>{status.localVersion ?? '未知'}</dd></div>
            <div><dt>最新版本</dt><dd>{status.remoteVersion ?? '未知'}</dd></div>
            {status.assetSize != null && status.assetSize > 0 && <div><dt>安装包大小</dt><dd>{formatBytes(status.assetSize)}</dd></div>}
          </dl>

          {status.releaseNotes && (
            <div className="update-notes">
              <h3>更新内容</h3>
              <pre>{status.releaseNotes}</pre>
            </div>
          )}

          {failed ? (
            <p className="update-message">{status.message}</p>
          ) : downloading ? (
            <div className="install-progress update-download-progress">
              <div><LoaderCircle className="spin" size={14} /><span>{downloadLabel}</span><strong>{percent !== null ? `${percent}%` : '—'}</strong></div>
              {progress?.downloadedBytes != null && (
                <small className="install-progress-size">
                  已下载 {formatBytes(progress.downloadedBytes)}
                  {progress?.totalBytes != null && ` / ${formatBytes(progress.totalBytes)}`}
                </small>
              )}
              <div className="progress-track" role="progressbar" aria-label="下载启动器更新" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
                <span style={percent !== null ? { width: `${percent}%` } : undefined} />
              </div>
            </div>
          ) : (
            <p className="update-message">
              {ready ? '新版本已下载完成，点击下方按钮应用更新。启动器会关闭、原位替换并自动重启。' : status.message}
            </p>
          )}

          <button type="button" className="text-link update-release-link" onClick={openRelease} disabled={!status.releaseUrl}>
            <ExternalLink size={13} />前往 Release 页查看
          </button>
        </div>
        <footer>
          {upToDate ? (
            <button type="button" className="primary-command" onClick={onClose}>
              <Check size={16} />知道了
            </button>
          ) : ready ? (
            <button type="button" className="primary-command" onClick={onApply} disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}立即更新并重启
            </button>
          ) : downloading ? (
            <button type="button" className="primary-command" disabled>
              <LoaderCircle className="spin" size={16} />{saving ? '正在保存…' : '正在下载…'}
            </button>
          ) : failed ? (
            <button type="button" className="primary-command" onClick={openRelease} disabled={!status.releaseUrl}>
              <ExternalLink size={16} />去 Release 页
            </button>
          ) : (
            <button type="button" className="primary-command" onClick={onDownload} disabled={busy}>
              <Check size={16} />下载更新
            </button>
          )}
          {!upToDate && <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>暂不</button>}
        </footer>
      </section>
    </div>
  )
}
