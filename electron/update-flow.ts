import { randomUUID } from 'node:crypto'
import { armUpdateContinuation, samePreservedRuntime, type PreservedRuntime, type UpdateContinuation } from './update-continuation'
import { parseExactResume, type ExactResumeInput } from './pending-resume'
import type { AppSettings, LauncherUpdateStatus } from '../src/types'
import { LauncherRelaunchExitError, type LauncherApplyOptions } from './launcher-update'
import type { UpdateResumeFile, UpdateResumePack } from './update-resume'
import { UPDATE_RESUME_VERSION } from './update-resume'

/**
 * CLI 更新状态机：检查、下载、等待会话空闲、交给升级助手。
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
  identity?: PreservedRuntime
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
  supportsResume?: true
  accepted?: true
  operationId?: string
}

export interface UpdateFlowDeps {
  settings: { read(): Promise<AppSettings> }
  updater: {
    check(): Promise<LauncherUpdateStatus>
    download(): Promise<LauncherUpdateStatus>
    apply(options?: LauncherApplyOptions): Promise<void>
  }
  /** 调用方须同时启用 updater 的整合包保留模式。 */
  preserveRunningPacks?: boolean
  listRunningPacks: () => Promise<UpdateFlowPack[]>
  countRunningSessions: (url: string, signal: AbortSignal) => Promise<number>
  saveResume: (file: UpdateResumeFile) => Promise<void>
  clearResume: () => Promise<void>
  continuation?: {
    verifySession: (pack: UpdateFlowPack & { url: string }, sessionId: string, signal: AbortSignal) => Promise<void>
    save: (entry: UpdateContinuation) => Promise<void>
    clear: () => Promise<void>
  }
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
  start(options?: { waitMinutes?: number; force?: boolean; resume?: ExactResumeInput }): Promise<UpdateFlowState>
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
    ...(deps.preserveRunningPacks && deps.continuation ? { supportsResume: true } : {}),
  }

  let running: Promise<void> | null = null
  let checking: Promise<LauncherUpdateStatus> | null = null
  let controller: AbortController | null = null
  let committed = false
  const preserveRunningPacks = deps.preserveRunningPacks === true

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
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('会话计数无效')
        if (count > 0) busy.push({ packId: pack.id, reason: count === 1 ? '有 1 个会话正在运行' : '有 ' + count + ' 个会话正在运行' })
      } catch (error) {
        busy.push({ packId: pack.id, reason: '无法确认有没有会话在跑（' + messageOf(error) + '）' })
      }
    }
    return busy
  }

  const waitUntilIdle = async (waitMinutes: number, signal: AbortSignal): Promise<void> => {
    const deadline = now() + waitMinutes * 60_000
    for (;;) {
      if (signal.aborted) return
      const busy = await collectBusy()
      if (signal.aborted) return
      state.busy = busy
      if (busy.length === 0) {
        state.message = '整合包都已没有运行中的会话，准备安装更新…'
        return
      }
      state.message = '还有整合包在跑会话，等待它们结束（最多 ' + waitMinutes + ' 分钟）'
      if (now() >= deadline) {
        throw new Error('等待 ' + waitMinutes + ' 分钟仍有会话在运行，已取消本次更新：' + busy.map(item => item.packId + '（' + item.reason + '）').join('；'))
      }
      await wait(Math.min(pollIntervalMs, deadline - now()))
    }
  }

  const exactPack = async (resume: ExactResumeInput, expected?: PreservedRuntime) => {
    const pack = (await deps.listRunningPacks()).find(item => item.id === resume.packId)
    const url = pack?.url
    const identity = pack?.identity
    if (!pack || pack.unmanaged || !url || !identity || (expected && !samePreservedRuntime(expected, identity))) {
      throw new Error('无法验证续接目标整合包及其本地 Web 服务。')
    }
    await runWithTimeout(signal => deps.continuation!.verifySession({ ...pack, url }, resume.sessionId, signal), probeTimeoutMs)
    return identity
  }

  const run = async (options: Parameters<UpdateFlowService['start']>[0], signal: AbortSignal, continuation?: UpdateContinuation): Promise<void> => {
    let writingResume = false
    let handedOff = false
    try {
      const settings = await deps.settings.read()
      if (signal.aborted) return
      state.waitMinutes = waitMinutesOf(options?.waitMinutes ?? settings.updateWaitMinutes)
      const checked = await deps.updater.check()
      if (signal.aborted) return
      adopt(checked)
      if (checked.state === 'applying' || checked.state === 'downloading') {
        throw new Error('已有一个启动器更新在进行中。')
      }
      if (checked.state === 'error') throw new Error(checked.message || '检查更新失败。')
      if (checked.state !== 'update-available' && checked.state !== 'downloaded') {
        state.phase = 'idle'
        state.message = checked.message || '已经是最新版本，无需更新。'
        return
      }
      state.phase = 'downloading'
      state.message = '正在下载更新…'
      const downloaded = await deps.updater.download()
      if (signal.aborted) return
      adopt(downloaded)
      if (downloaded.state !== 'downloaded') throw new Error(downloaded.message || '更新下载失败。')
      const mustWait = options?.force !== true || continuation !== undefined
      if (mustWait) {
        state.phase = 'waiting'
        state.busy = []
        await waitUntilIdle(state.waitMinutes, signal)
        if (signal.aborted) return
      }
      if (preserveRunningPacks) {
        const expectedVersion = downloaded.remoteVersion
        if (continuation && !expectedVersion) throw new Error('无法确认待安装的更新版本。')
        state.phase = 'applying'
        state.message = '正在保留运行中的整合包并准备安装更新…'
        emit('[update] ' + state.message)
        if (signal.aborted) return
        await deps.updater.apply({
          signal,
          onCommit: () => { committed = true },
          ...(continuation && expectedVersion ? { continuation: { operationId: continuation.operationId, toVersion: expectedVersion } } : {}),
          ...(mustWait ? { beforeCommit: async () => {
            if (continuation && expectedVersion) {
              await exactPack(continuation.resume, continuation.runtime)
              signal.throwIfAborted()
              await deps.continuation!.save(armUpdateContinuation(continuation, expectedVersion, now()))
            }
            const busy = await collectBusy()
            signal.throwIfAborted()
            state.busy = busy
            if (busy.length > 0) throw new Error('安装前有会话正在运行或无法确认状态，已中止本次更新。')
          } } : {}),
        })
        committed = true
        handedOff = true
        return
      }
      // 记录「此刻还在跑」的包：停包之后就没有现场了，恢复只能靠这一份。
      const packs = await deps.listRunningPacks()
      if (signal.aborted) return
      state.resumePacks = packs
        .filter(pack => pack.unmanaged !== true)
        .map(pack => ({ id: pack.id, ...(pack.name ? { name: pack.name } : {}) }))
      writingResume = true
      await deps.saveResume({
        version: UPDATE_RESUME_VERSION,
        toVersion: state.remoteVersion,
        packs: state.resumePacks,
        at: new Date(now()).toISOString(),
      })
      if (signal.aborted) {
        await deps.clearResume()
        return
      }
      committed = true
      state.phase = 'applying'
      state.message = state.resumePacks.length > 0
        ? '正在停止 ' + state.resumePacks.length + ' 个整合包并安装更新，装完会自动恢复它们…'
        : '正在安装更新，装完会自动启动新版本…'
      emit('[update] ' + state.message)
      await deps.updater.apply()
    } catch (error) {
      if (error instanceof LauncherRelaunchExitError) {
        state.message = error.message
        emit('[update] ' + state.message)
        return
      }
      if (signal.aborted && error === signal.reason) return
      if (signal.aborted && !preserveRunningPacks && !writingResume) return
      state.phase = 'failed'
      state.message = messageOf(error)
      if (!preserveRunningPacks) await deps.clearResume().catch(() => undefined)
      emit('[update] 更新失败：' + state.message)
    } finally {
      if (continuation && !handedOff) await clearContinuation()
    }
  }

  const clearContinuation = async () => {
    try {
      await deps.continuation?.clear()
    } catch (error) {
      emit('[update] 清理续接记录失败：' + messageOf(error))
    }
  }

  return {
    status: () => snapshot(),
    check: async () => {
      if (running || committed) throw new Error('已有一个更新流程在进行中。')
      if (!checking) {
        state.phase = 'checking'
        state.message = '正在检查更新…'
        checking = Promise.resolve().then(() => deps.updater.check()).then(status => {
          adopt(status)
          state.phase = status.state === 'error' ? 'failed'
            : status.state === 'applying' || status.state === 'downloading' ? status.state : 'idle'
          state.message = status.message || (status.state === 'update-available'
            ? '发现新版本 ' + (status.remoteVersion ?? '')
            : status.state === 'error' ? '检查更新失败。' : '已经是最新版本。')
          return status
        }).catch(error => {
          state.phase = 'failed'
          state.message = messageOf(error)
          throw error
        }).finally(() => { checking = null })
      }
      return checking
    },
    start: async options => {
      if (running || checking || committed) throw new Error('已有一个更新流程在进行中。')
      const resume = options?.resume === undefined ? undefined : parseExactResume(options.resume)
      if (resume && (!preserveRunningPacks || !deps.continuation)) throw new Error('当前更新流程不支持会话续接。')
      const next = new AbortController()
      controller = next
      state.phase = 'checking'
      state.waitMinutes = UPDATE_FLOW_DEFAULT_WAIT_MINUTES
      state.busy = []
      state.resumePacks = []
      state.startedAt = new Date(now()).toISOString()
      delete state.operationId
      state.message = '正在检查更新…'
      let continuation: UpdateContinuation | undefined
      const accepted = Promise.resolve().then(async (): Promise<UpdateFlowState> => {
        if (resume) {
          state.message = '正在验证续接目标…'
          const runtime = await exactPack(resume)
          next.signal.throwIfAborted()
          continuation = { operationId: randomUUID(), resume, runtime, handoff: null }
          await deps.continuation!.save(continuation)
          next.signal.throwIfAborted()
          state.operationId = continuation.operationId
          state.message = '已登记更新续接，将等待所有会话空闲后安装。'
        }
        return { ...snapshot(), accepted: true }
      })
      running = accepted.then(() => run(options, next.signal, continuation), async error => {
        if (continuation) await clearContinuation()
        if (next.signal.aborted) return
        state.phase = 'failed'
        state.message = messageOf(error)
      }).finally(() => {
        controller = null
        running = null
        if (state.phase !== 'applying') committed = false
      })
      return accepted
    },
    cancel: async () => {
      if (committed) throw new Error('安装已经开始，无法取消本次更新。')
      if (!controller) return snapshot()
      controller.abort(new Error('已取消本次更新。'))
      state.phase = 'idle'
      state.busy = []
      state.resumePacks = []
      state.message = '已取消本次更新。'
      return snapshot()
    },
    settled: () => running ?? checking?.then(() => undefined, () => undefined) ?? Promise.resolve(),
  }
}
