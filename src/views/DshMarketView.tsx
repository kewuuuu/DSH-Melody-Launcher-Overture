import { launcherControl } from '../lib/pack-control'
import { Check, ExternalLink, LoaderCircle, RefreshCw, Search, Star, Store, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLauncherApi } from '../api/client'
import { CatalogPagination } from '../components/CatalogPagination'
import { PageHeading } from '../components/PageHeading'
import { SkeletonCards } from '../components/Skeleton'
import { formatStars } from '../lib/format'
import type { DshMarketCatalog, DshMarketCompatibility, DshMarketCompatibilityEntry, DshMarketPlugin, DshMarketProgress, LauncherApi } from '../types'

type Sort = 'stars' | 'updated' | 'name'

/**
 * 每页卡片数。精选目录有几千条，整表铺开时任何一次状态更新都要重挂几千张卡片
 * （issue #12 的装机卡顿一半是这么来的），所以只渲染当前页。
 */
const MARKET_PAGE_SIZE = 48
const COMPATIBILITY_WINDOW = MARKET_PAGE_SIZE * 2

type MarketSearch = { query: string; category: string; sort: Sort }
type CatalogDisplay = { api: LauncherApi; profileName: string | null; catalog: DshMarketCatalog }

function entryKey({ name, url }: Pick<DshMarketPlugin, 'name' | 'url'>) {
  return JSON.stringify([name, url])
}

function compatibleVersion(entry?: DshMarketCompatibilityEntry) {
  return entry?.status === 'compatible' ? entry.version : null
}

function compatibilityLabel(entry?: DshMarketCompatibilityEntry) {
  if (!entry) return '待检查兼容性'
  const version = compatibleVersion(entry)
  if (version) return '兼容版本 v' + version
  return entry.status === 'incompatible' ? '不兼容' : '兼容性未知'
}

/**
 * 目录结果的模块级缓存：切走 tab 组件被卸载后，重进时先用旧目录直接渲染、
 * 后台静默刷新（主进程另有磁盘缓存 + 30 分钟 SWR），不再每次闪一遍骨架屏。
 */
let cachedCatalog: CatalogDisplay | null = null

interface DshMarketViewProps {
  /** Market mutations write the active Profile; let the shared store refresh it. */
  onProfileChanged?: () => Promise<void> | void
  /** 嵌入 C 端设置页时：去掉整页容器与 PageHeading，改用紧凑面板头。 */
  embedded?: boolean
  /** 当前激活整合包名：变化时重拉安装态。由上层传，不在这里再开一份 store。 */
  activeProfileName: string | null
  /** 面板头右侧追加的动作（如「手动添加插件」——目录读不出来时那条路仍然能走）。 */
  targetPackId?: string
  extraActions?: ReactNode
}

export function DshMarketView(props: DshMarketViewProps) {
  return <MarketSearchView key={JSON.stringify([Boolean(props.targetPackId), props.targetPackId ? null : props.activeProfileName])} {...props} />
}

function MarketSearchView(props: DshMarketViewProps) {
  const [search, setSearch] = useState<MarketSearch>({ query: '', category: 'all', sort: 'stars' })
  return <ScopedDshMarketView key={JSON.stringify([props.activeProfileName, props.targetPackId])} {...props} search={search} setSearch={setSearch} />
}

function ScopedDshMarketView({ onProfileChanged, embedded = false, activeProfileName, extraActions, targetPackId, search, setSearch }: DshMarketViewProps & {
  search: MarketSearch
  setSearch: (search: MarketSearch) => void
}) {
  const api = useLauncherApi()
  const [display, setDisplay] = useState(() => !targetPackId && cachedCatalog?.api === api && cachedCatalog.profileName === activeProfileName ? cachedCatalog : null)
  const currentDisplay = display?.api === api ? display : null
  const catalog = currentDisplay?.catalog ?? null
  const { query, category, sort } = search
  const [compatibleOnly, setCompatibleOnly] = useState(false)
  const [scanLimit, setScanLimit] = useState(COMPATIBILITY_WINDOW)
  const [compatibility, setCompatibility] = useState<{
    display: CatalogDisplay
    entries: Map<string, DshMarketCompatibilityEntry>
    dshVersion: string | null | undefined
    runtimeChanged: boolean
  } | null>(null)
  const currentCompatibility = compatibility?.display === currentDisplay ? compatibility : null
  const byEntry = currentCompatibility?.entries
  const runtimeChanged = currentCompatibility?.runtimeChanged === true
  const dshVersion = currentCompatibility?.dshVersion === undefined ? catalog?.dshVersion : currentCompatibility.dshVersion
  const compatibilityScope = useRef<{ pending: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [progress, setProgress] = useState<DshMarketProgress | null>(null)
  const [page, setPage] = useState(1)
  const activeApi = useRef<LauncherApi | null>(null)
  const requestId = useRef(0)
  const targetUpdatesChecked = useRef(false)
  useLayoutEffect(() => {
    activeApi.current = api
    return () => { activeApi.current = null; requestId.current += 1 }
  }, [api])

  const load = async (checkUpdates = false) => {
    const request = ++requestId.current
    const isCurrent = () => activeApi.current === api && requestId.current === request
    setLoading(!checkUpdates)
    setCheckingUpdates(checkUpdates)
    setError(null)
    try {
      let next: DshMarketCatalog
      if (targetPackId) {
        if (checkUpdates) targetUpdatesChecked.current = true
        next = await launcherControl(api, 'pack.market.catalog', targetPackId, { checkUpdates: targetUpdatesChecked.current }) as DshMarketCatalog
      } else {
        if (checkUpdates) await api.checkDshMarketUpdates(true)
        if (!isCurrent()) return
        next = await api.loadDshMarket()
      }
      if (!isCurrent()) return
      const result = { api, profileName: activeProfileName, catalog: next }
      if (!targetPackId) cachedCatalog = result
      setDisplay(result)
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : checkUpdates ? '更新检查失败' : '无法读取 DSH Market')
    } finally {
      if (isCurrent()) {
        setLoading(false)
        setCheckingUpdates(false)
      }
    }
  }

  // 终端阶段（complete / error）短暂保留后清空进度条，避免「卡在 84%」错觉残留。
  const progressClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleProgress = (next: DshMarketProgress) => {
    setProgress(next)
    if (progressClearRef.current) { clearTimeout(progressClearRef.current); progressClearRef.current = null }
    if (next.phase === 'complete' || next.phase === 'error') {
      progressClearRef.current = setTimeout(() => setProgress(null), 1800)
    }
  }

  useEffect(() => {
    if (targetPackId) return
    const unsubscribe = api.onDshMarketProgress(handleProgress)
    return () => {
      unsubscribe()
      if (progressClearRef.current) clearTimeout(progressClearRef.current)
    }
  }, [api, targetPackId])

  useEffect(() => {
    let cancelled = false
    // StrictMode cleans up and immediately repeats the mount effect in development.
    queueMicrotask(() => { if (!cancelled) void load() })
    return () => { cancelled = true }
  }, [api])

  const keyword = query.trim().toLowerCase()
  const candidates = useMemo(() => {
    const list = (catalog?.plugins ?? []).filter(plugin => {
      if (category !== 'all' && plugin.category !== category) return false
      const text = `${plugin.name} ${plugin.owner} ${plugin.description.zh ?? ''} ${plugin.description.en ?? ''}`.toLowerCase()
      const npmName = targetPackId ? [plugin.packageName, plugin.npm].filter(Boolean).join(' ').toLowerCase() : ''
      return text.includes(keyword) || (npmName !== '' && npmName.includes(keyword))
    })
    return [...list].sort((left, right) => sort === 'stars'
      ? right.stars - left.stars || left.name.localeCompare(right.name)
      : sort === 'updated'
        ? String(right.added).localeCompare(String(left.added))
        : left.name.localeCompare(right.name))
  }, [catalog, keyword, category, sort, targetPackId])

  const needsKeyword = compatibleOnly && candidates.length > COMPATIBILITY_WINDOW && !keyword && category === 'all'
  const scanWindow = useMemo(() => candidates.slice(0, needsKeyword ? 0 : scanLimit), [candidates, needsKeyword, scanLimit])
  const visible = useMemo(() => compatibleOnly
    ? scanWindow.filter(plugin => compatibleVersion(byEntry?.get(entryKey(plugin))))
    : candidates, [compatibleOnly, scanWindow, byEntry, candidates])
  const checked = compatibleOnly ? scanWindow.filter(plugin => byEntry?.has(entryKey(plugin))).length : 0
  const scanning = compatibleOnly && !runtimeChanged && checked < scanWindow.length
  const pageCount = Math.max(1, Math.ceil(visible.length / MARKET_PAGE_SIZE))
  // 目录刷新后结果可能变短，钳住页码避免出现空页。
  const currentPage = Math.min(page, pageCount)
  const shown = useMemo(() => visible.slice((currentPage - 1) * MARKET_PAGE_SIZE, currentPage * MARKET_PAGE_SIZE), [visible, currentPage])
  const requestedEntries = compatibleOnly ? scanWindow : shown

  useLayoutEffect(() => {
    if (!targetPackId || !currentDisplay) return
    compatibilityScope.current = { pending: false }
    return () => { compatibilityScope.current = null }
  }, [targetPackId, currentDisplay])

  useEffect(() => {
    const scope = compatibilityScope.current
    if (!scope || !currentDisplay || !targetPackId || loading || checkingUpdates || runtimeChanged) return
    const batch = new Map<string, Pick<DshMarketPlugin, 'name' | 'url'>>()
    for (const { name, url } of requestedEntries) {
      const key = entryKey({ name, url })
      if (!byEntry?.has(key)) batch.set(key, { name, url })
      if (batch.size === MARKET_PAGE_SIZE) break
    }
    if (!batch.size) return

    let cancelled = false
    queueMicrotask(async () => {
      if (cancelled || compatibilityScope.current !== scope || scope.pending) return
      scope.pending = true
      let result: DshMarketCompatibility | undefined
      try {
        result = await launcherControl(api, 'pack.market.compatibility', targetPackId, { entries: [...batch.values()] }) as DshMarketCompatibility
      } catch {
        // Keep the catalog usable when the compatibility lookup is unavailable.
      } finally {
        scope.pending = false
      }
      if (compatibilityScope.current !== scope) return

      const returned = new Map((Array.isArray(result?.entries) ? result.entries : []).map(entry => [entryKey(entry), entry]))
      setCompatibility(previous => {
        const previousVersion = previous?.display === currentDisplay ? previous.dshVersion : undefined
        const nextVersion = result?.dshVersion === undefined ? previousVersion : result.dshVersion
        if (previousVersion !== undefined && previousVersion !== nextVersion) {
          return { display: currentDisplay, entries: new Map(), dshVersion: nextVersion, runtimeChanged: true }
        }
        const entries = new Map(previous?.display === currentDisplay ? previous.entries : undefined)
        for (const [key, entry] of batch) {
          entries.set(key, returned.get(key) ?? { ...entry, status: 'unknown', version: null, latestVersion: null })
        }
        return { display: currentDisplay, entries, dshVersion: nextVersion, runtimeChanged: false }
      })
    })
    return () => { cancelled = true }
  }, [api, targetPackId, currentDisplay, loading, checkingUpdates, requestedEntries, byEntry, runtimeChanged])

  const resetSearchPage = () => {
    setPage(1)
    setScanLimit(COMPATIBILITY_WINDOW)
  }
  const changeSearch = (next: Partial<MarketSearch>) => {
    resetSearchPage()
    setSearch({ ...search, ...next })
  }

  const gridRef = useRef<HTMLDivElement | null>(null)
  const flipPage = (next: number) => {
    setPage(next)
    gridRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const mutate = async (plugin: DshMarketPlugin, action: 'install' | 'update' | 'uninstall' | 'toggle', enabled?: boolean) => {
    const expectedVersion = action === 'install' ? compatibleVersion(byEntry?.get(entryKey(plugin))) : plugin.updateVersion
    if (targetPackId && (action === 'install' || action === 'update') && (!expectedVersion || loading || checkingUpdates || runtimeChanged)) return
    setBusy(plugin.name)
    setError(null)
    try {
      if (targetPackId) {
        if (action === 'install' || action === 'update') {
          await launcherControl(api, action === 'install' ? 'pack.market.install' : 'pack.market.update', targetPackId, { name: plugin.name, url: plugin.url, ...(plugin.packageName ? { packageName: plugin.packageName } : {}), expectedVersion })
        } else {
          await launcherControl(api, action === 'toggle' ? 'pack.resources.enabled' : 'pack.resources.remove', targetPackId, { kind: 'plugins', name: plugin.packageName, enabled })
        }
      } else if (action === 'install') await api.installDshMarketPlugin(plugin.name)
      else if (action === 'update') await api.updateDshMarketPlugin(plugin.name)
      else if (action === 'uninstall') await api.uninstallDshMarketPlugin(plugin.name)
      else await api.toggleDshMarketPlugin(plugin.name, enabled === true)
      // The market service and startup-item manager share the same Profile on
      // disk, but their renderer state is otherwise independent. Refresh the
      // shared Profile before redrawing the market so both switches agree.
      if (activeApi.current !== api) return
      if (!targetPackId && cachedCatalog?.api === api && cachedCatalog.profileName === activeProfileName) cachedCatalog = null
      await onProfileChanged?.()
      if (activeApi.current === api) await load()
    } catch (cause) {
      if (activeApi.current === api) setError(cause instanceof Error ? cause.message : '操作失败')
    } finally {
      if (activeApi.current === api) setBusy(null)
    }
  }

  const categories = Object.entries(catalog?.categories ?? {})
  const refreshActions = <>{extraActions}<button type="button" className="secondary-button" onClick={() => void load(true)} disabled={loading || checkingUpdates}><RefreshCw size={14} className={checkingUpdates ? 'spin' : undefined} />检查更新</button><button type="button" className="secondary-button" onClick={() => void load()} disabled={loading || checkingUpdates}><RefreshCw size={14} className={loading ? 'spin' : undefined} />刷新目录</button></>
  return (
    <div className={embedded ? 'dsh-market-page dsh-market-embedded' : 'page dsh-market-page'}>
      {embedded
        ? <div className="settings-panel-heading"><div className="settings-panel-title"><Store size={17} /><span>DSH Market · 精选插件</span></div><div className="dsh-market-embedded-actions">{refreshActions}</div></div>
        : <PageHeading
            eyebrow="独立插件市场"
            title="DSH Market"
            description="复用 dsh-market 的精选目录、安装、更新和启停逻辑。与资源市场完全独立。"
            actions={refreshActions}
          />}
      <div className="dsh-market-note">
        <span><Store size={14} /> 数据源：awesome-dsh-plugin.com/plugins.json</span>
        <span>{catalog ? `${catalog.count} 个精选插件 · 更新于 ${catalog.updated || '未知'}` : '正在读取目录'}</span>
      </div>
      {targetPackId && <div className="dsh-market-note"><span>整合包 DSH 版本：{dshVersion ?? '未知'}</span><label><input type="checkbox" checked={compatibleOnly} onChange={event => { resetSearchPage(); setCompatibleOnly(event.target.checked) }} /> 仅显示兼容插件</label></div>}
      <div className="dsh-market-toolbar">
        <label className="dsh-market-search"><Search size={15} /><input value={query} onChange={event => changeSearch({ query: event.target.value })} placeholder={targetPackId ? '搜索名称、npm 包名、作者或描述' : '搜索名称、作者或描述'} /></label>
        <select value={category} onChange={event => changeSearch({ category: event.target.value })} aria-label="插件分类"><option value="all">全部分类</option>{categories.map(([id, label]) => <option key={id} value={id}>{label.zh ?? label.en ?? id}</option>)}</select>
        <select value={sort} onChange={event => changeSearch({ sort: event.target.value as Sort })} aria-label="排序"><option value="stars">星数最多</option><option value="updated">最近加入</option><option value="name">名称排序</option></select>
      </div>
      {runtimeChanged && <div className="settings-hint">整合包的 DSH 版本已变化，请刷新目录后再检查兼容性。</div>}
      {compatibleOnly && catalog && !runtimeChanged && (needsKeyword
        ? <div className="settings-hint">请输入关键词或选择分类，缩小兼容性检查范围。</div>
        : <div className="dsh-market-note">
            <span role="status">已检查 {checked} / {scanWindow.length} 个（共 {candidates.length} 个匹配）{scanning ? ' · 正在检查兼容性…' : ''}</span>
            {!scanning && scanWindow.length < candidates.length && <button type="button" className="secondary-button" onClick={() => setScanLimit(scanLimit + COMPATIBILITY_WINDOW)}>继续检查下一批</button>}
          </div>)}
      {progress && progress.phase !== 'complete' && progress.phase !== 'error' && (
        <div className="dsh-market-progress">
          <LoaderCircle size={14} className="spin" />
          <span>{progress.message}</span>
          <div className={`dsh-market-progress-track ${progress.percent !== null ? 'determinate' : 'indeterminate'}`}>
            {progress.percent !== null && <span style={{ width: `${progress.percent}%` }} />}
          </div>
          {progress.percent !== null && <strong>{progress.percent}%</strong>}
        </div>
      )}
      {error && <div className="error-banner"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>}
      {loading && catalog === null && <><div className="settings-hint">正在读取 DSH Market 目录…</div><SkeletonCards count={8} /></>}
      {!loading && catalog !== null && visible.length === 0 && !scanning && !needsKeyword && !runtimeChanged && <div className="empty-state"><Search size={22} /><span>{compatibleOnly ? '已检查的结果中没有确认兼容的插件。' : '没有匹配的精选插件。'}</span></div>}
      <div ref={gridRef} className="dsh-market-grid">
        {shown.map(plugin => {
          const isBusy = busy === plugin.name
          const compatibilityEntry = byEntry?.get(entryKey(plugin))
          const installVersion = compatibleVersion(compatibilityEntry)
          const latestVersion = compatibilityEntry?.latestVersion
          return (
            <article key={targetPackId ? entryKey(plugin) : `${plugin.owner}/${plugin.name}`} className="dsh-market-card">
              <div className="dsh-market-card-head"><div><h2>{plugin.name}</h2><span>{plugin.owner}</span></div><span className="dsh-market-stars"><Star size={13} />{formatStars(plugin.stars)}</span></div>
              <div className="dsh-market-meta"><span>{plugin.category}</span>{plugin.npm ? <code>npm</code> : <code>GitHub</code>}{plugin.version && <code>{targetPackId ? '已安装 ' : ''}v{plugin.version}</code>}{targetPackId && <><span>{runtimeChanged ? '兼容性未知' : compatibilityLabel(compatibilityEntry)}</span>{latestVersion && latestVersion !== installVersion && <code>最新版本 v{latestVersion}</code>}</>}{plugin.installed && <b className={plugin.enabled ? 'market-enabled' : 'market-disabled'}>{plugin.enabled ? '已启用' : '未启用'}</b>}</div>
              <p>{plugin.description.zh ?? plugin.description.en ?? '暂无描述'}</p>
              <div className="dsh-market-card-foot"><button type="button" className="dsh-market-link" onClick={() => void api.openExternal(plugin.url)}><ExternalLink size={13} />仓库</button><span className="dsh-market-grow" />{plugin.installed && <button type="button" className="icon-button" title={plugin.enabled ? '停用插件' : '启用插件'} disabled={isBusy} onClick={() => void mutate(plugin, 'toggle', !plugin.enabled)}>{plugin.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}</button>}{plugin.installed && plugin.updateAvailable && <button type="button" className="secondary-button dsh-market-action" disabled={isBusy || Boolean(targetPackId && (!plugin.updateVersion || loading || checkingUpdates || runtimeChanged))} onClick={() => void mutate(plugin, 'update')}>{isBusy ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}更新{targetPackId && plugin.updateVersion ? '至 v' + plugin.updateVersion : ''}</button>}{plugin.installed ? <button type="button" className="danger-button dsh-market-action" disabled={isBusy} onClick={() => void mutate(plugin, 'uninstall')}><Trash2 size={13} />卸载</button> : <button type="button" className="primary-command dsh-market-action" disabled={isBusy || Boolean(targetPackId && (!installVersion || loading || checkingUpdates))} onClick={() => void mutate(plugin, 'install')}>{isBusy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}安装</button>}</div>
            </article>
          )
        })}
      </div>
      {pageCount > 1 && (
        <CatalogPagination
          page={currentPage}
          pageCount={pageCount}
          summary={`当前页 ${shown.length} 个，共 ${visible.length} 个精选插件`}
          label="精选插件分页"
          loading={loading}
          onPageChange={flipPage}
        />
      )}
    </div>
  )
}
