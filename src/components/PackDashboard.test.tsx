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

it('shows an in-flight restart with a force stop, and the reason it failed', async () => {
  const requests: Array<{ command: string; packId?: string; args?: Record<string, unknown> }> = []
  const packs = [{
    id: 'alpha', name: 'Alpha', dshVersion: '1.0', installedAt: '2025-01-01',
    config: { portMode: 'auto', port: 3080, runAsAdmin: true, autoStart: false, pinnedAt: null },
    runtime: { running: false, port: null, url: null, restarting: true, awaitingAuthorization: true, lastError: '重启整合包失败：端口 3080 被占用' },
  }]
  const bridge = vi.fn(async (request: typeof requests[number]) => {
    requests.push(request)
    return request.command === 'pack.list' ? { packs } : {}
  })
  const api = { launcherControl: bridge } as unknown as LauncherApi
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(<LauncherApiProvider value={api}><PackDashboard installedDshVersions={['1.0']} onCreate={async () => true} onImport={() => {}} onExport={() => {}} onImportSessions={() => {}} onCloneVersion={() => {}} onRemove={async () => true} onUpgradeVersion={async () => true} onOpenVersions={() => {}} /></LauncherApiProvider>))
  // 后台重启期间不能只留一个「启动」按钮：说明在等什么，并给出强制停止的出口。
  expect(container.textContent).toContain('等待管理员授权')
  expect(container.textContent).toContain('重启整合包失败：端口 3080 被占用')
  const force = container.querySelector<HTMLButtonElement>('[aria-label="强制停止 Alpha"]')
  expect(force).not.toBeNull()
  await act(async () => force!.click())
  expect(requests).toContainEqual({ command: 'pack.stop', packId: 'alpha', args: { force: true } })
})

it('warns that the per-pack admin switch costs one UAC per start', async () => {
  const bridge = vi.fn(async (request: { command: string }) => request.command === 'pack.list'
    ? { packs: [{ id: 'alpha', name: 'Alpha', dshVersion: '1.0', installedAt: '2025-01-01', config: { portMode: 'auto', port: 3080, runAsAdmin: true, autoStart: false, pinnedAt: null }, runtime: { running: false, port: null, url: null } }] }
    : {})
  const api = { launcherControl: bridge } as unknown as LauncherApi
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(<LauncherApiProvider value={api}><PackDashboard installedDshVersions={['1.0']} onCreate={async () => true} onImport={() => {}} onExport={() => {}} onImportSessions={() => {}} onCloneVersion={() => {}} onRemove={async () => true} onUpgradeVersion={async () => true} onOpenVersions={() => {}} /></LauncherApiProvider>))
  // 勾了「管理员」的包每次启动各弹一次 UAC：勾选框与页脚都要说清楚，并指向启动器级的单次开关。
  const box = container.querySelector<HTMLInputElement>('[aria-label="以管理员运行 Alpha"]')!
  expect(box.title).toContain('每次启动都会弹一次 UAC')
  expect(container.textContent).toContain('每次启动都会弹一次 UAC')
  expect(container.textContent).toContain('启动器启动时请求管理员权限')
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

/** 启动器之外仍在跑的实例（pid 3420 / :3080 正是这次报障的那一个）。 */
const unmanagedRuntime = { pid: 3420, port: 3080, startedAt: '2025-01-02T03:04:05.000Z', url: 'http://127.0.0.1:3080', profileName: 'alpha', requiresElevation: true, elevatedSession: null }

function demoPack(overrides: Record<string, unknown> = {}) {
  return { id: 'alpha', name: 'Alpha', dshVersion: '1.0', installedAt: '2025-01-01', config: { portMode: 'auto', port: 3080, runAsAdmin: true, autoStart: false, pinnedAt: null }, runtime: { running: false, port: null, url: null }, ...overrides }
}

/** 最小壳：接了 pack.list / pack.stop，只关心「点了发什么」和「失败显示什么」。 */
async function mountDashboard(packs: unknown[], stopError?: string) {
  const requests: Array<{ command: string; packId?: string; args?: Record<string, unknown> }> = []
  const bridge = vi.fn(async (request: { command: string; packId?: string; args?: Record<string, unknown> }): Promise<unknown> => {
    requests.push(request)
    if (request.command === 'pack.stop' && stopError) throw new Error(stopError)
    if (request.command === 'pack.list') return { packs }
    return {}
  })
  const api = { launcherControl: bridge } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(<LauncherApiProvider value={api}><PackDashboard installedDshVersions={['1.0']} onCreate={async () => true} onImport={() => {}} onExport={() => {}} onImportSessions={() => {}} onCloneVersion={() => {}} onRemove={async () => true} onUpgradeVersion={async () => true} onOpenVersions={() => {}} /></LauncherApiProvider>))
  return { container, requests }
}

it('reports an unmanaged instance with its pid and port, outside the managed running total', async () => {
  const { container } = await mountDashboard([
    demoPack({ externalRuntime: unmanagedRuntime }),
    demoPack({ id: 'beta', name: 'Beta', externalRuntime: { ...unmanagedRuntime, pid: 99, port: null, profileName: 'beta' } }),
  ])
  expect(Array.from(container.querySelectorAll('.pack-external-state')).map(node => node.textContent))
    .toEqual(['外部运行中 · PID 3420 · :3080', '外部运行中 · PID 99'])
  const footer = container.querySelector('.pack-dashboard-footer')!.textContent!
  expect(footer).toContain('0 个正在运行')
  expect(footer).toContain('另有 2 个未托管实例在运行')
  expect(container.querySelector('[aria-label="停止未托管实例 Alpha"]')!.getAttribute('title')).toContain('停止会中断它上面正在进行的对话')
})

it('stops the unmanaged instance through pack.stop with that pack id', async () => {
  const { container, requests } = await mountDashboard([demoPack({ externalRuntime: unmanagedRuntime })])
  const stop = container.querySelector<HTMLButtonElement>('[aria-label="停止未托管实例 Alpha"]')
  expect(stop).not.toBeNull()
  await act(async () => stop!.click())
  expect(requests).toContainEqual({ command: 'pack.stop', packId: 'alpha', args: undefined })
})

it('disables start while an unmanaged instance holds the pack', async () => {
  const { container } = await mountDashboard([demoPack({ externalRuntime: unmanagedRuntime }), demoPack({ id: 'beta', name: 'Beta' })])
  const start = (name: string) => Array.from(container.querySelectorAll('tbody tr')).find(row => row.textContent?.includes(name))!.querySelector<HTMLButtonElement>('.primary-button')!
  expect(start('Alpha').disabled).toBe(true)
  expect(start('Alpha').getAttribute('title')).toBe('先停止未托管的实例')
  expect(start('Beta').disabled).toBe(false)
})

it('reports a failed unmanaged stop inline instead of the page-level alert', async () => {
  const message = '结束 PID 3420 失败：需要管理员权限'
  const { container, requests } = await mountDashboard([demoPack({ externalRuntime: unmanagedRuntime })], message)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止未托管实例 Alpha"]')!.click())
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(message)
  expect(container.querySelector('.pack-error')).toBeNull()
  expect(requests.filter(request => request.command === 'pack.stop')).toHaveLength(1)
  // 失败后实例还在，按钮仍可再点一次。
  expect(container.querySelector('[aria-label="停止未托管实例 Alpha"]')).not.toBeNull()
})
