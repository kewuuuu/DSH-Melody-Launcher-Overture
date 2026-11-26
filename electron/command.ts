import { spawnWindowsInstallCommand } from './windows-install-process'
import { formatCommandLine, spawnCommand } from './process'

/**
 * 「启动子进程 → 转发输出 → 收集输出 → 等待退出码」这套流程原本在
 * 插件命令和 DSH 本体安装两处各写了一遍。这里抽成单一实现。
 */

export type OutputLevel = 'info' | 'error'

/** 只描述本模块真正用到的部分，便于测试传入替身。 */
export interface CommandProcess {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'exit' | 'close', listener: (code: number | null) => void): unknown
}

export interface CollectOptions {
  /** 每段输出到达时回调，用于转发到日志面板和进度解析。 */
  onOutput?: (text: string, level: OutputLevel) => void
  /** 保留的输出上限（字符数），只保留末尾部分。 */
  captureLimit?: number
  /** 超过该时长（毫秒）后终止整个子进程树，并以 exitCode -1 返回。 */
  timeoutMs?: number
  signal?: AbortSignal
}

export interface CommandOptions extends CollectOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** 进程启动后回调，供运行环境取消当前下载。 */
  onSpawn?: (child: ReturnType<typeof spawnCommand>) => void
}

export interface CommandResult {
  exitCode: number
  timedOut?: boolean
  /** 末尾若干字符的合并输出（stdout 与 stderr 按到达顺序）。 */
  output: string
}

export const DEFAULT_CAPTURE_LIMIT = 48_000

/** 监听一个已启动的子进程直到退出。子进程报错时 reject。 */
export function collectCommandOutput(
  child: CommandProcess,
  options: CollectOptions = {},
  terminate?: () => Promise<void>,
): Promise<CommandResult> {
  const limit = options.captureLimit ?? DEFAULT_CAPTURE_LIMIT
  let output = ''

  const handle = (level: OutputLevel) => (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    output = `${output}${text}`.slice(-limit)
    options.onOutput?.(text, level)
  }
  child.stdout.on('data', handle('info'))
  child.stderr.on('data', handle('error'))

  return new Promise<CommandResult>((resolve, reject) => {
    let termination: Promise<void> | undefined
    let didTimeout = false
    const stop = () => {
      if (termination) return
      termination = terminate?.().catch(error => {
        options.onOutput?.('停止命令进程树失败：' + String(error), 'error')
      }) ?? Promise.resolve()
    }
    const timer = options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => { didTimeout = true; stop() }, options.timeoutMs)
      : undefined
    const finish = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', stop)
    }
    // For managed commands wait for inherited stdio to close, as well as the tree terminator.
    child.once(terminate ? 'close' : 'exit', code => {
      finish()
      void (async () => {
        await termination
        if (options.signal?.aborted) {
          reject(options.signal.reason)
        } else if (didTimeout) {
          resolve({ exitCode: -1, timedOut: true, output: output + '\n[命令执行超时，已自动终止]\n' })
        } else {
          resolve({ exitCode: code ?? 1, output })
        }
      })()
    })
    child.once('error', error => {
      if (termination) return // close and tree termination still need to settle
      finish()
      reject(error)
    })
    options.signal?.addEventListener('abort', stop, { once: true })
    if (options.signal?.aborted) stop()
  })
}

async function terminateCommandTree(child: ReturnType<typeof spawnCommand>, windowsJob: boolean): Promise<void> {
  if (!child.pid) return
  if (windowsJob) {
    child.stdin.end()
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/** 启动一条命令并等待它结束。 */
export async function runCommand(
  executable: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  options.signal?.throwIfAborted()
  const commandLine = formatCommandLine(executable, args)
  options.onOutput?.(`命令：${commandLine}\n工作目录：${options.cwd}`, 'info')
  const managed = Boolean(options.timeoutMs || options.signal)
  const windowsJob = managed && process.platform === 'win32'
  let child
  try {
    const spawnOptions = { cwd: options.cwd, env: options.env }
    child = windowsJob ? spawnWindowsInstallCommand(executable, args, spawnOptions) : spawnCommand(executable, args, spawnOptions)
    if (windowsJob) child.stdin.on('error', () => {})
    options.onSpawn?.(child)
  } catch (error) {
    options.onOutput?.(`命令启动失败：${error instanceof Error ? error.message : String(error)}`, 'error')
    throw error
  }
  let result: CommandResult
  try {
    result = await collectCommandOutput(child, options, managed ? () => terminateCommandTree(child, windowsJob) : undefined)
  } catch (error) {
    options.onOutput?.(`命令执行异常：${error instanceof Error ? error.message : String(error)}`, 'error')
    throw error
  }
  options.onOutput?.(`命令退出：${result.exitCode}`, result.exitCode === 0 ? 'info' : 'error')
  return result
}
