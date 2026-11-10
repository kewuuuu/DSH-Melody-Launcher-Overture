// @vitest-environment jsdom
import { act } from 'react'
import type { ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../../api/client'
import { HOME_TABS, HOME_TAB_ORDER } from '../../lib/nav'
import type { IdleShutdownState, LauncherApi, LauncherUpdateStatus } from '../../types'
import { StartView } from './StartView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })

/** 关机状态是一份完整快照：每个用例只改自己关心的字段。 */
function idleState(overrides: Partial<IdleShutdownState> = {}): IdleShutdownState {
  return {
    enabled: false,
    phase: 'off',
    idleMinutes: 10,
    graceMinutes: 10,
    stopPacks: true,
    idleSince: null,
    shutdownAt: null,
    busy: [],
    message: null,
    ...overrides,
  }
}

/** 默认的关机接口：关着，arm 之后进入等待空闲。 */
function idleApi(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn(async () => idleState()),
    arm: vi.fn(async () => idleState({ enabled: true, phase: 'waiting' })),
    disarm: vi.fn(async () => idleState()),
    cancel: vi.fn(async () => idleState({ enabled: true, phase: 'waiting' })),
    ...overrides,
  }
}

/** 余额/用量/更新检查只是若干 IPC 通路：这里给出最小可用的假实现，断言都落在返回值上。 */
function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    idleShutdown: idleApi(),
    deepseekBalance: vi.fn(async () => ({
      status: 'ok',
      balance: { isAvailable: true, infos: [{ currency: 'CNY', totalBalance: 12.5, grantedBalance: 0, toppedUpBalance: 12.5 }] },
    })),
    dshUsage: vi.fn(async () => ({ status: 'ok', usage: { tokensToday: 12345, cacheHitRate: 0.5 } })),
    checkLauncherUpdate: vi.fn(async (): Promise<LauncherUpdateStatus> => ({
      state: 'up-to-date',
      localVersion: '1.2.3',
      remoteVersion: '1.2.3',
      releaseUrl: '',
      assetName: '',
      assetSize: 0,
      checkedAt: '2026-11-07T00:00:00.000Z',
      message: '已是最新',
    })),
    openExternal: vi.fn(async () => {}),
    ...overrides,
  } as unknown as LauncherApi
}

async function render(ui: ReactElement) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(ui))
  // 挂载后的余额/用量是两段 await：再让一轮微任务跑完才落到终态。
  await act(async () => { await Promise.resolve() })
  return container
}

function startView(api: LauncherApi, extra: Partial<Parameters<typeof StartView>[0]> = {}) {
  return (
    <LauncherApiProvider value={api}>
      <StartView logoSrc={null} update={null} busy={false} onUpdateChecked={() => {}} onOpenSettings={() => {}} {...extra} />
    </LauncherApiProvider>
  )
}

it('shows the balance card with today tokens and a usage link that opens the platform page', async () => {
  const api = fakeApi()
  const container = await render(startView(api))
  expect(container.textContent).toContain('12.50')
  expect(container.textContent).toContain('12.3K')
  expect(container.textContent).toContain('缓存命中 50.0%')
  const link = container.querySelector<HTMLAnchorElement>('a.start-link')
  expect(link).not.toBeNull()
  expect(link!.getAttribute('href')).toBe('https://platform.deepseek.com/usage')
  expect(link!.textContent).toContain('查看用量')
  await act(async () => link!.click())
  expect(api.openExternal).toHaveBeenCalledWith('https://platform.deepseek.com/usage')
})

it('explains a missing API key instead of showing an empty balance', async () => {
  const api = fakeApi({ deepseekBalance: vi.fn(async () => ({ status: 'no-key' })) })
  const container = await render(startView(api))
  expect(container.textContent).toContain('还没有配置 API Key')
  expect(container.querySelector('.start-amount')).toBeNull()
})

it('asks the main process for updates when the check button is pressed', async () => {
  const api = fakeApi()
  const onUpdateChecked = vi.fn()
  const container = await render(startView(api, { onUpdateChecked }))
  const button = container.querySelector<HTMLButtonElement>('.start-check-update')
  expect(button).not.toBeNull()
  await act(async () => button!.click())
  expect(api.checkLauncherUpdate).toHaveBeenCalledTimes(1)
  expect(onUpdateChecked).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('已是最新版本 v1.2.3')
})

it('打开自动关机开关就调用 arm，并显示等待空闲与占用的整合包', async () => {
  const api = fakeApi({
    idleShutdown: idleApi({
      arm: vi.fn(async () => idleState({
        enabled: true,
        phase: 'waiting',
        idleMinutes: 15,
        busy: [{ packId: 'pack-a', reason: '正在生成回复' }],
      })),
    }),
  })
  const container = await render(startView(api))
  const box = container.querySelector<HTMLInputElement>('input[aria-label="任务完成后自动关机"]')
  expect(box, '自动关机开关不存在').toBeTruthy()
  expect(box!.checked).toBe(false)
  expect(container.textContent).not.toContain('等待所有整合包空闲')
  await act(async () => { box!.click() })
  await act(async () => {})
  expect(api.idleShutdown.arm).toHaveBeenCalledTimes(1)
  expect(box!.checked).toBe(true)
  expect(container.textContent).toContain('等待所有整合包空闲')
  expect(container.textContent).toContain('空闲判定 15 分钟')
  expect(container.textContent).toContain('pack-a：正在生成回复')
})

it('已排定关机时显示本地时间与取消按钮，点击调用 cancel', async () => {
  const api = fakeApi({
    idleShutdown: idleApi({
      get: vi.fn(async () => idleState({ enabled: true, phase: 'armed', shutdownAt: '2026-11-10T12:30:00.000Z' })),
    }),
  })
  const container = await render(startView(api))
  expect(container.textContent).toMatch(/将于 \d\d:\d\d 关机/)
  const cancel = container.querySelector<HTMLButtonElement>('.start-shutdown-cancel')
  expect(cancel, '取消按钮不存在').toBeTruthy()
  expect(cancel!.textContent).toContain('取消本次关机')
  await act(async () => { cancel!.click() })
  await act(async () => {})
  expect(api.idleShutdown.cancel).toHaveBeenCalledTimes(1)
  expect(container.textContent).toContain('等待所有整合包空闲')
  expect(container.querySelector('.start-shutdown-cancel')).toBeNull()
})

it('keeps the tab order and Chinese labels the top bar renders', () => {
  expect(HOME_TABS.map(tab => tab.id)).toEqual(['start', 'packs', 'versions', 'plugins', 'skills', 'presets', 'settings'])
  expect(HOME_TABS.map(tab => tab.label)).toEqual(['启动', '整合包', 'DSH版本', '插件', '技能', '预设', '设置'])
  expect(HOME_TAB_ORDER).toEqual(HOME_TABS.map(tab => tab.id))
})
