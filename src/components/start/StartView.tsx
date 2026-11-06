import { ExternalLink, Layers3, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import packageMetadata from '../../../package.json'
import { useLauncherApi } from '../../api/client'
import { pricingPeriod } from '../../lib/deepseek-pricing'
import type { DeepSeekBalanceResult, DshUsageResult, LauncherUpdateStatus } from '../../types'
import './start.css'

/** DeepSeek 平台的用量页：余额卡右上角「查看用量」的去处。 */
const USAGE_URL = 'https://platform.deepseek.com/usage'

interface StartViewProps {
  /** 自定义头像（appearance.logo）；空则用内置 launcher-logo.png。 */
  logoSrc: string | null
  /** 启动器已经知道的更新状态（后台检查的结果）。 */
  update: LauncherUpdateStatus | null
  /** 更新下载/安装进行中：此时不重复触发检查。 */
  busy: boolean
  /** 手动检查的结果交回 App：有更新时由 App 打开更新对话框。 */
  onUpdateChecked: (status: LauncherUpdateStatus) => void
  onOpenSettings: () => void
}

/** 该状态需要弹出更新对话框（可下载/下载中/已下载/安装中）。 */
export function updateNeedsDialog(status: LauncherUpdateStatus): boolean {
  return status.state === 'update-available'
    || status.state === 'downloading'
    || status.state === 'downloaded'
    || status.state === 'applying'
}

function describeUpdate(status: LauncherUpdateStatus | null): string {
  if (!status) return ''
  switch (status.state) {
    case 'up-to-date': return `已是最新版本${status.localVersion ? ` v${status.localVersion}` : ''}`
    case 'update-available': return `发现新版本${status.remoteVersion ? ` v${status.remoteVersion}` : ''}`
    case 'downloading': return '正在下载更新…'
    case 'downloaded': return '更新已下载，重启启动器即可安装'
    case 'applying': return '正在安装更新…'
    case 'error': return `更新检查失败：${status.message}`
    default: return ''
  }
}

/** 今日 Token 的紧凑写法（M/K），与旧小部件同一套口径。 */
function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

function usageText(usage: DshUsageResult | null): string {
  if (!usage) return '—'
  if (usage.status === 'ok') return formatTokens(usage.usage.tokensToday)
  if (usage.status === 'no-data') return '暂无数据'
  return '读取失败'
}

/**
 * 「启动」页：左列品牌（品牌图 + 软件名 + 版本号/检查更新），
 * 右列上余额卡（DeepSeek 余额 + 今日 Token + 查看用量），右列下数据面板占位。
 * 插件数据面板的渲染不在本轮范围内，这里只出空状态。
 */
export function StartView({ logoSrc, update, busy, onUpdateChecked, onOpenSettings }: StartViewProps) {
  const api = useLauncherApi()
  const [balance, setBalance] = useState<DeepSeekBalanceResult | null>(null)
  const [usage, setUsage] = useState<DshUsageResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [checkMessage, setCheckMessage] = useState<string | null>(null)

  const loadAccount = useCallback(async (force = false) => {
    setLoading(true)
    try {
      const [nextBalance, nextUsage] = await Promise.all([api.deepseekBalance(force), api.dshUsage(force)])
      setBalance(nextBalance)
      setUsage(nextUsage)
    } catch (cause) {
      // 余额与用量是两条独立通路：任一失败都不该把整页变成错误页。
      const message = cause instanceof Error ? cause.message : String(cause)
      setBalance({ status: 'error', message })
      setUsage({ status: 'error', message })
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void loadAccount()
  }, [loadAccount])

  const check = async () => {
    if (checking) return
    setChecking(true)
    try {
      const next = await api.checkLauncherUpdate()
      setCheckMessage(describeUpdate(next))
      onUpdateChecked(next)
    } catch (cause) {
      setCheckMessage(`检查更新失败：${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      setChecking(false)
    }
  }

  const period = pricingPeriod(new Date())
  const updateNote = checkMessage ?? describeUpdate(update)

  return (
    <div className="start-view">
      <aside className="start-brand">
        <div className="start-brand-main">
          <img
            className="start-brand-logo"
            src={logoSrc ?? `${import.meta.env.BASE_URL}launcher-logo.png`}
            alt="启动器图标"
            width={112}
            height={112}
            draggable={false}
          />
          <h1 className="start-brand-name">DSH启动器<span>：KEWU</span></h1>
          <p className="start-brand-tagline">本地 DSH 工作台 · 序曲分支</p>
        </div>
        <div className="start-brand-foot">
          <span className="start-brand-version">v{packageMetadata.version}</span>
          <button
            type="button"
            className="start-check-update"
            onClick={() => void check()}
            disabled={checking || busy}
          >
            {checking ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
            <span>{checking ? '正在检查' : '检查更新'}</span>
          </button>
          <button type="button" className="start-settings" onClick={onOpenSettings} title="启动器设置">设置</button>
        </div>
        {updateNote && <p className="start-brand-note">{updateNote}</p>}
      </aside>

      <section className="start-main">
        <section className="start-panel start-balance">
          <header className="start-panel-head">
            <h2>DeepSeek 余额</h2>
            <div className="start-panel-tools">
              <span className={`start-period ${period}`}>{period === 'peak' ? '峰段 · 原价' : '谷段 · 半价'}</span>
              <button
                type="button"
                className="start-icon-button"
                aria-label="刷新余额"
                disabled={loading}
                onClick={() => void loadAccount(true)}
              >
                <RefreshCw size={13} />
              </button>
              <a
                className="start-link"
                href={USAGE_URL}
                onClick={event => { event.preventDefault(); void api.openExternal(USAGE_URL) }}
              >查看用量<ExternalLink size={12} /></a>
            </div>
          </header>
          <div className="start-panel-body">
            <BalanceBody balance={balance} usage={usage} loading={loading} />
          </div>
        </section>

        <section className="start-panel start-data">
          <header className="start-panel-head">
            <h2>数据面板</h2>
            <button type="button" className="start-icon-button" aria-label="刷新数据面板" disabled title="插件数据面板将在后续版本提供">刷新</button>
          </header>
          <div className="start-data-empty">
            <Layers3 size={22} />
            <p>还没有数据面板 · 把插件放进数据目录的 launcher-plugins 文件夹</p>
          </div>
        </section>
      </section>
    </div>
  )
}

/** 余额卡正文：未配置 SK / 读取失败 / 有余额 三种终态，外加读取中。 */
function BalanceBody({ balance, usage, loading }: {
  balance: DeepSeekBalanceResult | null
  usage: DshUsageResult | null
  loading: boolean
}) {
  if (!balance) {
    return (
      <p className="start-placeholder">
        {loading && <LoaderCircle className="spin" size={14} />}
        正在读取余额…
      </p>
    )
  }
  if (balance.status === 'no-key') {
    return (
      <div className="start-state">
        <strong>还没有配置 API Key</strong>
        <p>到「设置 → API 密钥」里填一个 DeepSeek SK，可用余额与今日 Token 就会显示在这里。</p>
      </div>
    )
  }
  if (balance.status === 'error') {
    return (
      <div className="start-state is-error">
        <strong>余额读取失败</strong>
        <p>{balance.message}</p>
        <small>常见原因：SK 已失效、网络不通，或 DeepSeek 接口暂时不可用。</small>
      </div>
    )
  }
  const info = balance.balance.infos[0] ?? null
  const amount = info?.totalBalance ?? null
  return (
    <div className="start-balance-grid">
      <div className="start-amount">
        <small>可用余额</small>
        <strong>{amount === null ? '—' : amount.toFixed(2)}</strong>
        {info && <span>{info.currency}</span>}
      </div>
      <div className="start-metric">
        <small>今日 Token</small>
        <strong>{usageText(usage)}</strong>
        {usage?.status === 'ok' && usage.usage.cacheHitRate !== null && (
          <span>缓存命中 {(usage.usage.cacheHitRate * 100).toFixed(1)}%</span>
        )}
      </div>
      {!balance.balance.isAvailable && <p className="start-state is-warn">余额不足，这个 API Key 暂时无法调用。</p>}
    </div>
  )
}
