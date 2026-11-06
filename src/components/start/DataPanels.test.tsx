// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LauncherApiProvider } from '../../api/client'
import type { LauncherApi, LauncherPluginInfo, LauncherPluginPanel, LauncherPluginsState } from '../../types'
import { DataPanels } from './DataPanels'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.innerHTML = ''
})

type Call = { name: string; args: unknown[] }

async function mount(
  panels: LauncherPluginPanel[],
  plugins: LauncherPluginInfo[] = [{ name: 'demo', title: '演示插件', hasCode: true, error: null }],
) {
  const calls: Call[] = []
  const state: LauncherPluginsState = { plugins, panels, fetchedAt: Date.now(), directory: 'C:\\demo\\launcher-plugins' }
  const api = {
    launcherPlugins: {
      list: async () => { calls.push({ name: 'list', args: [] }); return state },
      refresh: async () => { calls.push({ name: 'refresh', args: [] }); return state },
      openFolder: async () => { calls.push({ name: 'openFolder', args: [] }) },
    },
    openExternal: async (url: string) => { calls.push({ name: 'openExternal', args: [url] }) },
  } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<LauncherApiProvider value={api}><DataPanels /></LauncherApiProvider>) })
  await act(async () => {})
  return { container, calls }
}

it('list 面板逐行渲染，带 href 的行点击走 openExternal 而不是新窗口', async () => {
  const { container, calls } = await mount([{
    id: 'demo:tokens', plugin: 'demo', title: '今日 Token', type: 'list',
    items: [{ label: '输入', value: '1.2M' }, { label: '官方用量页', href: 'https://platform.deepseek.com/usage' }],
  }])
  const rows = Array.from(container.querySelectorAll('.dp-list .dp-row')) as HTMLElement[]
  expect(rows).toHaveLength(2)
  expect(rows[0].textContent).toContain('输入')
  expect(rows[0].textContent).toContain('1.2M')
  await act(async () => { rows[1].click() })
  expect(calls.find(call => call.name === 'openExternal')?.args).toEqual(['https://platform.deepseek.com/usage'])
  expect(rows[1].getAttribute('target')).toBeNull()
})

it('table 面板渲染表头与每一行', async () => {
  const { container } = await mount([{
    id: 'demo:table', plugin: 'demo', title: '用量明细', type: 'table',
    columns: ['模型', 'Token'], rows: [['deepseek-chat', '1.2M'], ['deepseek-reasoner', '86K']],
  }])
  expect(Array.from(container.querySelectorAll('.dp-table th')).map(node => node.textContent)).toEqual(['模型', 'Token'])
  const cells = Array.from(container.querySelectorAll('.dp-table tbody tr')).map(row => Array.from(row.querySelectorAll('td')).map(td => td.textContent))
  expect(cells).toEqual([['deepseek-chat', '1.2M'], ['deepseek-reasoner', '86K']])
})

it('html 面板放进 sandbox="" 的 iframe，不给 allow-scripts', async () => {
  const { container } = await mount([{
    id: 'demo:html', plugin: 'demo', title: '自绘面板', type: 'html', html: '<!doctype html><b id="k">ok</b>',
  }])
  const frame = container.querySelector('.dp-html') as HTMLIFrameElement
  expect(frame).toBeTruthy()
  expect(frame.tagName).toBe('IFRAME')
  expect(frame.getAttribute('sandbox')).toBe('')
  expect(frame.getAttribute('sandbox') ?? '').not.toContain('allow-scripts')
  expect(frame.getAttribute('sandbox') ?? '').not.toContain('allow-same-origin')
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(frame.getAttribute('srcdoc')).toContain('id="k"')
})

it('多个面板一次显示一页，箭头与圆点都能翻页', async () => {
  const { container } = await mount([
    { id: 'a', plugin: 'demo', title: '面板甲', type: 'list', items: [{ label: '甲项', value: '1' }] },
    { id: 'b', plugin: 'demo', title: '面板乙', type: 'list', items: [{ label: '乙项', value: '2' }] },
  ])
  expect(container.querySelector('.dp-slide')?.textContent).toContain('甲项')
  expect(container.querySelector('.dp-page')?.textContent).toBe('1 / 2')
  await act(async () => { (container.querySelector('[aria-label="下一个面板"]') as HTMLButtonElement).click() })
  expect(container.querySelector('.dp-slide')?.textContent).toContain('乙项')
  expect(container.querySelector('.dp-page')?.textContent).toBe('2 / 2')
  await act(async () => { (container.querySelector('[aria-label="第 1 个面板"]') as HTMLButtonElement).click() })
  expect(container.querySelector('.dp-slide')?.textContent).toContain('甲项')
})

it('刷新按钮调用 refresh，加载失败的插件在面板下方给出提示', async () => {
  const { container, calls } = await mount(
    [{ id: 'a', plugin: 'demo', title: '面板甲', type: 'list', items: [{ label: '甲项' }] }],
    [{ name: 'broken', title: '坏插件', hasCode: true, error: 'manifest 缺失' }],
  )
  expect(container.textContent).toContain('插件 坏插件 加载失败：manifest 缺失')
  expect(calls.some(call => call.name === 'list')).toBe(true)
  await act(async () => { (container.querySelector('[aria-label="刷新数据面板"]') as HTMLButtonElement).click() })
  await act(async () => {})
  expect(calls.some(call => call.name === 'refresh')).toBe(true)
  await act(async () => { (container.querySelector('[aria-label="打开插件文件夹"]') as HTMLButtonElement).click() })
  expect(calls.some(call => call.name === 'openFolder')).toBe(true)
})

it('没有面板时保留空状态文案', async () => {
  const { container } = await mount([])
  expect(container.textContent).toContain('还没有数据面板 · 把插件放进数据目录的 launcher-plugins 文件夹')
})
