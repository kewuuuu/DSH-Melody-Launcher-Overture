// 启动时申请管理员权限：只做三件纯逻辑的事——判断要不要提权重启、拼重启参数、真的去弹 UAC。
//
// 这个模块刻意不 import electron：判断与拼参可以在普通 node 下测，
// 主进程只负责把 app.getPath('userData') 和 process.execPath 传进来。

import { spawn } from 'node:child_process'
import path from 'node:path'

/** 提权重启的自我标记：argv 里已经有它，就说明这次已经是提权后的那次。 */
export const ELEVATED_RELAUNCH_FLAG = '--elevated-relaunch'

/** 等 UAC 弹窗的上限；正常点「是」或「否」都远快于此，这里只兜住一个卡死的 shell。 */
export const ELEVATION_RELAUNCH_TIMEOUT_MS = 120_000

/** 判断一个 argv 项是不是提权重启标记（容忍大小写与 --flag=value 写法，避免无限重启）。 */
export function isElevatedRelaunchFlag(argument: string): boolean {
  const lower = argument.toLowerCase()
  return lower === ELEVATED_RELAUNCH_FLAG || lower.startsWith(ELEVATED_RELAUNCH_FLAG + '=')
}

export interface ElevationDecision {
  launchElevated: boolean | undefined
  argv: readonly string[]
  elevated: boolean
}

/**
 * 只有「设置开着 + 这次不是提权重启 + 当前没提权」三个条件同时成立才重启，
 * 少任何一个都返回 false：漏判会无限重启，多判只是没提权。
 */
export function shouldRelaunchElevated(input: ElevationDecision): boolean {
  if (input.launchElevated !== true) return false
  if (input.elevated) return false
  return !input.argv.some((argument) => isElevatedRelaunchFlag(argument))
}

/** 是否是 --data-dir 参数（空格写法或等号写法都算）。 */
function isDataDirArgument(argument: string): boolean {
  const lower = argument.toLowerCase()
  return lower === '--data-dir' || lower.startsWith('--data-dir=')
}

/**
 * 拼提权重启的参数：去掉旧的 --elevated-relaunch 与 --data-dir（连同空格写法的值），
 * 再补上标记与绝对路径的数据目录——重启后的实例必须落在同一份数据上。
 */
export function buildElevatedRelaunchArgs(input: { argv: readonly string[]; dataDir: string }): string[] {
  const kept: string[] = []
  for (let index = 0; index < input.argv.length; index += 1) {
    const argument = input.argv[index]
    if (isElevatedRelaunchFlag(argument)) continue
    if (isDataDirArgument(argument)) {
      // 空格写法的值是下一个参数，得一起丢掉，否则它会变成位置参数。
      if (!argument.includes('=') && index + 1 < input.argv.length) index += 1
      continue
    }
    kept.push(argument)
  }
  return [...kept, ELEVATED_RELAUNCH_FLAG, '--data-dir=' + path.resolve(input.dataDir)]
}

/** PowerShell 单引号字符串：内部单引号翻倍即可，空格/中文/等号/$ 全都不用转义。 */
function quotePowerShell(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/** Start-Process -Verb RunAs 的那一行脚本（不加 -Wait：让窗口正常自己起来）。 */
export function buildElevatedPowerShellCommand(input: { executablePath: string; args: readonly string[] }): string {
  const list = input.args.map((argument) => quotePowerShell(argument)).join(',')
  return 'Start-Process -FilePath ' + quotePowerShell(input.executablePath) + ' -ArgumentList @(' + list + ') -Verb RunAs'
}

export interface RelaunchElevatedOptions {
  executablePath: string
  args: readonly string[]
  spawnImpl?: typeof spawn
  /** 缺省 powershell.exe；测试可换成假的。 */
  powershellPath?: string
  timeoutMs?: number
}

/**
 * 弹一次 UAC 并把新实例拉起来。返回 true 表示新进程已交给系统；
 * 用户点「否」、UAC 被策略拦下、PowerShell 起不来等全部返回 false + 一条 warn，
 * 绝不抛异常——启动器不能因为一次被拒绝的提权就崩掉。
 */
export async function relaunchElevated(options: RelaunchElevatedOptions): Promise<boolean> {
  const executablePath = typeof options.executablePath === 'string' ? options.executablePath.trim() : ''
  if (!executablePath) {
    console.warn('[startup-elevation] 缺少可执行文件路径，跳过提权重启。')
    return false
  }
  if (process.platform !== 'win32') {
    console.warn('[startup-elevation] 只有 Windows 支持提权重启，跳过。')
    return false
  }
  const script = buildElevatedPowerShellCommand({ executablePath, args: options.args })
  const spawnImpl = options.spawnImpl ?? spawn
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : ELEVATION_RELAUNCH_TIMEOUT_MS

  return await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (ok: boolean, warning?: string): void => {
      if (settled) return
      settled = true
      if (warning) console.warn(warning)
      resolve(ok)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawnImpl(
        options.powershellPath ?? 'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
    } catch (error) {
      finish(false, '[startup-elevation] 无法启动 PowerShell，按未提权继续：' + describe(error))
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 杀不掉也无所谓，下面照常按失败收尾。
      }
      finish(false, '[startup-elevation] 等待管理员授权超时，按未提权继续。')
    }, timeoutMs)
    if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref()

    let stderr = ''
    child.stderr?.on('data', (chunk: unknown) => {
      stderr = (stderr + String(chunk)).slice(-2000)
    })
    child.on('error', (error: unknown) => {
      clearTimeout(timer)
      finish(false, '[startup-elevation] 提权重启失败，按未提权继续：' + describe(error))
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      if (code === 0) {
        finish(true)
        return
      }
      const detail = stderr.trim() || 'PowerShell 退出码 ' + String(code)
      finish(false, '[startup-elevation] 提权重启被拒绝或失败，按未提权继续：' + detail)
    })
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface ElevationRelaunchHooks {
  releaseLock: () => void
  acquireLock: () => boolean
  relaunch: () => Promise<boolean>
}

export type ElevationRelaunchOutcome = 'relaunched' | 'continued' | 'handed-over'

/**
 * 提权重启与单实例锁的时序编排。
 *
 * 提权子进程一启动就要 requestSingleInstanceLock()，所以父进程必须先放手：否则子进程拿到
 * false 立刻 quit，父进程随后也 quit，用户看到的是「点了以后什么都没开」。
 * 顺序固定为 release → relaunch → (失败才) acquire，成功路径绝不把锁抢回来。
 *
 * releaseLock 抛错时整体按 'continued' 收尾（不 relaunch、不 acquire）：锁的状态已经不可信，
 * 此时重启只可能得到「父子都拿不到锁、两个进程都不在」的最坏结果；留在当前进程里未提权
 * 运行，至少启动器是开的。relaunch 抛错则走正常的失败分支（acquire 决定继续还是交班）。
 */
export async function orchestrateElevationRelaunch(hooks: ElevationRelaunchHooks): Promise<ElevationRelaunchOutcome> {
  try {
    hooks.releaseLock()
  } catch (error) {
    console.warn('[startup-elevation] 释放单实例锁失败，放弃提权重启，按当前实例继续：' + describe(error))
    return 'continued'
  }
  let relaunched = false
  try {
    relaunched = await hooks.relaunch()
  } catch (error) {
    // 交给下面的 acquire 分支定夺：新实例可能已经起来了，那就该交班而不是再开一个窗口。
    console.warn('[startup-elevation] 提权重启调用抛错，按未提权继续：' + describe(error))
  }
  if (relaunched) return 'relaunched'
  return hooks.acquireLock() ? 'continued' : 'handed-over'
}
