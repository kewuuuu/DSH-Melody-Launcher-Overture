// @vitest-environment jsdom
import { act, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../api/client'
import type { DshMarketCatalog, LauncherApi } from '../types'
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
  const api = { loadDshMarket, onDshMarketProgress: () => () => {} } as unknown as LauncherApi
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
})

it('ignores a stale target check and updates the exact package in the selected pack', async () => {
  const lateCheck = deferred<DshMarketCatalog>()
  let updated = false
  const launcherControl = vi.fn(async ({ command, packId, args }: Parameters<NonNullable<LauncherApi['launcherControl']>>[0]) => {
    if (command === 'pack.market.update') { updated = true; return {} }
    if (packId === 'a') return args?.checkUpdates ? lateCheck.promise : catalog('alpha', '1.0.0')
    return catalog('beta', updated ? '1.1.0' : '1.0.0', args?.checkUpdates && !updated ? '1.1.0' : null)
  })
  const loadDshMarket = vi.fn()
  const checkDshMarketUpdates = vi.fn()
  const api = { launcherControl, loadDshMarket, checkDshMarketUpdates } as unknown as LauncherApi
  await render(api, 'alpha', 'a')
  expect(launcherControl).toHaveBeenCalledTimes(1)
  await click('检查更新')
  await render(api, 'alpha', 'b')
  expect(container.textContent).not.toContain('alpha')
  await click('检查更新')
  await act(async () => lateCheck.resolve(catalog('alpha-stale', '1.0.0', '1.1.0')))
  expect(container.textContent).not.toContain('alpha-stale')
  await click('更新')
  expect(launcherControl).toHaveBeenCalledWith({ command: 'pack.market.update', packId: 'b', args: { name: 'beta', url: 'https://github.com/owner/beta', packageName: '@owner/beta' } })
  expect(container.textContent).toContain('v1.1.0')
  expect(Array.from(container.querySelectorAll('button')).some(button => button.textContent === '更新')).toBe(false)
  expect(loadDshMarket).not.toHaveBeenCalled()
  expect(checkDshMarketUpdates).not.toHaveBeenCalled()
})
