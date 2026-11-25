import { describe, expect, it, vi } from 'vitest'
import type { AppSettings, LauncherUpdateStatus } from '../src/types'
import { defaultSettings } from '../electron/settings'
import { createUpdateFlow, type UpdateFlowPack } from '../electron/update-flow'
import type { LauncherApplyOptions } from '../electron/launcher-update'
import type { UpdateResumeFile } from '../electron/update-resume'

const BASE_TIME = Date.parse('2026-11-21T08:00:00.000Z')

function status(state: LauncherUpdateStatus['state'], message = ''): LauncherUpdateStatus {
  return {
    state,
    localVersion: '1.3.1',
    remoteVersion: state === 'up-to-date' ? '1.3.1' : '1.3.2',
    releaseUrl: 'https://github.com/kewuuuu/DSH-Melody-Launcher-Overture/releases/tag/v1.3.2',
    assetName: 'DSH-launcher-KEWU-Setup-1.3.2.exe',
    assetSize: 104158235,
    checkedAt: new Date(BASE_TIME).toISOString(),
    message,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

interface HarnessOptions {
  packs?: UpdateFlowPack[]
  sessions?: number
  /** 探到第几轮之后会话就算跑完了；默认永不结束。 */
  sessionsEndAfterPolls?: number
  waitMinutes?: number
  checkState?: LauncherUpdateStatus['state']
  preserveRunningPacks?: boolean
  apply?: (options?: LauncherApplyOptions) => Promise<void>
}

function harness(options: HarnessOptions = {}) {
  let clock = BASE_TIME
  const packs: UpdateFlowPack[] = options.packs ?? [{ id: 'pack-a', name: 'A', url: 'http://127.0.0.1:3080/web?token=tok-a' }]
  const sessions = options.sessions ?? 0
  const endAfter = options.sessionsEndAfterPolls ?? Number.POSITIVE_INFINITY
  let probeFailure: Error | null = null
  let applyFailure: Error | null = null
  const checkState = options.checkState ?? 'update-available'
  const saved: UpdateResumeFile[] = []
  const cleared: number[] = []
  const applied: string[] = []
  const downloads: number[] = []
  const polls: number[] = []
  const settings: AppSettings = {
    ...defaultSettings({ homeDirectory: 'C:\\Users\\test', documentsDirectory: 'C:\\Users\\test\\Documents', platform: 'win32' }),
    updateWaitMinutes: options.waitMinutes ?? 10,
  }
  const listRunningPacks = vi.fn(async () => packs)
  const wait = vi.fn(async (milliseconds: number) => { clock += milliseconds })
  const service = createUpdateFlow({
    preserveRunningPacks: options.preserveRunningPacks,
    settings: { read: async () => settings },
    updater: {
      check: async () => status(checkState, checkState === 'up-to-date' ? '已经是最新版本。' : ''),
      download: async () => {
        downloads.push(clock)
        return status('downloaded')
      },
      apply: async applyOptions => {
        applied.push('apply')
        if (applyFailure) throw applyFailure
        await options.apply?.(applyOptions)
      },
    },
    listRunningPacks,
    countRunningSessions: async () => {
      polls.push(clock)
      if (probeFailure) throw probeFailure
      return polls.length > endAfter ? 0 : sessions
    },
    saveResume: async file => { saved.push(file) },
    clearResume: async () => { cleared.push(clock) },
    now: () => clock,
    wait,
    pollIntervalMs: 15_000,
    probeTimeoutMs: 5_000,
  })
  return {
    service,
    saved,
    cleared,
    applied,
    downloads,
    polls,
    listRunningPacks,
    wait,
    setPacks: (value: UpdateFlowPack[]) => { packs.splice(0, packs.length, ...value) },
    failProbe: (error: Error | null) => { probeFailure = error },
    failApply: (error: Error | null) => { applyFailure = error },
  }
}

describe('update flow', () => {
  it('records the running packs and applies once their sessions are gone', async () => {
    const h = harness({ sessions: 2, sessionsEndAfterPolls: 1 })
    const started = await h.service.start()
    expect(started.phase).toBe('checking')
    await h.service.settled()
    const state = h.service.status()
    expect(state.phase).toBe('applying')
    expect(state.busy).toEqual([])
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0].packs).toEqual([{ id: 'pack-a', name: 'A' }])
    expect(h.saved[0].toVersion).toBe('1.3.2')
    expect(h.applied).toEqual(['apply'])
    expect(h.cleared).toEqual([])
    expect(h.polls).toHaveLength(2)
  })

  it('gives up and clears the resume file when the sessions never end', async () => {
    const h = harness({ sessions: 1, waitMinutes: 1 })
    await h.service.start()
    await h.service.settled()
    const state = h.service.status()
    expect(state.phase).toBe('failed')
    expect(state.message).toContain('仍有会话在运行')
    expect(state.busy).toEqual([{ packId: 'pack-a', reason: '有 1 个会话正在运行' }])
    expect(h.saved).toEqual([])
    expect(h.applied).toEqual([])
    expect(h.cleared).toHaveLength(1)
    // 上限 1 分钟、每轮 15 秒：最多探 5 次就放弃，不会拖成无限等待
    expect(h.polls.length).toBeLessThanOrEqual(5)
  })

  it('skips the wait with force even while sessions are running', async () => {
    const h = harness({ sessions: 3, waitMinutes: 10 })
    await h.service.start({ force: true })
    await h.service.settled()
    expect(h.polls).toEqual([])
    expect(h.applied).toEqual(['apply'])
    expect(h.saved[0].packs).toEqual([{ id: 'pack-a', name: 'A' }])
  })

  it('treats an unmanaged instance as busy so it is never killed halfway', async () => {
    const h = harness({
      packs: [{ id: 'pack-b', name: 'B', url: null, unmanaged: true, note: '有一份启动器没在托管的实例在运行（PID 3420）' }],
      waitMinutes: 1,
    })
    await h.service.start()
    await h.service.settled()
    expect(h.service.status().phase).toBe('failed')
    expect(h.service.status().busy[0].reason).toContain('PID 3420')
    expect(h.applied).toEqual([])
  })

  it('cancels a waiting flow without touching the packs or the resume file', async () => {
    const h = harness({ sessions: 1 })
    await h.service.start()
    const cancelledState = await h.service.cancel()
    expect(cancelledState.phase).toBe('idle')
    expect(cancelledState.message).toBe('已取消本次更新。')
    await h.service.settled()
    expect(h.service.status().phase).toBe('idle')
    expect(h.applied).toEqual([])
    expect(h.saved).toEqual([])
    expect(h.cleared).toEqual([])
  })

  it('reports an up-to-date launcher without downloading anything', async () => {
    const h = harness({ checkState: 'up-to-date' })
    await h.service.start()
    await h.service.settled()
    const state = h.service.status()
    expect(state.phase).toBe('idle')
    expect(state.message).toBe('已经是最新版本。')
    expect(h.downloads).toEqual([])
    expect(h.applied).toEqual([])
  })

  it('fails the flow and clears the resume file when the installer refuses', async () => {
    const h = harness()
    h.failApply(new Error('当前以开发模式运行，自动更新仅支持安装版启动器。'))
    await h.service.start()
    await h.service.settled()
    expect(h.service.status().phase).toBe('failed')
    expect(h.service.status().message).toContain('开发模式')
    expect(h.cleared).toHaveLength(1)
  })

  it('treats a failed session probe as busy instead of updating blindly', async () => {
    const h = harness({ waitMinutes: 1 })
    h.failProbe(new Error('连接整合包 Web 服务失败（HTTP 404）。'))
    await h.service.start()
    await h.service.settled()
    expect(h.service.status().phase).toBe('failed')
    expect(h.service.status().busy[0].reason).toContain('HTTP 404')
    expect(h.applied).toEqual([])
  })

  it('preserves running packs after waiting for active sessions on a plain update', async () => {
    const h = harness({ sessions: 3, sessionsEndAfterPolls: 1, preserveRunningPacks: true })
    await expect(h.service.start({ waitMinutes: 1 })).resolves.toMatchObject({ accepted: true })
    await h.service.settled()
    expect(h.service.status()).toMatchObject({ phase: 'applying', busy: [], resumePacks: [] })
    expect(h.applied).toEqual(['apply'])
    expect(h.wait).toHaveBeenCalledTimes(1)
    expect(h.polls).toHaveLength(2)
    expect(h.saved).toEqual([])
    expect(h.cleared).toEqual([])
  })

  it('allows an explicit force to skip the wait for a plain update', async () => {
    const h = harness({ sessions: 3, preserveRunningPacks: true })
    await h.service.start({ waitMinutes: 1, force: true })
    await h.service.settled()
    expect(h.applied).toEqual(['apply'])
    expect(h.listRunningPacks).not.toHaveBeenCalled()
    expect(h.wait).not.toHaveBeenCalled()
  })

  it('leaves the resume file alone if live preparation fails', async () => {
    const h = harness({ preserveRunningPacks: true })
    h.failApply(new Error('preparation failed'))
    await h.service.start()
    await h.service.settled()
    expect(h.service.status()).toMatchObject({ phase: 'failed', message: 'preparation failed' })
    expect(h.saved).toEqual([])
    expect(h.cleared).toEqual([])
  })

  it('reserves the live flow and allows cancellation before handoff', async () => {
    const preparing = deferred()
    const h = harness({
      preserveRunningPacks: true,
      apply: async options => {
        const signal = options?.signal as AbortSignal
        preparing.resolve()
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
        signal.throwIfAborted()
      },
    })
    const started = h.service.start()
    await expect(h.service.start()).rejects.toThrow('已有一个更新流程')
    await started
    await preparing.promise
    await expect(h.service.check()).rejects.toThrow('已有一个更新流程')
    expect(h.service.status().phase).toBe('applying')
    await h.service.cancel()
    await h.service.settled()
    expect(h.service.status()).toMatchObject({ phase: 'idle', message: '已取消本次更新。' })
    expect(h.cleared).toEqual([])
  })

  it('rejects cancellation after the preserve path commits to helper launch', async () => {
    const committed = deferred()
    const release = deferred()
    const h = harness({
      preserveRunningPacks: true,
      apply: async options => {
        options?.onCommit?.()
        committed.resolve()
        await release.promise
      },
    })
    await h.service.start()
    await committed.promise
    await expect(h.service.cancel()).rejects.toThrow('安装已经开始')
    release.resolve()
    await h.service.settled()
  })

  it('check only inspects the release and never downloads', async () => {
    const h = harness()
    const result = await h.service.check()
    expect(result.state).toBe('update-available')
    expect(h.service.status().remoteVersion).toBe('1.3.2')
    expect(h.downloads).toEqual([])
    expect(h.applied).toEqual([])
  })

  it('refuses to start twice at the same time', async () => {
    const h = harness({ sessions: 1 })
    await h.service.start()
    await expect(h.service.start()).rejects.toThrow('已有一个更新流程在进行中')
    await h.service.cancel()
    await h.service.settled()
  })

  it('refuses to cancel once the installer is running', async () => {
    const h = harness({ sessions: 1, sessionsEndAfterPolls: 1 })
    await h.service.start()
    await h.service.settled()
    expect(h.service.status().phase).toBe('applying')
    await expect(h.service.cancel()).rejects.toThrow('安装已经开始')
  })
})
