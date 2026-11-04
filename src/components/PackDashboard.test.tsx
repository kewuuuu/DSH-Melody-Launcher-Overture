// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../api/client'
import type { LauncherApi } from '../types'
import { PackDashboard } from './PackDashboard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })
it('routes row and resource actions to the selected pack while retaining the market return target', async () => {
  const requests: Array<{ command: string; packId?: string; args?: Record<string, unknown> }> = []
  const packs = ['Alpha', 'Beta'].map((name, index) => ({ id: name.toLowerCase(), name, dshVersion: '1.0', installedAt: '2025-01-01', config: { portMode: 'auto', port: 3080 + index, runAsAdmin: false, autoStart: false, pinnedAt: null }, runtime: { running: false, port: null, url: null } }))
  const bridge = vi.fn(async (request: typeof requests[number]) => {
    requests.push(request)
    if (request.command === 'pack.list') return { packs }
    if (request.command === 'pack.resources.list') return { items: [{ packageName: 'demo-plugin', displayName: 'Demo Plugin', description: 'test', enabled: true, locked: false, sourcePackId: 'alpha', sourcePackName: 'Alpha' }] }
    return {}
  })
  const api = { launcherControl: bridge, loadDshMarket: async () => ({ plugins: [], categories: {} }), onDshMarketProgress: () => () => {} } as unknown as LauncherApi
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(<LauncherApiProvider value={api}><PackDashboard onManage={() => {}} onImport={() => {}} onExport={() => {}} onImportSessions={() => {}} onCloneVersion={() => {}} /></LauncherApiProvider>))
  const click = async (selector: string) => { const button = container.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull(); await act(async () => button!.click()) }
  await click('tbody tr:nth-child(2) .primary-button')
  expect(requests).toContainEqual({ command: 'pack.start', packId: 'beta', args: undefined })
  await click('[aria-label="配置 Beta"]')
  const dialog = container.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('整合包配置 · Beta')
  const pluginTab = Array.from(dialog.querySelectorAll('nav button')).find(button => button.textContent === '插件') as HTMLButtonElement
  await act(async () => pluginTab.click())
  expect(dialog.textContent).toContain('共享引用 · Alpha')
  await act(async () => (dialog.querySelector('input[aria-label="启用 demo-plugin"]') as HTMLInputElement).click())
  expect(requests).toContainEqual({ command: 'pack.resources.enabled', packId: 'beta', args: { kind: 'plugins', name: 'demo-plugin', enabled: false } })
  await act(async () => (Array.from(dialog.querySelectorAll('button')).find(button => button.textContent === '安装插件') as HTMLButtonElement).click())
  expect(dialog.textContent).toContain('返回 Beta 的插件列表')
  expect(requests.filter(request => request.packId && request.packId !== 'beta')).toHaveLength(0)
})

it('does not overwrite the neutral market cache with a target pack installation state', async () => {
  const { DshMarketView } = await import('../views/DshMarketView')
  const catalog = { updated: '', count: 1, categories: {}, plugins: [{ name: 'example', owner: 'owner', url: 'https://example.com', category: 'tools', description: { zh: 'Example' }, npm: '@owner/example', stars: 0, added: '', install: '', installed: false, enabled: false, version: null, updateAvailable: false, updateVersion: null }] }
  const api = { loadDshMarket: async () => catalog, launcherControl: async () => ({ items: [{ packageName: '@owner/example', enabled: true }] }), onDshMarketProgress: () => () => {} } as unknown as LauncherApi
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(<LauncherApiProvider value={api}><DshMarketView activeProfileName={null} targetPackId="beta" /></LauncherApiProvider>))
  expect(container.textContent).toContain('已启用')
  expect(catalog.plugins[0].installed).toBe(false)
  expect(catalog.plugins[0].enabled).toBe(false)
  const neverLoadingApi = { ...api, loadDshMarket: () => new Promise(() => {}) } as unknown as LauncherApi
  await act(async () => root.render(<LauncherApiProvider value={neverLoadingApi}><DshMarketView key="global" activeProfileName="alpha" /></LauncherApiProvider>))
  expect(container.querySelector('.market-enabled')).toBeNull()
})
