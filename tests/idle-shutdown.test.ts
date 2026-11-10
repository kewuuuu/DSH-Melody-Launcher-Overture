import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/types'
import { defaultSettings } from '../electron/settings'
import { createIdleShutdownService, IDLE_SHUTDOWN_COMMENT, type IdleShutdownPack } from '../electron/idle-shutdown'

const BASE_TIME = Date.parse('2026-01-01T08:00:00.000Z')
const MINUTE = 60_000

function createHarness(overrides: Partial<AppSettings> = {}) {
  let clock = BASE_TIME
  let stored: AppSettings = {
    ...defaultSettings({ homeDirectory: 'C:\\Users\\test', documentsDirectory: 'C:\\Users\\test\\Documents', platform: 'win32' }),
    shutdownWhenIdle: true,
    shutdownIdleMinutes: 10,
    shutdownGraceMinutes: 10,
    shutdownStopPacks: true,
    ...overrides,
  }
  const saves: AppSettings[] = []
  const settings = {
    read: async () => stored,
    save: async (input: AppSettings) => {
      stored = input
      saves.push(input)
      return stored
    },
  }
  let packs: IdleShutdownPack[] = [{ id: 'pack-a', name: 'A', url: 'http://127.0.0.1:3080/web?token=tok-a' }]
  let sessionCount = 0
  let probeFailure: Error | null = null
  let notifyFailure: Error | null = null
  let stopFailure: Error | null = null
  const calls: string[] = []
  const notifications: { title: string; body: string }[] = []
  const timers = new Map<number, number>()
  let nextTimerId = 0
  const service = createIdleShutdownService({
    settings,
    listRunningPacks: async () => packs,
    countRunningSessions: async () => {
      if (probeFailure) throw probeFailure
      return sessionCount
    },
    stopPack: async packId => {
      calls.push('stop:' + packId)
      if (stopFailure) throw stopFailure
    },
    notify: (title, body) => {
      if (notifyFailure) throw notifyFailure
      notifications.push({ title, body })
    },
    shutdown: async comment => {
      calls.push('shutdown:' + comment)
      return true
    },
    now: () => clock,
    // 定时器只登记、永不自动触发：测试直接调 poll() 推进状态机。
    setTimer: (_handler, milliseconds) => {
      nextTimerId += 1
      timers.set(nextTimerId, milliseconds)
      return nextTimerId
    },
    clearTimer: handle => {
      timers.delete(handle as number)
    },
  })
  return {
    service,
    saves,
    calls,
    notifications,
    timers,
    now: () => clock,
    advance: (milliseconds: number) => {
      clock += milliseconds
    },
    setPacks: (next: IdleShutdownPack[]) => {
      packs = next
    },
    setSessionCount: (count: number) => {
      sessionCount = count
    },
    failProbe: (error: Error | null) => {
      probeFailure = error
    },
    failNotify: (error: Error | null) => {
      notifyFailure = error
    },
    failStop: (error: Error | null) => {
      stopFailure = error
    },
  }
}

/** 布防 → 建立空闲起点 → 空满 10 分钟进入 armed。 */
async function reachArmed(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.arm()
  await harness.service.poll()
  harness.advance(10 * MINUTE)
  await harness.service.poll()
}

describe('idle shutdown', () => {
  it('有会话在跑时保持 waiting，不停包也不关机', async () => {
    const h = createHarness()
    h.setSessionCount(1)
    await h.service.arm()
    h.advance(30 * MINUTE)
    const state = await h.service.poll()
    expect(state.phase).toBe('waiting')
    expect(state.busy).toEqual([{ packId: 'pack-a', reason: '有 1 个会话正在运行' }])
    expect(state.shutdownAt).toBeNull()
    expect(h.calls).toEqual([])
    expect(h.notifications).toHaveLength(0)
  })

  it('RPC 失败按忙处理，message 说清为什么不能确认', async () => {
    const h = createHarness()
    h.failProbe(new Error('连接整合包 Web 服务失败（HTTP 500）。'))
    await h.service.arm()
    h.advance(30 * MINUTE)
    const state = await h.service.poll()
    expect(state.phase).toBe('waiting')
    expect(state.busy).toHaveLength(1)
    expect(state.busy[0]?.reason).toContain('无法确认有没有会话在跑')
    expect(state.message).toBe('无法确认整合包状态，暂不关机')
    expect(h.calls).toEqual([])
  })

  it('空闲满阈值进入 armed，并只发一次系统通知', async () => {
    const h = createHarness()
    await h.service.arm()
    await h.service.poll()
    h.advance(10 * MINUTE)
    const state = await h.service.poll()
    expect(state.phase).toBe('armed')
    expect(state.shutdownAt).toBe(new Date(h.now() + 10 * MINUTE).toISOString())
    expect(h.notifications).toHaveLength(1)
    expect(h.notifications[0]?.title).toBe('即将自动关机')
    expect(h.notifications[0]?.body).toContain('10 分钟后自动关机')
    await h.service.poll()
    expect(h.notifications).toHaveLength(1)
  })

  it('armed 期间出现新活动就回到 waiting 并重置空闲起点', async () => {
    const h = createHarness()
    await reachArmed(h)
    h.setSessionCount(2)
    h.advance(15_000)
    const state = await h.service.poll()
    expect(state.phase).toBe('waiting')
    expect(state.idleSince).toBeNull()
    expect(state.shutdownAt).toBeNull()
    expect(state.message).toBe('检测到新的活动，已推迟关机')
    expect(h.calls).toEqual([])
  })

  it('cancel 只在 armed 有效：回到 waiting 并重新计时', async () => {
    const h = createHarness()
    await reachArmed(h)
    const cancelled = await h.service.cancel()
    expect(cancelled.phase).toBe('waiting')
    expect(cancelled.message).toBe('已取消本轮关机')
    expect(cancelled.idleSince).toBe(new Date(h.now()).toISOString())
    expect(cancelled.shutdownAt).toBeNull()
    // waiting 阶段的 cancel 原样返回，不改状态。
    const again = await h.service.cancel()
    expect(again.phase).toBe('waiting')
    expect(again.message).toBe('已取消本轮关机')
  })

  it('arm 写回设置 true，disarm 落 off 并写回 false', async () => {
    const h = createHarness({ shutdownWhenIdle: false })
    const armed = await h.service.arm()
    expect(armed.enabled).toBe(true)
    expect(armed.phase).toBe('waiting')
    expect(h.saves[h.saves.length - 1]?.shutdownWhenIdle).toBe(true)
    const off = await h.service.disarm()
    expect(off.phase).toBe('off')
    expect(off.enabled).toBe(false)
    expect(off.message).toBe('已关闭空闲自动关机')
    expect(h.saves[h.saves.length - 1]?.shutdownWhenIdle).toBe(false)
  })

  it('到点仍空闲：先逐个停包，再执行关机命令', async () => {
    const h = createHarness()
    h.setPacks([
      { id: 'pack-a', name: 'A', url: 'http://127.0.0.1:3080/web?token=tok-a' },
      { id: 'pack-b', name: 'B', url: 'http://127.0.0.1:3081/web?token=tok-b' },
    ])
    await reachArmed(h)
    h.advance(10 * MINUTE)
    const state = await h.service.poll()
    expect(h.calls).toEqual(['stop:pack-a', 'stop:pack-b', 'shutdown:' + IDLE_SHUTDOWN_COMMENT])
    expect(state.phase).toBe('off')
    expect(state.message).toContain('已执行自动关机')
  })

  it('到点复查变忙就不关机', async () => {
    const h = createHarness()
    await reachArmed(h)
    h.setSessionCount(1)
    h.advance(10 * MINUTE)
    const state = await h.service.poll()
    expect(h.calls).toEqual([])
    expect(state.phase).toBe('waiting')
    expect(state.message).toBe('检测到新的活动，已推迟关机')
  })

  it('调用过包但早已不跑时仍按空闲计：seenRunning 之后才允许 armed', async () => {
    const h = createHarness()
    await h.service.arm()
    await h.service.poll()
    h.advance(10 * MINUTE)
    expect((await h.service.poll()).phase).toBe('armed')
  })

  it('从来没有整合包运行过就永远停在 waiting', async () => {
    const h = createHarness()
    h.setPacks([])
    await h.service.arm()
    const first = await h.service.poll()
    expect(first.phase).toBe('waiting')
    expect(first.message).toBe('还没有整合包在运行')
    expect(first.idleSince).toBeNull()
    h.advance(120 * MINUTE)
    const later = await h.service.poll()
    expect(later.phase).toBe('waiting')
    expect(later.idleSince).toBeNull()
    expect(h.notifications).toHaveLength(0)
    expect(h.calls).toEqual([])
  })

  it('系统通知失败不影响状态机', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const h = createHarness()
      h.failNotify(new Error('通知发送失败'))
      await h.service.arm()
      await h.service.poll()
      h.advance(10 * MINUTE)
      const state = await h.service.poll()
      expect(state.phase).toBe('armed')
      expect(state.shutdownAt).not.toBeNull()
      expect(h.calls).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('停包失败也要继续关机，并把失败原因写进 message', async () => {
    const h = createHarness()
    h.failStop(new Error('整合包已失去响应'))
    await reachArmed(h)
    h.advance(10 * MINUTE)
    const state = await h.service.poll()
    expect(h.calls).toEqual(['stop:pack-a', 'shutdown:' + IDLE_SHUTDOWN_COMMENT])
    expect(state.phase).toBe('off')
    expect(state.message).toContain('未能停止')
  })

  it('宽限期为 0 时同一轮里停包并关机', async () => {
    const h = createHarness({ shutdownGraceMinutes: 0 })
    await h.service.arm()
    await h.service.poll()
    h.advance(10 * MINUTE)
    const state = await h.service.poll()
    expect(h.calls).toEqual(['stop:pack-a', 'shutdown:' + IDLE_SHUTDOWN_COMMENT])
    expect(state.phase).toBe('off')
  })
})
