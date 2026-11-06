// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LauncherApiProvider } from '../api/client'
import type { LauncherApi, PendingResumeEntry } from '../types'
import { PendingResumesBanner } from './PendingResumesBanner'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.innerHTML = ''
})

type Call = { name: string; args: unknown[] }

const entry = (overrides: Partial<PendingResumeEntry> = {}): PendingResumeEntry => ({
  id: 'r1',
  packId: 'Web 基础包',
  prompt: '请继续把这份报告的图表补齐，尤其是第四季度的对比',
  requestId: 'req-1',
  createdAt: Date.now(),
  attempts: 1,
  status: 'pending',
  error: null,
  ...overrides,
})

async function mount(seed: PendingResumeEntry[]) {
  const calls: Call[] = []
  let current = seed
  const api = {
    pendingResumes: {
      list: async () => { calls.push({ name: 'list', args: [] }); return current },
      retry: async (id: string) => {
        calls.push({ name: 'retry', args: [id] })
        current = current.map(item => (item.id === id ? { ...item, status: 'sent' as const, attempts: item.attempts + 1 } : item))
        return { ok: true, error: null, entries: current }
      },
      discard: async (id: string) => {
        calls.push({ name: 'discard', args: [id] })
        current = current.filter(item => item.id !== id)
        return current
      },
    },
  } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<LauncherApiProvider value={api}><PendingResumesBanner /></LauncherApiProvider>) })
  await act(async () => {})
  const buttonIn = (label: string) => {
    const found = Array.from(container.querySelectorAll('button'))
      .find(item => (item.textContent ?? '').replace(/\s+/g, '') === label)
    expect(found, '按钮不存在：' + label).toBeTruthy()
    return found as HTMLButtonElement
  }
  return { container, calls, buttonIn }
}

it('有待发条目时显示数量并在展开后列出包名与 prompt', async () => {
  const { container, buttonIn } = await mount([entry(), entry({ id: 'r2', packId: 'CC TUI 终端包', status: 'failed', error: '运行时已退出' })])
  expect(container.textContent).toContain('2 条对话请求等待续接')
  await act(async () => { (container.querySelector('.pending-resumes-head') as HTMLButtonElement).click() })
  const items = Array.from(container.querySelectorAll('.pending-resumes-item')) as HTMLElement[]
  expect(items).toHaveLength(2)
  expect(items[0].textContent).toContain('Web 基础包')
  expect(items[0].textContent).toContain('请继续把这份报告的图表补齐')
  expect(items[0].textContent).toContain('等待发送')
  expect(items[1].textContent).toContain('发送失败')
  expect(items[1].textContent).toContain('运行时已退出')
  expect(buttonIn('重试')).toBeTruthy()
  expect(buttonIn('放弃')).toBeTruthy()
})

it('点重试带正确 id 调 retry', async () => {
  const { container, calls } = await mount([entry(), entry({ id: 'r2', packId: '另一个包' })])
  await act(async () => { (container.querySelector('.pending-resumes-head') as HTMLButtonElement).click() })
  const first = container.querySelectorAll('.pending-resumes-item')[0] as HTMLElement
  const retryButton = Array.from(first.querySelectorAll('button')).find(item => (item.textContent ?? '').includes('重试')) as HTMLButtonElement
  await act(async () => { retryButton.click() })
  await act(async () => {})
  expect(calls.find(call => call.name === 'retry')?.args).toEqual(['r1'])
})

it('没有条目时整块不渲染', async () => {
  const { container } = await mount([])
  expect(container.querySelector('.pending-resumes')).toBeNull()
  expect(container.textContent).toBe('')
})

it('放弃要两步确认，确认前不调 discard', async () => {
  const { container, calls, buttonIn } = await mount([entry()])
  await act(async () => { (container.querySelector('.pending-resumes-head') as HTMLButtonElement).click() })
  await act(async () => { buttonIn('放弃').click() })
  expect(container.textContent).toContain('放弃后这条请求不会再自动发出')
  expect(calls.some(call => call.name === 'discard')).toBe(false)
  await act(async () => { buttonIn('确认放弃').click() })
  await act(async () => {})
  expect(calls.find(call => call.name === 'discard')?.args).toEqual(['r1'])
  expect(container.querySelector('.pending-resumes')).toBeNull()
})
