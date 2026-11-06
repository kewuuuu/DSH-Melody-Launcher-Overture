import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, FolderOpen, Layers3, LoaderCircle, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useLauncherApi } from '../../api/client'
import type { LauncherApi, LauncherPluginPanel, LauncherPluginsState } from '../../types'
import './data-panels.css'

/**
 * 启动页右下角的插件数据面板。
 *
 * 面板内容全部由 launcher 侧插件提供（list / table / html 三种），这里只管摆放：
 * 一次显示一页，多面板用箭头与圆点翻页；html 面板进 sandbox="" 的 iframe，
 * 不给 allow-scripts / allow-same-origin——插件的 HTML 是外部内容，不该拿到我们的源。
 */

const EMPTY_TEXT = '还没有数据面板 · 把插件放进数据目录的 launcher-plugins 文件夹'

/** 后端抛的是带中文说明的 Error：有 message 就原样用，别换成通用文案。 */
const errorText = (cause: unknown, fallback: string): string =>
  cause instanceof Error && cause.message ? cause.message : fallback

async function fetchPlugins(api: LauncherApi, refresh: boolean): Promise<LauncherPluginsState> {
  const plugins = api.launcherPlugins
  if (!plugins) throw new Error('当前环境没有提供插件数据面板接口。')
  return refresh ? plugins.refresh() : plugins.list()
}

export function DataPanels() {
  const api = useLauncherApi()
  const [state, setState] = useState<LauncherPluginsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(0)

  const load = useCallback(async (refresh: boolean) => {
    setLoading(true)
    setError(null)
    try {
      setState(await fetchPlugins(api, refresh))
    } catch (cause) {
      setError(errorText(cause, '读取数据面板失败，请稍后重试。'))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { void load(false) }, [load])

  const panels = state?.panels ?? []
  // 插件被删/换掉时页码可能越界：夹回第一页，避免空白页卡住。
  useEffect(() => {
    if (page > 0 && page >= panels.length) setPage(0)
  }, [page, panels.length])
  const current = panels[page] ?? null
  const failed = (state?.plugins ?? []).filter(plugin => plugin.error)

  const openFolder = () => { void api.launcherPlugins?.openFolder() }

  return (
    <section className="start-panel start-data">
      <header className="start-panel-head">
        <h2>
          数据面板
          {panels.length > 1 && <span className="dp-page">{page + 1} / {panels.length}</span>}
        </h2>
        <div className="start-panel-tools">
          <button type="button" className="start-icon-button" aria-label="打开插件文件夹" title="打开插件文件夹" onClick={openFolder}>
            <FolderOpen size={13} />
          </button>
          <button
            type="button"
            className="start-icon-button"
            aria-label="刷新数据面板"
            title="刷新数据面板"
            disabled={loading}
            onClick={() => void load(true)}
          >
            {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          </button>
        </div>
      </header>

      <div className="start-panel-body dp-body">
        {error ? (
          <div className="start-state is-error">
            <strong>数据面板读取失败</strong>
            <p>{error}</p>
            <button type="button" className="secondary-button compact" onClick={() => void load(true)}>重试</button>
          </div>
        ) : panels.length === 0 ? (
          <div className="start-data-empty">
            <Layers3 size={22} />
            <p>{loading ? '正在读取数据面板…' : EMPTY_TEXT}</p>
            <button type="button" className="secondary-button compact" onClick={openFolder}>打开插件文件夹</button>
          </div>
        ) : (
          <div className="dp-carousel">
            <button
              type="button"
              className="dp-arrow"
              aria-label="上一个面板"
              disabled={panels.length < 2}
              onClick={() => setPage(prev => (prev - 1 + panels.length) % panels.length)}
            >
              <ChevronLeft size={15} />
            </button>
            <div className="dp-slide">
              <div className="dp-slide-head">
                <strong>{current?.title}</strong>
                {current?.plugin && <span className="dp-plugin">{current.plugin}</span>}
              </div>
              {current && <PanelBody api={api} panel={current} />}
              {current?.hint && <p className="dp-hint">{current.hint}</p>}
              {panels.length > 1 && (
                <div className="dp-dots" role="tablist" aria-label="数据面板分页">
                  {panels.map((panel, index) => (
                    <button
                      key={panel.id}
                      type="button"
                      role="tab"
                      aria-selected={index === page}
                      aria-label={`第 ${index + 1} 个面板`}
                      className={`dp-dot ${index === page ? 'is-active' : ''}`}
                      onClick={() => setPage(index)}
                    />
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="dp-arrow"
              aria-label="下一个面板"
              disabled={panels.length < 2}
              onClick={() => setPage(prev => (prev + 1) % panels.length)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>

      {failed.length > 0 && (
        <div className="dp-plugin-errors">
          {failed.map(plugin => (
            <p key={plugin.name}>
              <AlertTriangle size={11} />插件 {plugin.title || plugin.name} 加载失败：{plugin.error}
            </p>
          ))}
        </div>
      )}
    </section>
  )
}

function PanelBody({ api, panel }: { api: LauncherApi; panel: LauncherPluginPanel }) {
  if (panel.type === 'list') {
    return (
      <ul className="dp-list">
        {panel.items.map((item, index) => (
          <li key={`${item.label}-${index}`}>
            {item.href ? (
              <a
                className="dp-row is-link"
                href={item.href}
                title={item.href}
                onClick={event => { event.preventDefault(); void api.openExternal(item.href as string) }}
              >
                <span className="dp-label">{item.label}</span>
                {item.value && <span className="dp-value">{item.value}</span>}
                <ExternalLink size={11} />
              </a>
            ) : (
              <span className="dp-row">
                <span className="dp-label">{item.label}</span>
                {item.value && <span className="dp-value">{item.value}</span>}
              </span>
            )}
          </li>
        ))}
      </ul>
    )
  }
  if (panel.type === 'table') {
    return (
      <div className="dp-table-scroll">
        <table className="dp-table">
          <thead>
            <tr>{panel.columns.map((column, index) => <th key={`${column}-${index}`}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {panel.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <iframe
      className="dp-html"
      title={panel.title}
      sandbox=""
      srcDoc={panel.html}
      referrerPolicy="no-referrer"
      loading="lazy"
    />
  )
}
