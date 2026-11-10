import type { AppSettings, IdleShutdownPhase, IdleShutdownState } from '../src/types'

/**
 * 「所有整合包都空闲后自动关机」的状态机。
 * 判定、定时、通知、关机命令、包查询全部由调用方注入：测试里既不用等真实时钟，
 * 也不会真的停包或关机；主进程只负责把 Electron 的能力接进来。
 */

export interface IdleShutdownPack {
  id: string
  name?: string
  /** 该包的 Web 服务地址（含 ?token=…）；拿不到就是 null，按「无法确认」处理。 */
  url: string | null
}

export interface IdleShutdownSettingsStore {
  read(): Promise<AppSettings>
  save(input: AppSettings): Promise<AppSettings>
}

export type IdleShutdownTimerHandle = unknown

export interface IdleShutdownDeps {
  settings: IdleShutdownSettingsStore
  /** 当前正在运行的整合包；空数组表示一个都没跑。 */
  listRunningPacks: () => Promise<IdleShutdownPack[]>
  /** 读该 Web 服务上处于 running 的会话数；抛错即「无法确认」，一律按忙处理。 */
  countRunningSessions: (url: string, signal: AbortSignal) => Promise<number>
  stopPack: (packId: string) => Promise<void>
  /** 系统通知；抛错不能影响状态机。 */
  notify: (title: string, body: string) => void
  /** 下达关机命令；返回 false 表示当前平台不支持（例如非 Windows）。 */
  shutdown: (comment: string) => Promise<boolean>
  now?: () => number
  setTimer?: (handler: () => void, milliseconds: number) => IdleShutdownTimerHandle
  clearTimer?: (handle: IdleShutdownTimerHandle) => void
  pollIntervalMs?: number
  probeTimeoutMs?: number
  stopBudgetMs?: number
}

export interface IdleShutdownService {
  get(): Promise<IdleShutdownState>
  arm(): Promise<IdleShutdownState>
  disarm(): Promise<IdleShutdownState>
  cancel(): Promise<IdleShutdownState>
  /** 驱动一次判定；定时器调用它，测试也直接调用它。 */
  poll(): Promise<IdleShutdownState>
  /** 设置保存后同步开关（设置界面、CLI 都能改这两个值）。 */
  applySettings(saved: AppSettings): Promise<IdleShutdownState>
  dispose(): Promise<void>
}

export const IDLE_SHUTDOWN_COMMENT = 'KEWU: 所有整合包空闲，自动关机'
export const IDLE_SHUTDOWN_POLL_INTERVAL_MS = 15_000
export const IDLE_SHUTDOWN_PROBE_TIMEOUT_MS = 5_000
export const IDLE_SHUTDOWN_STOP_BUDGET_MS = 20_000
export const DEFAULT_IDLE_MINUTES = 10
export const DEFAULT_GRACE_MINUTES = 10

type BusyReason = { packId: string; reason: string }

type Verdict =
  | { kind: 'no-packs' }
  | { kind: 'idle' }
  | { kind: 'activity'; busy: BusyReason[] }
  | { kind: 'unknown'; busy: BusyReason[] }

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '未知错误'
}

function minutesOf(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}

export function createIdleShutdownService(deps: IdleShutdownDeps): IdleShutdownService {
  const now = deps.now ?? (() => Date.now())
  const setTimer = deps.setTimer ?? ((handler: () => void, milliseconds: number) => setTimeout(handler, milliseconds))
  const clearTimer = deps.clearTimer ?? ((handle: IdleShutdownTimerHandle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const pollIntervalMs = deps.pollIntervalMs ?? IDLE_SHUTDOWN_POLL_INTERVAL_MS
  const probeTimeoutMs = deps.probeTimeoutMs ?? IDLE_SHUTDOWN_PROBE_TIMEOUT_MS
  const stopBudgetMs = deps.stopBudgetMs ?? IDLE_SHUTDOWN_STOP_BUDGET_MS

  const status: {
    phase: IdleShutdownPhase
    idleSince: number | null
    shutdownAt: number | null
    seenRunning: boolean
    message: string | null
    busy: BusyReason[]
    /** 本轮已经发过通知的关机时刻，保证每轮只通知一次。 */
    notifiedAt: number | null
  } = { phase: 'off', idleSince: null, shutdownAt: null, seenRunning: false, message: null, busy: [], notifiedAt: null }

  let cachedSettings: AppSettings | null = null
  let timer: IdleShutdownTimerHandle | null = null
  let shuttingDown = false
  let chain: Promise<unknown> = Promise.resolve()

  // 单实例串行：定时器、IPC、CLI 的调用都排进同一条链，避免两个 tick 同时到点各关一次机。
  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = chain.then(action, action)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const currentSettings = async (): Promise<AppSettings> => {
    if (!cachedSettings) cachedSettings = await deps.settings.read()
    return cachedSettings
  }

  const stopTimer = (): void => {
    if (timer === null) return
    clearTimer(timer)
    timer = null
  }

  const scheduleNext = (): void => {
    stopTimer()
    timer = setTimer(() => {
      timer = null
      void poll().catch(error => console.error('[idle-shutdown] 空闲判定失败。', error))
    }, pollIntervalMs)
  }

  /** 带超时的等待：超时先 abort 请求再拒绝，调用方据此按忙处理。 */
  const runWithTimeout = async <T>(action: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> => {
    const controller = new AbortController()
    let handle: IdleShutdownTimerHandle | null = null
    let settled = false
    const expired = new Promise<never>((_resolve, reject) => {
      handle = setTimer(() => {
        if (settled) return
        controller.abort()
        reject(new Error('等待超时'))
      }, milliseconds)
    })
    try {
      return await Promise.race([action(controller.signal), expired])
    } finally {
      settled = true
      if (handle !== null) clearTimer(handle)
    }
  }

  const snapshotOf = (settings: AppSettings): IdleShutdownState => ({
    enabled: settings.shutdownWhenIdle === true,
    phase: settings.shutdownWhenIdle === true ? status.phase : 'off',
    idleMinutes: minutesOf(settings.shutdownIdleMinutes, DEFAULT_IDLE_MINUTES),
    graceMinutes: minutesOf(settings.shutdownGraceMinutes, DEFAULT_GRACE_MINUTES),
    stopPacks: settings.shutdownStopPacks !== false,
    idleSince: status.idleSince === null ? null : new Date(status.idleSince).toISOString(),
    shutdownAt: status.shutdownAt === null ? null : new Date(status.shutdownAt).toISOString(),
    busy: status.busy.map(item => ({ packId: item.packId, reason: item.reason })),
    message: status.message,
  })

  const resetToOff = (message: string | null): void => {
    stopTimer()
    status.phase = 'off'
    status.idleSince = null
    status.shutdownAt = null
    status.busy = []
    status.notifiedAt = null
    status.message = message
  }

  const resetToWaiting = (): void => {
    status.phase = 'waiting'
    status.idleSince = null
    status.shutdownAt = null
    status.busy = []
    status.notifiedAt = null
    status.seenRunning = false
    status.message = '还没有整合包在运行'
  }

  /** 设置里开着就进入 waiting；关掉就落 off。每次判定前都执行一遍。 */
  const ensureActive = async (): Promise<AppSettings> => {
    const settings = await currentSettings()
    if (settings.shutdownWhenIdle === true) {
      if (status.phase === 'off') {
        resetToWaiting()
        scheduleNext()
      }
    } else if (status.phase !== 'off') {
      resetToOff('已关闭空闲自动关机')
    }
    return settings
  }

  const evaluate = async (): Promise<Verdict> => {
    const packs = await deps.listRunningPacks()
    if (!Array.isArray(packs) || packs.length === 0) return { kind: 'no-packs' }
    const sessionBusy: BusyReason[] = []
    const failed: BusyReason[] = []
    for (const pack of packs) {
      if (!pack.url) {
        failed.push({ packId: pack.id, reason: '拿不到 Web 服务地址，无法确认有没有会话在跑' })
        continue
      }
      try {
        const count = await runWithTimeout(signal => deps.countRunningSessions(pack.url as string, signal), probeTimeoutMs)
        if (count > 0) sessionBusy.push({ packId: pack.id, reason: count === 1 ? '有 1 个会话正在运行' : '有 ' + count + ' 个会话正在运行' })
      } catch (error) {
        failed.push({ packId: pack.id, reason: '无法确认有没有会话在跑（' + messageOf(error) + '）' })
      }
    }
    if (sessionBusy.length > 0) return { kind: 'activity', busy: [...sessionBusy, ...failed] }
    if (failed.length > 0) return { kind: 'unknown', busy: failed }
    return { kind: 'idle' }
  }

  const notifyPending = (idleMinutes: number, graceMinutes: number): void => {
    const when = graceMinutes > 0 ? '将在 ' + graceMinutes + ' 分钟后自动关机。' : '即将自动关机。'
    const body = '所有整合包已空闲 ' + idleMinutes + ' 分钟，' + when + '可以在启动器里取消本轮关机。'
    try {
      deps.notify('即将自动关机', body)
    } catch (error) {
      // 通知失败绝对不能把状态机带崩：关机与否只看会话判定。
      console.error('[idle-shutdown] 发送通知失败。', error)
    }
  }

  const enterArmed = (settings: AppSettings, idleMinutes: number, graceMinutes: number): void => {
    const at = now()
    status.phase = 'armed'
    status.shutdownAt = at + graceMinutes * 60_000
    status.busy = []
    status.message = graceMinutes > 0 ? '将在 ' + graceMinutes + ' 分钟后自动关机' : '即将自动关机'
    if (status.notifiedAt !== status.shutdownAt) {
      status.notifiedAt = status.shutdownAt
      notifyPending(idleMinutes, graceMinutes)
    }
  }

  const enterIdle = (settings: AppSettings): void => {
    status.seenRunning = true
    const at = now()
    if (status.idleSince === null) status.idleSince = at
    const idleMinutes = minutesOf(settings.shutdownIdleMinutes, DEFAULT_IDLE_MINUTES)
    if (at - status.idleSince < idleMinutes * 60_000) {
      status.message = '所有整合包都空闲，正在累计空闲时间'
      return
    }
    enterArmed(settings, idleMinutes, minutesOf(settings.shutdownGraceMinutes, DEFAULT_GRACE_MINUTES))
  }

  const performShutdown = async (settings: AppSettings): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      const packs = await deps.listRunningPacks().catch(() => [] as IdleShutdownPack[])
      const failures: string[] = []
      const shouldStop = settings.shutdownStopPacks !== false
      if (shouldStop && packs.length > 0) {
        // 总预算固定 20 秒：停不掉也要继续关机，只把失败原因写进 message。
        const deadline = now() + stopBudgetMs
        for (const pack of packs) {
          const remaining = deadline - now()
          if (remaining <= 0) {
            failures.push(pack.id + '：停止预算已用尽')
            continue
          }
          try {
            await runWithTimeout(() => deps.stopPack(pack.id), remaining)
          } catch (error) {
            failures.push(pack.id + '：' + messageOf(error))
          }
        }
      }
      const issued = await deps.shutdown(IDLE_SHUTDOWN_COMMENT).catch(() => false)
      const stopped = shouldStop && packs.length > 0 ? '已停止 ' + packs.length + ' 个整合包。' : ''
      const failed = failures.length > 0 ? '（未能停止：' + failures.join('；') + '）' : ''
      resetToOff(issued
        ? '所有整合包空闲，已执行自动关机。' + stopped + failed
        : '当前系统不是 Windows，未执行关机命令。' + stopped + failed)
    } finally {
      shuttingDown = false
    }
  }

  // 用函数读相位：分支里的字面量窄化会把「同 tick 内刚变成 armed」判成不可能。
  const phaseOf = () => status.phase

  const poll = async (): Promise<IdleShutdownState> => {
    const settings = await ensureActive()
    if (status.phase === 'off') return snapshotOf(settings)
    const verdict = await evaluate()
    if (status.phase === 'waiting') {
      if (verdict.kind === 'no-packs') {
        status.busy = []
        if (status.seenRunning) enterIdle(settings)
        else {
          status.idleSince = null
          status.message = '还没有整合包在运行'
        }
      } else if (verdict.kind === 'idle') {
        status.busy = []
        enterIdle(settings)
      } else {
        status.seenRunning = true
        status.idleSince = null
        status.busy = verdict.busy
        status.message = verdict.kind === 'activity' ? '整合包里有会话正在运行，暂不关机' : '无法确认整合包状态，暂不关机'
      }
      if (phaseOf() === 'armed' && status.shutdownAt !== null && now() >= status.shutdownAt) await performShutdown(settings)
    } else if (status.phase === 'armed') {
      if (verdict.kind === 'activity' || verdict.kind === 'unknown') {
        // 到点前的复查在这里：一旦有新活动就退回 waiting 并重新计时。
        status.phase = 'waiting'
        status.idleSince = null
        status.shutdownAt = null
        status.notifiedAt = null
        status.busy = verdict.busy
        status.message = verdict.kind === 'activity' ? '检测到新的活动，已推迟关机' : '无法确认整合包状态，已推迟关机'
      } else if (now() >= (status.shutdownAt ?? Number.POSITIVE_INFINITY)) {
        status.busy = []
        await performShutdown(settings)
      }
    }
    if (phaseOf() !== 'off') scheduleNext()
    return snapshotOf(settings)
  }

  return {
    get: () => serial(async () => snapshotOf(await ensureActive())),
    arm: () => serial(async () => {
      let settings = await currentSettings()
      if (settings.shutdownWhenIdle !== true) {
        settings = await deps.settings.save({ ...settings, shutdownWhenIdle: true })
        cachedSettings = settings
      }
      if (status.phase === 'off') resetToWaiting()
      scheduleNext()
      return snapshotOf(settings)
    }),
    disarm: () => serial(async () => {
      let settings = await currentSettings()
      if (settings.shutdownWhenIdle === true) {
        settings = await deps.settings.save({ ...settings, shutdownWhenIdle: false })
        cachedSettings = settings
      }
      resetToOff('已关闭空闲自动关机')
      return snapshotOf(settings)
    }),
    cancel: () => serial(async () => {
      const settings = await currentSettings()
      if (status.phase !== 'armed') return snapshotOf(settings)
      status.phase = 'waiting'
      status.idleSince = now()
      status.shutdownAt = null
      status.notifiedAt = null
      status.message = '已取消本轮关机'
      scheduleNext()
      return snapshotOf(settings)
    }),
    poll: () => serial(poll),
    applySettings: (saved: AppSettings) => serial(async () => {
      cachedSettings = saved
      if (saved.shutdownWhenIdle === true) {
        if (status.phase === 'off') {
          resetToWaiting()
          scheduleNext()
        }
        return snapshotOf(saved)
      }
      resetToOff('已关闭空闲自动关机')
      return snapshotOf(saved)
    }),
    dispose: () => serial(async () => {
      stopTimer()
    }),
  }
}
