import type { AppSettings, LauncherUpdateStatus } from '../src/types'
import type { UpdateResumeFile, UpdateResumePack } from './update-resume'
import { UPDATE_RESUME_VERSION } from './update-resume'

/**
 * 「CLI 触发更新」的状态机：检查 → 下载 → 等所有整合包的会话跑完 → 记录谁在跑 → 交给升级助手。
 * 主进程只注入能力（包查询、会话探针、updater、resume 文件），判定逻辑留在这里好测。
 *
 * 等待语义复用空闲自动关机：有会话算忙、探针失败也算忙（宁可多等，也不在用户正干活时重启）；
 * 未托管实例启动器停不掉，同样算忙。--force 是逃生门。
 */

export type UpdateFlowPhase = 'idle' | 'checking' | 'downloading' | 'waiting' | 'applying' | 'failed'

export interface UpdateFlowPack {
  id: string
  name?: string
  /** 该包的 Web 服务地址（含 ?token=…）；null 表示查不到。 */
  url: string | null
  /** 启动器管不着的实例：停不掉也查不到会话，只能算忙。 */
  unmanaged?: boolean
  note?: string
}

export interface UpdateFlowBusy {
  packId: string
  reason: string
}

export interface UpdateFlowState {
  phase: UpdateFlowPhase
  waitMinutes: number
  localVersion: string | null
  remoteVersion: string | null
  busy: UpdateFlowBusy[]
  /** 本次更新会恢复的包（停包之前记录下来的那一份）。 */
  resumePacks: UpdateResumePack[]
  startedAt: string | null
  message: string | null
}

export interface UpdateFlowDeps {
  settings: { read(): Promise<AppSettings> }
  updater: {
    check(): Promise<LauncherUpdateStatus>
    download(): Promise<LauncherUpdateStatus>
    apply(): Promise<void>
  }
  listRunningPacks: () => Promise<UpdateFlowPack[]>
  countRunningSessions: (url: string, signal: AbortSignal) => Promise<number>
  saveResume: (file: UpdateResumeFile) => Promise<void>
  clearResume: () => Promise<void>
  now?: () => number
  wait?: (milliseconds: number) => Promise<void>
  probeTimeoutMs?: number
  pollIntervalMs?: number
  emitOutput?: (text: string) => void
}

export interface UpdateFlowService {
  status(): UpdateFlowState
  /** 只检查、不下载不安装；结果同时写进 status() 的版本与 message。 */
  check(): Promise<LauncherUpdateStatus>
  /** 起一轮更新；立刻返回当前状态，流程在后台推进（apply 会自己让进程退出）。 */
  start(options?: { waitMinutes?: number; force?: boolean }): Promise<UpdateFlowState>
  cancel(): Promise<UpdateFlowState>
  /** 当前这轮流程跑完（或被取消/失败）时兑现；没有流程在跑时立即兑现。 */
  settled(): Promise<void>
}

export const UPDATE_FLOW_DEFAULT_WAIT_MINUTES = 10
export const UPDATE_FLOW_MAX_WAIT_MINUTES = 120
export const UPDATE_FLOW_POLL_INTERVAL_MS = 15_000
export const UPDATE_FLOW_PROBE_TIMEOUT_MS = 5_000

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '未知错误'
}

function waitMinutesOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UPDATE_FLOW_DEFAULT_WAIT_MINUTES
  return Math.min(UPDATE_FLOW_MAX_WAIT_MINUTES, Math.max(1, Math.floor(value)))
}

export function createUpdateFlow(deps: UpdateFlowDeps): UpdateFlowService {
  const now = deps.now ?? (() => Date.now())
  const wait = deps.wait ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
  const probeTimeoutMs = deps.probeTimeoutMs ?? UPDATE_FLOW_PROBE_TIMEOUT_MS
  const pollIntervalMs = deps.pollIntervalMs ?? UPDATE_FLOW_POLL_INTERVAL_MS

  const state: UpdateFlowState = {
    phase: 'idle',
    waitMinutes: UPDATE_FLOW_DEFAULT_WAIT_MINUTES,
    localVersion: null,
    remoteVersion: null,
    busy: [],
    resumePacks: [],
    startedAt: null,
    message: null,
  }

  let running: Promise<void> | null = null
  let cancelled = false

  const snapshot = (): UpdateFlowState => ({
    ...state,
    busy: state.busy.map(item => ({ ...item })),
    resumePacks: state.resumePacks.map(item => ({ ...item })),
  })

  const emit = (text: string): void => {
    try {
      deps.emitOutput?.(text)
    } catch {
      // 输出失败不影响流程
    }
  }

  const adopt = (status: LauncherUpdateStatus): void => {
    state.localVersion = status.localVersion ?? state.localVersion
    state.remoteVersion = status.remoteVersion ?? state.remoteVersion
  }

  const runWithTimeout = async <T>(action: (signal: AbortSignal) => Promise<T>, milliseconds: number): Promise<T> => {
    const controller = new AbortController()
    let handle: ReturnType<typeof setTimeout> | null = null
    let settled = false
    const expired = new Promise<never>((_resolve, reject) => {
      handle = setTimeout(() => {
        if (settled) return
        controller.abort()
        reject(new Error('等待超时'))
      }, milliseconds)
      if (typeof handle.unref === 'function') handle.unref()
    })
    try {
      return await Promise.race([action(controller.signal), expired])
    } finally {
      settled = true
      if (handle) clearTimeout(handle)
    }
  }

  /** 谁在忙：有会话、探针失败、未托管实例都算。空数组＝可以更新了。 */
  const collectBusy = async (): Promise<UpdateFlowBusy[]> => {
    const packs = await deps.listRunningPacks()
    const busy: UpdateFlowBusy[] = []
    for (const pack of packs) {
      if (pack.unmanaged === true) {
        busy.push({ packId: pack.id, reason: pack.note ?? '有一份启动器没在托管的实例在运行，无法确认有没有会话' })
        continue
      }
      if (!pack.url) {
        busy.push({ packId: pack.id, reason: pack.note ?? '拿不到 Web 服务地址，无法确认有没有会话在跑' })
        continue
      }
      try {
        const count = await runWithTimeout(signal => deps.countRunningSessions(pack.url as string, signal), probeTimeoutMs)
        if (count > 0) busy.push({ packId: pack.id, reason: count === 1 ? '有 1 个会话正在运行' : '有 ' + count + ' 个会话正在运行' })
      } catch (error) {
        busy.push({ packId: pack.id, reason: '无法确认有没有会话在跑（' + messageOf(error) + '）' })
      }
    }
    return busy
  }

  const waitUntilIdle = async (waitMinutes: number): Promise<void> => {
    const deadline = now() + waitMinutes * 60_000
    for (;;) {
      if (cancelled) return
      const busy = await collectBusy()
      state.busy = busy
      if (busy.length === 0) {
        state.message = '整合包都已没有运行中的会话，准备安装更新…'
        return
      }
      state.message = '还有整合包在跑会话，等待它们结束（最多 ' + waitMinutes + ' 分钟）'
      if (now() >= deadline) {
        throw new Error('等待 ' + waitMinutes + ' 分钟仍有会话在运行，已取消本次更新：' + busy.map(item => item.packId + '（' + item.reason + '）').join('；'))
      }
      await wait(pollIntervalMs)
    }
  }

  const run = async (waitMinutes: number, force: boolean): Promise<void> => {
    try {
      state.phase = 'checking'
      state.message = '正在检查更新…'
      const checked = await deps.updater.check()
      adopt(checked)
      if (checked.state === 'error') throw new Error(checked.message || '检查更新失败。')
      if (checked.state !== 'update-available' && checked.state !== 'downloaded') {
        state.phase = 'idle'
        state.message = checked.message || '已经是最新版本，无需更新。'
        return
      }
      state.phase = 'downloading'
      state.message = '正在下载更新…'
      const downloaded = await deps.updater.download()
      adopt(downloaded)
      if (downloaded.state !== 'downloaded') throw new Error(downloaded.message || '更新下载失败。')
      // 下载期间被取消：别再改回 waiting 把状态又点亮一次。
      if (cancelled) return
      if (!force) {
        state.phase = 'waiting'
        state.busy = []
        await waitUntilIdle(waitMinutes)
        if (cancelled) return
      }
      // 记录「此刻还在跑」的包：停包之后就没有现场了，恢复只能靠这一份。
      const packs = await deps.listRunningPacks()
      state.resumePacks = packs
        .filter(pack => pack.unmanaged !== true)
        .map(pack => ({ id: pack.id, ...(pack.name ? { name: pack.name } : {}) }))
      await deps.saveResume({
        version: UPDATE_RESUME_VERSION,
        toVersion: state.remoteVersion,
        packs: state.resumePacks,
        at: new Date(now()).toISOString(),
      })
      state.phase = 'applying'
      state.message = state.resumePacks.length > 0
        ? '正在停止 ' + state.resumePacks.length + ' 个整合包并安装更新，装完会自动恢复它们…'
        : '正在安装更新，装完会自动启动新版本…'
      emit('[update] ' + state.message)
      await deps.updater.apply()
    } catch (error) {
      state.phase = 'failed'
      state.message = messageOf(error)
      // 没装成就别在下次启动时恢复：那时机器上的包本来就没人动过。
      await deps.clearResume().catch(() => undefined)
      emit('[update] 更新失败：' + state.message)
    }
  }

  return {
    status: () => snapshot(),
    check: async () => {
      state.phase = 'checking'
      state.message = '正在检查更新…'
      const status = await deps.updater.check()
      adopt(status)
      state.phase = status.state === 'error' ? 'failed' : 'idle'
      state.message = status.state === 'error'
        ? status.message || '检查更新失败。'
        : status.message || (status.state === 'update-available' ? '发现新版本 ' + (status.remoteVersion ?? '') : '已经是最新版本。')
      return status
    },
    start: async options => {
      if (running) throw new Error('已有一个更新流程在进行中。')
      const settings = await deps.settings.read()
      const waitMinutes = waitMinutesOf(options?.waitMinutes ?? settings.updateWaitMinutes)
      cancelled = false
      state.phase = 'checking'
      state.waitMinutes = waitMinutes
      state.busy = []
      state.resumePacks = []
      state.startedAt = new Date(now()).toISOString()
      state.message = '正在检查更新…'
      running = run(waitMinutes, options?.force === true).finally(() => { running = null })
      return snapshot()
    },
    cancel: async () => {
      if (state.phase === 'applying') throw new Error('安装已经开始，无法取消本次更新。')
      if (!running) return snapshot()
      cancelled = true
      state.phase = 'idle'
      state.busy = []
      state.message = '已取消本次更新。'
      return snapshot()
    },
    settled: () => running ?? Promise.resolve(),
  }
}
