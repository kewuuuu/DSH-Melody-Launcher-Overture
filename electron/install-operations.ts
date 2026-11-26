import { randomUUID } from 'node:crypto'
import type { CommandOptions, CommandResult } from './command'

const COMMAND_TIMEOUT_MS = 30 * 60_000

export interface InstallOperation {
  id: string
  signal: AbortSignal
  readonly cancellable: boolean
  commit(): void
  finish(): void
}

export function createInstallOperations() {
  let active: { operation: InstallOperation; settled: Promise<void>; cancel: () => void } | undefined
  let draining = false

  return {
    isBusy: () => active !== undefined,
    start(label: string): InstallOperation {
      if (draining) throw new Error('启动器正在退出，无法开始安装。')
      if (active) throw new Error('另一个 DSH 或插件安装正在进行，请等待完成。')
      const controller = new AbortController()
      let committing = false
      let settle: () => void = () => {}
      const settled = new Promise<void>(resolve => { settle = resolve })
      const operation: InstallOperation = {
        id: randomUUID(),
        signal: controller.signal,
        get cancellable() { return !committing && !controller.signal.aborted },
        commit() {
          controller.signal.throwIfAborted()
          committing = true
        },
        finish() {
          if (active?.operation !== operation) return
          active = undefined
          settle()
        },
      }
      active = {
        operation,
        settled,
        cancel() {
          if (operation.cancellable) controller.abort(new Error(`已取消${label}，可以重新安装。`))
        },
      }
      return operation
    },
    async cancel(id: string): Promise<void> {
      const current = active
      if (current?.operation.id !== id) return
      current.cancel()
      await current.settled
    },
    async drain(): Promise<void> {
      draining = true
      const current = active
      if (!current) return
      current.cancel()
      await current.settled
    },
    resume(): void { draining = false },
  }
}

export type InstallOperations = ReturnType<typeof createInstallOperations>

export function installProgressState(operation: InstallOperation | undefined, phase: string) {
  return {
    ...(operation ? { operationId: operation.id } : {}),
    cancellable: Boolean(operation?.cancellable && phase !== 'complete' && phase !== 'error'),
  }
}

export async function runInstallCommand(
  execute: (executable: string, args: string[], options: CommandOptions) => Promise<CommandResult>,
  executable: string,
  args: string[],
  options: CommandOptions,
  mutatesProfile = false,
): Promise<CommandResult> {
  options.signal?.throwIfAborted()
  const result = await execute(executable, args, { ...options, timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS })
  options.signal?.throwIfAborted()
  if (result.timedOut) {
    const recovery = mutatesProfile ? '请检查整合包插件状态，再重试或修复插件依赖。' : '请检查网络连接后重试安装。'
    throw new Error(`安装命令执行超时，已停止安装进程。${recovery}`)
  }
  return result
}
