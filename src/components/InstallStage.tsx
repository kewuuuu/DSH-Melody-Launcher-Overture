import { LoaderCircle } from 'lucide-react'
import { isInstallTerminal } from '../hooks/use-install-operation'

interface InstallStageProps {
  progress: {
    phase: string
    message: string
    percent: number | null
    indeterminate?: boolean
    operationId?: string
    cancellable?: boolean
  }
  cancelling?: boolean
  cancelError?: string | null
  onCancel?: () => void
  variant?: 'settings' | 'dsh-market'
}

export function InstallStage({ progress, cancelling, cancelError, onCancel, variant = 'settings' }: InstallStageProps) {
  const active = !isInstallTerminal(progress.phase)
  const percent = progress.indeterminate ? null : progress.percent
  const showCancel = active && onCancel && progress.cancellable === true && progress.operationId
  return (
    <>
      <div className={`${variant}-progress install-stage`}>
        {active && <LoaderCircle size={14} className="spin" aria-hidden="true" />}
        <span role="status">{progress.message}</span>
        {active && <>
          <div className={`${variant}-progress-track ${percent === null ? 'indeterminate' : 'determinate'}`} aria-hidden="true">
            {percent !== null ? <span style={{ width: `${percent}%` }} /> : variant === 'dsh-market' && <span />}
          </div>
          {percent !== null && <strong>{percent}%</strong>}
        </>}
        {showCancel && <button type="button" className="secondary-button" disabled={cancelling} onClick={onCancel}>
          {cancelling ? '正在取消安装…' : '取消安装'}
        </button>}
        {active && cancelling && !showCancel && <span role="status">正在取消安装…</span>}
      </div>
      {cancelError && <div className="error-banner" role="alert">{cancelError}</div>}
    </>
  )
}
