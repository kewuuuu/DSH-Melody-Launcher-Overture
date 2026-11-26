// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../api/client'
import type { DshMarketCatalog, DshMarketCompatibility, DshMarketCompatibilityEntry, DshMarketProgress, LauncherApi, LauncherControlRequest } from '../types'
import { DshMarketView } from './DshMarketView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function catalog(name: string, version: string | null = null, updateVersion: string | null = null): DshMarketCatalog {
  return { updated: '', count: 1, categories: {}, plugins: [{
    name, owner: 'owner', url: 'https://github.com/owner/' + name, category: 'tools', description: {},
    npm: '@owner/' + name, ...(version ? { packageName: '@owner/' + name } : {}), stars: 0, added: '', install: '',
    installed: version !== null, enabled: false, version, updateAvailable: updateVersion !== null, updateVersion,
  }] }
}

async function render(api: LauncherApi, activeProfileName: string, targetPackId?: string) {
  await act(async () => root.render(<StrictMode><LauncherApiProvider value={api}><DshMarketView activeProfileName={activeProfileName} targetPackId={targetPackId} /></LauncherApiProvider></StrictMode>))
}

async function click(label: string) {
  const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

it('loads once per profile and ignores a superseded response including after switching back', async () => {
  const first = deferred<DshMarketCatalog>()
  const second = deferred<DshMarketCatalog>()
  const third = deferred<DshMarketCatalog>()
  const loadDshMarket = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
  const launcherControl = vi.fn()
  const api = { loadDshMarket, launcherControl, onDshMarketProgress: () => () => {} } as unknown as LauncherApi
  await render(api, 'alpha')
  expect(loadDshMarket).toHaveBeenCalledTimes(1)
  await render(api, 'beta')
  await act(async () => second.resolve(catalog('beta-result')))
  expect(container.textContent).toContain('beta-result')
  await render(api, 'alpha')
  expect(container.textContent).not.toContain('beta-result')
  await act(async () => third.resolve(catalog('alpha-current')))
  await act(async () => first.resolve(catalog('alpha-stale')))
  expect(container.textContent).toContain('alpha-current')
  expect(container.textContent).not.toContain('alpha-stale')
  expect(loadDshMarket).toHaveBeenCalledTimes(3)
  expect(launcherControl).not.toHaveBeenCalled()
  expect(container.textContent).not.toContain('仅显示兼容插件')
})

it('ignores a stale target check and updates the exact package in the selected pack', async () => {
  const lateCheck = deferred<DshMarketCatalog>()
  let updated = false
  const launcherControl = vi.fn(async ({ command, packId, args }: Parameters<NonNullable<LauncherApi['launcherControl']>>[0]) => {
    if (command === 'pack.market.update') { updated = true; return {} }
    if (command === 'pack.market.compatibility') return { dshVersion: '0.2.1', entries: [] }
    if (packId === 'a') return args?.checkUpdates ? lateCheck.promise : catalog('alpha', '1.0.0')
    return catalog('beta', updated ? '1.1.0' : '1.0.0', args?.checkUpdates && !updated ? '1.1.0' : null)
  })
  const loadDshMarket = vi.fn()
  const checkDshMarketUpdates = vi.fn()
  const api = { launcherControl, loadDshMarket, checkDshMarketUpdates } as unknown as LauncherApi
  await render(api, 'alpha', 'a')
  expect(launcherControl.mock.calls.filter(([request]) => request.command === 'pack.market.catalog')).toHaveLength(1)
  await click('检查更新')
  await render(api, 'alpha', 'b')
  expect(container.textContent).not.toContain('alpha')
  await click('检查更新')
  await act(async () => lateCheck.resolve(catalog('alpha-stale', '1.0.0', '1.1.0')))
  expect(container.textContent).not.toContain('alpha-stale')
  await click('更新至 v1.1.0')
  expect(launcherControl).toHaveBeenCalledWith({ command: 'pack.market.update', packId: 'b', args: { name: 'beta', url: 'https://github.com/owner/beta', packageName: '@owner/beta', expectedVersion: '1.1.0' } })
  expect(container.textContent).toContain('v1.1.0')
  expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent?.startsWith('更新'))).toBe(false)
  expect(loadDshMarket).not.toHaveBeenCalled()
  expect(checkDshMarketUpdates).not.toHaveBeenCalled()
})

function entry(name: string, version: string | null, status: DshMarketCompatibilityEntry['status'] = 'compatible'): DshMarketCompatibilityEntry {
  return { name, url: 'https://github.com/owner/' + name, version, status, latestVersion: status === 'unknown' ? null : '2.0.0' }
}

function card(name: string) {
  return Array.from(container.querySelectorAll('article')).find(item => item.querySelector('h2')?.textContent === name)
}

function installButton(name: string) {
  return Array.from(card(name)?.querySelectorAll('button') ?? []).find(button => button.textContent === '安装')
}

async function query(text: string) {
  const input = container.querySelector<HTMLInputElement>('.dsh-market-search input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function filterCompatible() {
  const checkbox = container.querySelector<HTMLInputElement>('input[type=checkbox]')!
  await act(async () => checkbox.click())
}

it('shows the selected runtime before lookup and installs only a confirmed compatible version', async () => {
  const alpha = deferred<DshMarketCompatibility>()
  const plugins = ['example', 'unknown', 'incompatible'].flatMap(name => catalog(name).plugins)
  const launcherControl = vi.fn(async ({ command, packId }: LauncherControlRequest) => {
    const dshVersion = packId === 'a' ? '0.2.1' : '0.3.0'
    if (command === 'pack.market.catalog') return { ...catalog('example'), count: plugins.length, dshVersion, plugins }
    if (command === 'pack.market.compatibility') return packId === 'a' ? alpha.promise : { dshVersion, entries: [entry('example', '1.4.0')] }
    return {}
  })
  const api = { launcherControl } as unknown as LauncherApi
  await render(api, 'active', 'a')
  expect(container.textContent).toContain('整合包 DSH 版本：0.2.1')
  expect(card('example')?.textContent).toContain('待检查兼容性')
  expect(installButton('example')?.disabled).toBe(true)
  await act(async () => alpha.resolve({ dshVersion: '0.2.1', entries: [entry('example', '1.2.0'), entry('unknown', null, 'unknown'), entry('incompatible', null, 'incompatible')] }))
  expect(card('example')?.textContent).toContain('兼容版本 v1.2.0')
  expect(card('example')?.textContent).toContain('最新版本 v2.0.0')
  expect(card('unknown')?.textContent).toContain('兼容性未知')
  expect(card('incompatible')?.textContent).toContain('不兼容')
  expect(installButton('unknown')?.disabled).toBe(true)
  expect(installButton('incompatible')?.disabled).toBe(true)
  await filterCompatible()
  expect(container.querySelectorAll('article')).toHaveLength(1)
  await click('安装')
  expect(launcherControl).toHaveBeenCalledWith({ command: 'pack.market.install', packId: 'a', args: { name: 'example', url: 'https://github.com/owner/example', expectedVersion: '1.2.0' } })
  await render(api, 'active', 'b')
  expect(container.textContent).toContain('整合包 DSH 版本：0.3.0')
  expect(card('example')?.textContent).toContain('兼容版本 v1.4.0')
  expect(card('unknown')?.textContent).toContain('兼容性未知')
  expect(container.textContent).not.toContain('兼容版本 v1.2.0')
})

it('checks sorted npm search candidates in bounded sequential batches and extends on demand', async () => {
  const makePlugins = (prefix: string, count: number, category: string, stars: number) => Array.from({ length: count }, (_, index) => {
    const name = prefix + String(index).padStart(3, '0')
    return { ...catalog(name).plugins[0], category, stars, npm: (prefix === 'candidate-' ? '@matching/' : '@other/') + name }
  })
  const plugins = [...makePlugins('other-', 48, 'other', 10), ...makePlugins('candidate-', 140, 'tools', 0), { ...catalog('wrong-category').plugins[0], npm: '@matching/extra', category: 'other' }]
  const catalogResult = { ...catalog('unused'), count: plugins.length, categories: { tools: { zh: '工具' }, other: { zh: '其他' } }, plugins }
  const checks: Array<{ entries: Array<{ name: string; url: string }>; result: ReturnType<typeof deferred<DshMarketCompatibility>> }> = []
  const launcherControl = vi.fn(async ({ command, args }: LauncherControlRequest) => {
    if (command === 'pack.market.catalog') return catalogResult
    const result = deferred<DshMarketCompatibility>()
    checks.push({ entries: args?.entries as Array<{ name: string; url: string }>, result })
    return result.promise
  })
  const finish = async (index: number, matches: string[] = []) => {
    await act(async () => checks[index].result.resolve({ dshVersion: '0.2.1', entries: matches.map(name => entry(name, '1.2.0')) }))
  }
  await render({ launcherControl } as unknown as LauncherApi, 'active', 'a')
  expect(checks).toHaveLength(1)
  expect(checks[0].entries.map(item => item.name)).toEqual(plugins.slice(0, 48).map(item => item.name))
  await filterCompatible()
  expect(container.textContent).toContain('请输入关键词或选择分类')
  await finish(0)
  expect(checks).toHaveLength(1)

  const category = container.querySelector<HTMLSelectElement>('[aria-label="插件分类"]')!
  await act(async () => {
    category.value = 'tools'
    category.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await query('@matching/')
  expect(checks).toHaveLength(2)
  expect(checks[1].entries).toHaveLength(48)
  expect(checks[1].entries[0].name).toBe('candidate-000')
  await finish(1, ['candidate-000'])
  expect(checks).toHaveLength(3)
  expect(checks[2].entries).toHaveLength(48)
  expect(checks[2].entries[0].name).toBe('candidate-048')
  expect(card('candidate-000')).toBeDefined()
  expect(container.textContent).toContain('已检查 48 / 96 个（共 140 个匹配）')
  await finish(2, ['candidate-052'])
  expect(checks).toHaveLength(3)
  expect(card('candidate-052')).toBeDefined()
  await click('继续检查下一批')
  expect(checks).toHaveLength(4)
  expect(checks[3].entries).toHaveLength(44)
  expect(checks[3].entries[0].name).toBe('candidate-096')
  await finish(3, ['candidate-139'])
  expect(card('candidate-139')).toBeDefined()
  expect(container.textContent).toContain('已检查 140 / 140 个（共 140 个匹配）')
})

it('ignores late lookups from a previous pack or API and keeps the typed query', async () => {
  const stalePack = deferred<DshMarketCompatibility>()
  const staleApi = deferred<DshMarketCompatibility>()
  const current = deferred<DshMarketCompatibility>()
  const demoCatalog = catalog('example')
  const launcherControl = vi.fn(async ({ command, packId }: LauncherControlRequest) => {
    if (command === 'pack.market.catalog') return demoCatalog
    return packId === 'a' ? stalePack.promise : staleApi.promise
  })
  const replacement = vi.fn(async ({ command }: LauncherControlRequest) => command === 'pack.market.catalog' ? demoCatalog : current.promise)
  const api = { launcherControl } as unknown as LauncherApi
  await render(api, 'active', 'a')
  await query('@owner/example')
  await render(api, 'active', 'b')
  expect(container.querySelector<HTMLInputElement>('.dsh-market-search input')?.value).toBe('@owner/example')
  await render({ launcherControl: replacement } as unknown as LauncherApi, 'active', 'b')
  expect(container.textContent).toContain('整合包 DSH 版本：未知')
  await act(async () => current.resolve({ dshVersion: '0.4.0', entries: [entry('example', '1.4.0')] }))
  await act(async () => staleApi.resolve({ dshVersion: '0.3.0', entries: [entry('example', '1.3.0')] }))
  await act(async () => stalePack.resolve({ dshVersion: '0.2.0', entries: [entry('example', '1.2.0')] }))
  expect(container.textContent).toContain('整合包 DSH 版本：0.4.0')
  expect(card('example')?.textContent).toContain('兼容版本 v1.4.0')
  expect(card('example')?.textContent).not.toContain('1.3.0')
  expect(card('example')?.textContent).not.toContain('1.2.0')
})

it('discards a lookup from before a catalog refresh even if the same catalog object is returned', async () => {
  const stale = deferred<DshMarketCompatibility>()
  const current = deferred<DshMarketCompatibility>()
  const demoCatalog = catalog('example')
  const checkCompatibility = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise)
  const launcherControl = vi.fn(async ({ command }: LauncherControlRequest) => command === 'pack.market.catalog' ? demoCatalog : checkCompatibility())
  await render({ launcherControl } as unknown as LauncherApi, 'active', 'a')
  expect(checkCompatibility).toHaveBeenCalledTimes(1)
  await click('刷新目录')
  expect(checkCompatibility).toHaveBeenCalledTimes(2)
  await act(async () => stale.resolve({ dshVersion: '0.2.1', entries: [entry('example', '1.2.0')] }))
  expect(installButton('example')?.disabled).toBe(true)
  expect(card('example')?.textContent).toContain('待检查兼容性')
  await act(async () => current.resolve({ dshVersion: '0.3.0', entries: [entry('example', '1.3.0')] }))
  expect(installButton('example')?.disabled).toBe(false)
  expect(card('example')?.textContent).toContain('兼容版本 v1.3.0')
})

function subscribeToMarketProgress() {
  const listeners = new Set<(progress: DshMarketProgress) => void>()
  return {
    onDshMarketProgress: (listener: (progress: DshMarketProgress) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: (progress: Partial<DshMarketProgress>) => act(async () => {
      listeners.forEach(listener => listener({ name: 'example', phase: 'downloading', percent: 40, message: '正在下载依赖', ...progress }))
    }),
  }
}

it('cancels the selected pack install once, waits for its terminal event, and allows a clean retry', async () => {
  const events = subscribeToMarketProgress()
  const first = deferred<{ installed: boolean }>()
  const retry = deferred<{ installed: boolean }>()
  const cancel = deferred<void>()
  const install = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
  const cancelInstall = vi.fn(() => cancel.promise)
  const launcherControl = vi.fn(async ({ command }: LauncherControlRequest) => {
    if (command === 'pack.market.catalog') return { ...catalog('example'), dshVersion: '0.2.1' }
    if (command === 'pack.market.compatibility') return { dshVersion: '0.2.1', entries: [entry('example', '1.4.0')] }
    return install()
  })
  await render({ launcherControl, ...events, cancelInstall } as unknown as LauncherApi, 'global', 'pack-a')
  await click('安装')
  expect(container.textContent).toContain('正在准备安装插件')
  await events.emit({ packId: 'pack-b', operationId: 'other-pack', cancellable: true })
  await events.emit({ operationId: 'global', cancellable: true })
  await events.emit({ packId: 'pack-a', name: 'other', operationId: 'other-plugin', cancellable: true })
  expect(container.textContent).not.toContain('取消安装')
  await events.emit({ packId: 'pack-a', operationId: 'old', cancellable: true })
  const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === '取消安装')!
  expect(button.disabled).toBe(false)
  await act(async () => { button.click(); button.click() })
  expect(cancelInstall).toHaveBeenCalledExactlyOnceWith('old')
  await act(async () => cancel.resolve(undefined))
  expect(container.textContent).toContain('正在取消安装…')
  expect(installButton('example')?.disabled).toBe(true)
  await events.emit({ packId: 'pack-a', operationId: 'old', phase: 'error', cancellable: false, message: '已取消安装。' })
  expect(container.textContent).toContain('已取消安装。')
  expect(container.textContent).not.toContain('正在取消安装…')
  await act(async () => first.resolve({ installed: false }))
  await click('安装')
  await events.emit({ packId: 'pack-a', operationId: 'old', cancellable: true })
  expect(container.textContent).toContain('正在准备安装插件')
  expect(container.textContent).not.toContain('取消安装')
  await events.emit({ packId: 'pack-a', operationId: 'new', cancellable: true })
  await events.emit({ packId: 'pack-a', operationId: 'old', phase: 'error', message: '过期事件' })
  expect(container.textContent).not.toContain('过期事件')
  await events.emit({ packId: 'pack-a', operationId: 'new', phase: 'verifying', cancellable: false, message: '正在写入配置' })
  expect(container.textContent).toContain('正在写入配置')
  expect(container.textContent).not.toContain('取消安装')
  await act(async () => retry.resolve({ installed: true }))
  expect(install).toHaveBeenCalledTimes(2)
})

it('shows global market progress and rejects pack-scoped or ID-less cancel events', async () => {
  const events = subscribeToMarketProgress()
  const install = deferred<unknown>()
  const cancelInstall = vi.fn().mockRejectedValue(new Error('已进入写入阶段'))
  const api = { ...events, cancelInstall, loadDshMarket: async () => catalog('example'), installDshMarketPlugin: () => install.promise } as unknown as LauncherApi
  await render(api, 'global')
  await click('安装')
  await events.emit({ packId: 'pack-a', operationId: 'other', cancellable: true })
  await events.emit({ cancellable: true })
  expect(container.textContent).toContain('正在下载依赖')
  expect(container.textContent).not.toContain('取消安装')
  await events.emit({ operationId: 'global', cancellable: true })
  await click('取消安装')
  expect(cancelInstall).toHaveBeenCalledExactlyOnceWith('global')
  expect(container.textContent).toContain('已进入写入阶段')
  await events.emit({ operationId: 'global', cancellable: false, phase: 'verifying', message: '正在写入配置' })
  expect(container.textContent).toContain('正在写入配置')
  expect(container.textContent).not.toContain('取消安装')
  await act(async () => install.resolve(undefined))
})
