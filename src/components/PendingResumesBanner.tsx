import { AlertTriangle, ChevronDown, ChevronRight, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useLauncherApi } from '../api/client'
import type { PendingResumeEntry } from '../types'
import './pending-resumes.css'

/**
 * 待续接的对话请求：重启/停止运行时主进程替用户留下的那条 prompt。
 *
 * 挂在整合包页顶部（有包上下文，用户知道是哪套环境没发出去）。没有条目时整块不渲染，
 * 不占版面；4 秒轮询与包列表同一节奏，避免用户盯着已经发出去的旧条目。
 */

const POLL_MS = 4000

/** 后端抛的是带中文说明的 Error：有 message 就原样用，别换成通用文案。 */
const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback

function statusText(status: PendingResumeEntry['status']): string {
  if (status === 'pending') return '等待发送'
  if (status === 'failed') return '发送失败'
  return '已发送'
}

function promptText(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat
}

export function PendingResumesBanner() {
  const api = useLauncherApi()
  const [entries, setEntries] = useState<PendingResumeEntry[]>([])
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const resumes = api.pendingResumes
    if (!resumes) return
    try {
      setEntries(await resumes.list())
      setError(null)
    } catch (cause) {
      setError(errorText(cause, '读取待续接请求失败。'))
    }
  }, [api])

  useEffect(() => {
    void load()
    // 包可能在别处被启动/停止：跟包列表一个节奏重取，别让用户对着过期条目点重试。
    const timer = setInterval(() => { void load() }, POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  const retry = async (entry: PendingResumeEntry) => {
    const resumes = api.pendingResumes
    if (!resumes) return
    setBusy(entry.id)
    try {
      const result = await resumes.retry(entry.id)
      setEntries(result.entries)
      setError(result.ok ? null : result.error ?? '重试没有成功，请稍后再试。')
    } catch (cause) {
      setError(errorText(cause, '重试失败。'))
    } finally {
      setBusy(null)
    }
  }

  const discard = async (entry: PendingResumeEntry) => {
    const resumes = api.pendingResumes
    if (!resumes) return
    setBusy(entry.id)
    try {
      setEntries(await resumes.discard(entry.id))
      setError(null)
      setConfirming(null)
    } catch (cause) {
      setError(errorText(cause, '放弃失败。'))
    } finally {
      setBusy(null)
    }
  }

  if (entries.length === 0) return null

  return (
    <section className={`pending-resumes${expanded ? ' is-open' : ''}`} aria-label="待续接的对话请求">
      <button type="button" className="pending-resumes-head" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <AlertTriangle size={14} />
        <strong>{entries.length} 条对话请求等待续接</strong>
        <span className="pending-resumes-hint">重启或停止运行时留下的对话，可以重试或放弃</span>
      </button>

      {error && <p className="pending-resumes-error" role="alert">{error}</p>}

      {expanded && (
        <div className="pending-resumes-list">
          {entries.map(entry => (
            <article key={entry.id} className={`pending-resumes-item status-${entry.status}`}>
              <div className="pending-resumes-main">
                <div className="pending-resumes-meta">
                  <strong>{entry.packId}</strong>
                  <span>{statusText(entry.status)}</span>
                  <span>尝试 {entry.attempts} 次</span>
                  {entry.sessionId && <span>会话 {entry.sessionId}</span>}
                </div>
                <p className="pending-resumes-prompt" title={entry.prompt}>{promptText(entry.prompt)}</p>
                {entry.error && <p className="pending-resumes-detail">上次错误：{entry.error}</p>}
              </div>
              <div className="pending-resumes-actions">
                {confirming === entry.id ? (
                  <>
                    <span className="pending-resumes-confirm">放弃后这条请求不会再自动发出。</span>
                    <button type="button" className="danger-button compact" disabled={busy === entry.id} onClick={() => void discard(entry)}>确认放弃</button>
                    <button type="button" className="secondary-button compact" onClick={() => setConfirming(null)}>取消</button>
                  </>
                ) : (
                  <>
                    <button type="button" className="secondary-button compact" disabled={busy === entry.id} onClick={() => void retry(entry)}>
                      <RotateCcw size={12} />重试
                    </button>
                    <button type="button" className="secondary-button compact" disabled={busy === entry.id} onClick={() => setConfirming(entry.id)}>
                      <X size={12} />放弃
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}
