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

it('reports unverified external instances and blocks local lifecycle actions', async () => {
  const { container, requests } = await mountDashboard([
    demoPack({ externalRuntime: unmanagedRuntime }),
    demoPack({ id: 'beta', name: 'Beta' }),
  ])
  const row = container.querySelector('tbody tr')!
  expect(row.querySelector('.pack-external-state')?.textContent).toBe('外部实例待核实 · PID 3420 · :3080')
  expect(row.textContent).toContain('请在原启动环境中退出该实例')
  expect(row.querySelector<HTMLButtonElement>('.primary-button')?.disabled).toBe(true)
  expect(row.querySelector<HTMLButtonElement>('[aria-label="删除 Alpha"]')?.disabled).toBe(true)
  expect(row.querySelector('[aria-label^="强制停止"], [aria-label^="停止未托管实例"], [aria-label^="打开网页"]')).toBeNull()
  expect(container.querySelector('.pack-dashboard-footer')?.textContent).toContain('另有 1 个外部实例待核实')
  await act(async () => row.querySelector<HTMLButtonElement>('.primary-button')!.click())
  expect(requests.map(request => request.command)).toEqual(['pack.list'])
  expect(container.querySelector<HTMLButtonElement>('tbody tr:nth-child(2) .primary-button')?.disabled).toBe(false)
})

const observedRuntime = { running: true, ownership: 'observer', pid: 3420, startedAt: '2025-01-02T03:04:05.000Z', port: 3080, url: 'http://127.0.0.1:3080' }

it('lets an observer open Web and requires confirmation before force-stopping', async () => {
  const { container, requests } = await mountDashboard([demoPack({ runtime: observedRuntime })])
  const get = (label: string) => container.querySelector<HTMLButtonElement>('[aria-label="' + label + '"]')!
  const click = async (label: string) => act(async () => get(label).click())
  const stopRequests = () => requests.filter(request => request.command === 'pack.stop')
  expect(container.textContent).toContain('运行中（仅观察）')
  expect(container.querySelector('tbody .primary-button, tbody button[title="停止"], [aria-label="重启 Alpha"]')).toBeNull()
  expect(get('删除 Alpha').disabled).toBe(true)
  await click('打开网页 Alpha')
  expect(requests).toContainEqual({ command: 'pack.openWeb', packId: 'alpha', args: undefined })
  await click('强制停止 Alpha')
  expect(stopRequests()).toHaveLength(0)
  await click('取消强制停止 Alpha')
  expect(stopRequests()).toHaveLength(0)
  await click('强制停止 Alpha')
  await click('确认强制停止 Alpha')
  expect(stopRequests()).toEqual([{ command: 'pack.stop', packId: 'alpha', args: { force: true } }])
})

it('reports a failed observer force-stop inline and disables Web without a verified endpoint', async () => {
  const message = '无法确认当前实例的身份'
  const { container } = await mountDashboard([demoPack({ runtime: { ...observedRuntime, url: null } })], message)
  expect(container.querySelector<HTMLButtonElement>('[aria-label="打开网页 Alpha"]')?.disabled).toBe(true)
  for (const label of ['强制停止 Alpha', '确认强制停止 Alpha']) {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="' + label + '"]')!.click())
  }
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(message)
  expect(container.querySelector('.pack-error')).toBeNull()
  expect(container.querySelector('[aria-label="强制停止 Alpha"]')).not.toBeNull()
})

it('shows the diagnostic and withholds force-stop when an observer has no PID', async () => {
  const lastError = '发现多个候选实例，无法核实进程身份'
  const runtime = { ...observedRuntime, pid: null, port: null, url: null, lastError }
  const { container, requests } = await mountDashboard([demoPack({ runtime })])
  expect(container.textContent).toContain('检测到运行实例（身份待核实）')
  expect(container.querySelector('[role="status"]')?.textContent).toBe(lastError)
  expect(container.querySelector('tbody .primary-button, [aria-label^="强制停止"], [aria-label^="打开网页"]')).toBeNull()
  expect(container.querySelector<HTMLButtonElement>('[aria-label="删除 Alpha"]')?.disabled).toBe(true)
  expect(requests.map(request => request.command)).toEqual(['pack.list'])
})

it.each([[0, '0 个活跃会话'], [2, '2 个活跃会话'], [null, '活跃会话数未知'], [undefined, '活跃会话数未知']])(
  'shows the active session count %s on running pack rows',
  async (activeSessionCount, label) => {
    const { container } = await mountDashboard([
      demoPack({ runtime: { ...observedRuntime, activeSessionCount } }),
      demoPack({ id: 'beta', name: 'Beta', runtime: { ...observedRuntime, ownership: 'owned', activeSessionCount } }),
      demoPack({ id: 'gamma', name: 'Gamma' }),
    ])
    const rows = container.querySelectorAll('tbody tr')
    expect(rows[0].textContent).toContain(label)
    expect(rows[1].textContent).toContain(label)
    expect(rows[2].textContent).not.toContain('活跃会话')
  },
)

it('keeps normal stop and restart controls for owned runtimes', async () => {
  const { container, requests } = await mountDashboard([demoPack({ runtime: { ...observedRuntime, ownership: 'owned' } })])
  expect(container.textContent).toContain('运行中（本启动器管理）')
  expect(container.querySelector('[aria-label="强制停止 Alpha"]')).toBeNull()
  for (const selector of ['button[title="停止"]', '[aria-label="重启 Alpha"]']) {
    await act(async () => container.querySelector<HTMLButtonElement>(selector)!.click())
  }
  expect(requests).toContainEqual({ command: 'pack.stop', packId: 'alpha', args: undefined })
  expect(requests).toContainEqual({ command: 'pack.restart', packId: 'alpha', args: undefined })
})
