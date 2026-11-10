import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import packageMetadata from '../../../package.json'
import { useLauncherApi } from '../../api/client'
import { pricingPeriod } from '../../lib/deepseek-pricing'
import type { DeepSeekBalanceResult, DshUsageResult, IdleShutdownState, LauncherUpdateStatus } from '../../types'
import { DataPanels } from './DataPanels'
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

/** 关机卡片的状态刷新间隔：主进程自己算空闲，界面只负责跟上。 */
const IDLE_SHUTDOWN_POLL_MS = 5000

/** ISO 时刻 → 本地 HH:MM；解析不了就返回空串，由调用方退回不带时间的文案。 */
function shutdownClock(value: string | null): string {
  if (!value) return ''
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return ''
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * 「启动」页：左列品牌（品牌图 + 软件名 + 版本号/检查更新），
 * 右列上余额卡（DeepSeek 余额 + 今日 Token + 查看用量），右列下插件数据面板（见 DataPanels）。
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

  // 空闲自动关机：初值与后续状态都来自主进程，界面不自己推断「空闲」。
  const [shutdown, setShutdown] = useState<IdleShutdownState | null>(null)
  const [shutdownError, setShutdownError] = useState<string | null>(null)
  const [shutdownBusy, setShutdownBusy] = useState(false)
  const shutdownApi = api.idleShutdown

  useEffect(() => {
    let cancelled = false
    const read = async () => {
      try {
        const next = await shutdownApi.get()
        // 轮询只负责清掉「读不到」这类错误；操作失败的提示留到用户下一次动手，别 5 秒就消失。
        if (!cancelled) {
          setShutdown(next)
          setShutdownError(current => (current && current.startsWith('自动关机状态读取失败') ? null : current))
        }
      } catch (cause) {
        if (!cancelled) setShutdownError(`自动关机状态读取失败：${errorText(cause)}`)
      }
    }
    void read()
    const timer = window.setInterval(() => { void read() }, IDLE_SHUTDOWN_POLL_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [shutdownApi])

  const applyShutdown = async (action: () => Promise<IdleShutdownState>, failPrefix: string) => {
    setShutdownBusy(true); setShutdownError(null)
    try {
      setShutdown(await action())
    } catch (cause) {
      setShutdownError(`${failPrefix}：${errorText(cause)}`)
      // 失败后重读一次：界面不能停在用户以为已经生效的那个状态。
      try { setShutdown(await shutdownApi.get()) } catch { /* 读不到就保住原状态。 */ }
    } finally {
      setShutdownBusy(false)
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

        <section className="start-panel start-shutdown" aria-label="任务完成后自动关机">
          <header className="start-panel-head">
            <h2>任务完成后自动关机</h2>
            {shutdown && <span className={`start-shutdown-phase ${shutdown.phase}`}>{shutdown.phase === 'armed' ? '已排定关机' : shutdown.phase === 'waiting' ? '等待空闲' : '未开启'}</span>}
          </header>
          <div className="start-panel-body">
            <label className="start-shutdown-toggle">
              <input
                type="checkbox"
                aria-label="任务完成后自动关机"
                checked={shutdown?.enabled ?? false}
                disabled={shutdownBusy}
                onChange={event => void applyShutdown(
                  () => (event.target.checked ? shutdownApi.arm() : shutdownApi.disarm()),
                  '自动关机开关没有生效',
                )}
              />
              <span>
                <strong>所有整合包都空闲后自动关闭这台电脑</strong>
                <small>默认关闭。打开后按设置里的空闲阈值判定，判定通过还会留一段取消时间。</small>
              </span>
            </label>
            {shutdown?.phase === 'waiting' && (
              <div className="start-shutdown-state">
                <strong>等待所有整合包空闲</strong>
                <p>空闲判定 {shutdown.idleMinutes} 分钟</p>
                {shutdown.busy.length > 0 && (
                  <ul className="start-shutdown-busy">
                    {shutdown.busy.map(item => <li key={item.packId}><code>{item.packId}</code>：{item.reason}</li>)}
                  </ul>
                )}
              </div>
            )}
            {shutdown?.phase === 'armed' && (
              <div className="start-shutdown-state is-armed">
                <strong>{shutdownClock(shutdown.shutdownAt) ? `将于 ${shutdownClock(shutdown.shutdownAt)} 关机` : '即将关机'}</strong>
                <p>
                  {shutdown.graceMinutes === 0 ? '不等待，立即关机' : `取消窗口 ${shutdown.graceMinutes} 分钟`}
                  {shutdown.stopPacks ? '；关机前先停止所有整合包。' : '；不会停止正在运行的整合包。'}
                </p>
                <button type="button" className="start-shutdown-cancel" disabled={shutdownBusy} onClick={() => void applyShutdown(() => shutdownApi.cancel(), '取消失败')}>取消本次关机</button>
              </div>
            )}
            {shutdown && shutdown.phase !== 'off' && shutdown.message && <p className="start-shutdown-message" role="status">{shutdown.message}</p>}
            {shutdownError && <p className="start-shutdown-error" role="alert">{shutdownError}</p>}
          </div>
        </section>

        <DataPanels />
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
        <p>到「设置 → API 库」里填一个 DeepSeek SK，可用余额与今日 Token 就会显示在这里。</p>
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
