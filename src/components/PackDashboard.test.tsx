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
  await act(async () => root.render(<LauncherApiProvider value={api}><PackDashboard installedDshVersions={['1.0']} onCreate={async () => true} onImport={() => {}} onExport={() => {}} onImportSessions={() => {}} onCloneVersion={() => {}} onRemove={async () => true} onUpgradeVersion={async () => true} onOpenVersions={() => {}} /></LauncherApiProvider>))
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

it('offers pack creation and import on the dashboard itself', async () => {
  const bridge = vi.fn(async (request: { command: string }) => request.command === 'pack.list' ? { packs: [] } : {})
  const onCreate = vi.fn(async () => true)
  const onImport = vi.fn()
  const api = { launcherControl: bridge } as unknown as LauncherApi
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(<LauncherApiProvider value={api}><PackDashboard installedDshVersions={['1.0']} onCreate={onCreate} onImport={onImport} onExport={() => {}} onImportSessions={() => {}} onCloneVersion={() => {}} onRemove={async () => true} onUpgradeVersion={async () => true} onOpenVersions={() => {}} /></LauncherApiProvider>))
  const label = (text: string) => Array.from(container.querySelectorAll('button')).find(button => button.textContent === text) as HTMLButtonElement | undefined
  expect(label('新建整合包')).toBeDefined()
  expect(label('导入整合包')).toBeDefined()
  await act(async () => label('新建整合包')!.click())
  expect(container.querySelector('input[aria-label="整合包名称"]')).not.toBeNull()
  expect(container.querySelector('select[aria-label="DSH 版本"]')!.textContent).toContain('DSH 1.0')
  await act(async () => label('导入整合包')!.click())
  expect(onImport).toHaveBeenCalledTimes(1)
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
it('deletes a pack only after an inline confirmation and stops it first', async () => {
  const requests: Array<{ command: string; packId?: string }> = []
  const packs = [{ id: 'alpha', name: 'Alpha', dshVersion: '1.0', installedAt: '2025-01-01', config: { portMode: 'auto', port: 3080, runAsAdmin: false, autoStart: false, pinnedAt: null }, runtime: { running: true, port: 3080, url: 'http://127.0.0.1:3080' } }]
  const bridge = vi.fn(async (request: { command: string; packId?: string }) => { requests.push(request); return request.command === 'pack.list' ? { packs } : {} })
  const api = { launcherControl: bridge } as unknown as LauncherApi
  const onRemove = vi.fn(async () => true)
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(<LauncherApiProvider value={api}><PackDashboard installedDshVersions={['1.0']} onCreate={async () => true} onImport={() => {}} onExport={() => {}} onImportSessions={() => {}} onCloneVersion={() => {}} onRemove={onRemove} onUpgradeVersion={async () => true} onOpenVersions={() => {}} /></LauncherApiProvider>))
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === label || item.getAttribute('aria-label') === label) as HTMLButtonElement
  await act(async () => button('删除 Alpha').click())
  // 第一下只是进入确认态：不删、不停。
  expect(onRemove).not.toHaveBeenCalled()
  expect(requests.some(request => request.command === 'pack.stop')).toBe(false)
  await act(async () => button('确认删除').click())
  expect(requests).toContainEqual({ command: 'pack.stop', packId: 'alpha', args: undefined })
  expect(onRemove).toHaveBeenCalledWith('alpha')
})
