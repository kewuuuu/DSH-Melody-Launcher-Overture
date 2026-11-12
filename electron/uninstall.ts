// 卸载执行层：算计划、导出脚本、把真正的删除动作交给一个独立的 helper 进程去做。
//
// 为什么不自己删：EXE 正被自己占用，数据目录里可能还有运行中的运行时；所以把 ps1 和 run.cmd
// 写进 %TEMP% 的一个独立目录，detached 拉起后调用方立刻退出，helper 自己轮询等本进程消失再删。

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { UninstallPlan, UninstallRunOptions, UninstallScriptResult } from '../src/types'
import { createUninstallPlanAsync, type UninstallPlanInput } from './uninstall-plan'
import {
  UNINSTALL_COMMAND_FILENAME,
  UNINSTALL_SCRIPT_BOM,
  UNINSTALL_SCRIPT_FILENAME,
  buildUninstallCommand,
  buildUninstallScript,
} from './uninstall-script'

/** 停整合包最多等这么久，超时就不删了。 */
export const UNINSTALL_STOP_TIMEOUT_MS = 20_000

/** helper 目录名的前缀：%TEMP%\\kewu-uninstall-<8位随机>。 */
export const UNINSTALL_HELPER_PREFIX = 'kewu-uninstall-'

/** helper 里那个批处理的名字（真正的删除动作由它转手给 ps1）。 */
export const UNINSTALL_HELPER_COMMAND_FILENAME = 'run.cmd'

export const UNINSTALL_STOP_TIMEOUT_MESSAGE = '还有整合包在运行，已中止卸载'

/** 计划缓存的有效期：设置页反复进出时不必每次都重扫几十万个文件。 */
export const UNINSTALL_PLAN_CACHE_TTL_MS = 30_000

export interface UninstallServiceDeps {
  /** 计划输入：executablePath / installDir / dataDir / legacyDataDir / dshHome / tempDir。 */
  plan: UninstallPlanInput
  /** 停掉所有正在运行的整合包。父级主进程里接成 packControl.shutdown。 */
  stopAllPacks?: () => Promise<void> | void
  /** helper 目录落脚的临时目录，缺省 os.tmpdir()。 */
  tempDir?: string
  /** helper 要等待退出的进程号，缺省 process.pid。 */
  pid?: number
  /** 停整合包的超时，缺省 UNINSTALL_STOP_TIMEOUT_MS。 */
  stopTimeoutMs?: number
  spawnImpl?: typeof spawn
  /** 随机后缀，缺省 randomBytes(4) 的 16 进制（8 位）。 */
  randomSuffix?: () => string
  /** 计划缓存有效期，缺省 UNINSTALL_PLAN_CACHE_TTL_MS。 */
  planCacheTtlMs?: number
  /** 取当前时间，缺省 Date.now；测试用。 */
  now?: () => number
}

export interface UninstallService {
  plan(): Promise<UninstallPlan>
  exportScript(outDir: string, options?: { deleteData?: boolean }): Promise<UninstallScriptResult>
  run(options: UninstallRunOptions & { waitPid?: number }): Promise<{ started: boolean }>
}

/** %TEMP%\\kewu-uninstall-<8位随机> 的完整路径。 */
export function buildUninstallHelperDir(tempDir: string, suffix?: string): string {
  const tail = typeof suffix === 'string' && suffix.trim() ? suffix.trim() : randomBytes(4).toString('hex')
  return path.join(path.resolve(tempDir), UNINSTALL_HELPER_PREFIX + tail)
}

export function createUninstallService(deps: UninstallServiceDeps): UninstallService {
  const stopTimeoutMs =
    typeof deps.stopTimeoutMs === 'number' && deps.stopTimeoutMs > 0 ? deps.stopTimeoutMs : UNINSTALL_STOP_TIMEOUT_MS
  const helperTempDir = (): string => path.resolve(deps.tempDir ?? tmpdir())
  const selfPid = (): number => (typeof deps.pid === 'number' && deps.pid > 0 ? Math.trunc(deps.pid) : process.pid)
  const launcherPaths = () => ({ executablePath: deps.plan.executablePath, dataDir: deps.plan.dataDir })
  const planCacheTtlMs =
    typeof deps.planCacheTtlMs === 'number' && deps.planCacheTtlMs >= 0 ? deps.planCacheTtlMs : UNINSTALL_PLAN_CACHE_TTL_MS
  const now = deps.now ?? (() => Date.now())
  // 进程内缓存，绝不落盘：删除动作会改变磁盘状态，磁盘上的旧计划只会误导人。
  let planCache: { at: number; plan: Promise<UninstallPlan> } | null = null

  // 计划一律异步统计（同步遍历几十万个文件会把主进程卡十秒）。
  // 并发调用共享同一个 promise，冷启动也只会遍历一次。
  function plan(): Promise<UninstallPlan> {
    const cached = planCache
    if (cached && now() - cached.at < planCacheTtlMs) return cached.plan
    const entry = { at: now(), plan: createUninstallPlanAsync(deps.plan) }
    planCache = entry
    // 失败的计划不进缓存：下一次调用重新统计，而不是把错误钉死 30 秒。
    entry.plan.catch(() => {
      if (planCache === entry) planCache = null
    })
    return entry.plan
  }

  async function stopPacks(): Promise<void> {
    const stop = deps.stopAllPacks
    if (typeof stop !== 'function') return
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(UNINSTALL_STOP_TIMEOUT_MESSAGE)), stopTimeoutMs)
      if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref()
    })
    try {
      await Promise.race([Promise.resolve().then(() => stop()), timedOut])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message === UNINSTALL_STOP_TIMEOUT_MESSAGE) throw error
      throw new Error('停止整合包失败，已中止卸载：' + message)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  function launchHelper(commandPath: string): void {
    const spawnImpl = deps.spawnImpl ?? spawn
    // Node 20.12+ 拒绝直接 spawn 批处理文件（EINVAL），只能借 cmd.exe /c 把它拉起来。
    const comspec = process.env.ComSpec || 'cmd.exe'
    const child = spawnImpl(comspec, ['/c', commandPath], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  }

  async function exportScript(
    outDir: string,
    options?: { deleteData?: boolean },
  ): Promise<UninstallScriptResult> {
    const target = path.resolve(outDir)
    await mkdir(target, { recursive: true })
    const scriptPath = path.join(target, UNINSTALL_SCRIPT_FILENAME)
    const commandPath = path.join(target, UNINSTALL_COMMAND_FILENAME)
    const paths = launcherPaths()
    await writeFile(scriptPath, UNINSTALL_SCRIPT_BOM + buildUninstallScript(paths), 'utf8')
    await writeFile(
      commandPath,
      buildUninstallCommand({ ...paths, deleteData: options?.deleteData === true }),
      'utf8',
    )
    return { scriptPath, commandPath }
  }

  async function run(options: UninstallRunOptions & { waitPid?: number }): Promise<{ started: boolean }> {
    const deleteData = options?.deleteData === true
    const waitPid =
      typeof options?.waitPid === 'number' && options.waitPid > 0 ? Math.trunc(options.waitPid) : selfPid()
    // 整合包还开着就整件事别做：helper 起来以后再去抢文件只会删一半。
    await stopPacks()
    const helperDir = buildUninstallHelperDir(helperTempDir(), deps.randomSuffix?.())
    await mkdir(helperDir, { recursive: true })
    const scriptPath = path.join(helperDir, UNINSTALL_SCRIPT_FILENAME)
    const commandPath = path.join(helperDir, UNINSTALL_HELPER_COMMAND_FILENAME)
    // 日志放 helper 目录外：helper 跑完会自删整个目录，日志要留下来给用户看。
    const logPath = helperDir + '.log'
    const paths = launcherPaths()
    await writeFile(scriptPath, UNINSTALL_SCRIPT_BOM + buildUninstallScript(paths), 'utf8')
    await writeFile(
      commandPath,
      buildUninstallCommand({
        ...paths,
        waitPid,
        deleteData,
        logPath,
      }),
      'utf8',
    )
    launchHelper(commandPath)
    return { started: true }
  }

  return {
    plan,
    exportScript,
    run,
  }
}
