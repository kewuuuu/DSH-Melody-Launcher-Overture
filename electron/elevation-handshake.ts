// 提权重启的启动握手：新实例在本模块里写一个启动标记，父进程在退出前等它出现。
//
// 为什么不直接等子进程句柄：重启走的是 Start-Process -Verb RunAs 且不加 -Wait，
// 拿到的只是 powershell 的退出码，提权后的那个进程根本不在父子关系里；UAC 被点「否」时
// 连进程都不会创建。唯一跨进程、跨权限级别都能看到的证据，就是双方都拿得到的这个文件。

import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'

export const BOOT_MARKER_FILENAME = 'launcher-boot.json'

/** 默认等多久、多久看一次：UAC 弹窗本身可能停十几秒，所以给到 20 秒。 */
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_POLL_MS = 250

export function bootMarkerPath(dataDir: string): string {
  return path.join(dataDir, BOOT_MARKER_FILENAME)
}

export interface BootMarker {
  pid: number
  at: number
}

/**
 * 写下「我已经起来了」。原子写是必须的：父进程几乎同时在轮询，
 * 半截 JSON 会被它读成「还没起来」，握手就白等了。
 */
export async function writeBootMarker(dataDir: string, now: () => number = Date.now, pid: number = process.pid): Promise<void> {
  const marker: BootMarker = { pid, at: now() }
  // writeFileAtomic 负责递归建目录，也不再发明第二种临时文件写法。
  await writeFileAtomic(bootMarkerPath(dataDir), JSON.stringify(marker) + '\n')
}

/** 清掉标记。文件本来就不在也算成功：下一次启动的握手不该被上一次的残留卡住。 */
export async function clearBootMarker(dataDir: string): Promise<void> {
  await rm(bootMarkerPath(dataDir), { force: true })
}

export interface WaitForBootMarkerOptions {
  /** 父进程发起重启的时间（毫秒），早于它的标记不算——那是上一次启动留下的。 */
  since: number
  timeoutMs?: number
  pollMs?: number
  read?: (file: string) => Promise<string | null>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** 读不到文件（还没写、正被 rename 覆盖）只能说明「还没起来」，不能在启动路径上抛。 */
async function readBootMarkerFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** 取出标记里的 at；文件缺失、JSON 坏、at 不是有限数字一律当「还没起来」。 */
function markerTimeOf(text: string | null): number | null {
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const at = (parsed as { at?: unknown }).at
    return typeof at === 'number' && Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}

/**
 * 等到新实例写下不早于 since 的标记。
 *
 * 返回 true 只代表「有一个新进程真的跑到了写标记这一步」；用户点「否」或者子进程启动即崩，
 * 都会一路等到超时返回 false，由调用方决定是留在当前实例还是退出。
 */
export async function waitForBootMarker(dataDir: string, options: WaitForBootMarkerOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const pollMs = options.pollMs !== undefined && options.pollMs > 0 ? options.pollMs : DEFAULT_POLL_MS
  const read = options.read ?? readBootMarkerFile
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const file = bootMarkerPath(dataDir)
  const deadline = now() + timeoutMs
  // 注入的 sleep 若不推进 now，只靠 deadline 会转不出来；用读次上限兜住这种注入。
  const maxReads = Math.ceil(timeoutMs / pollMs) + 2

  for (let attempt = 0; attempt < maxReads; attempt += 1) {
    let text: string | null = null
    try {
      text = await read(file)
    } catch {
      text = null
    }
    const markerTime = markerTimeOf(text)
    if (markerTime !== null && markerTime >= options.since) return true

    const remaining = deadline - now()
    if (remaining <= 0) return false
    await sleep(Math.min(pollMs, remaining))
  }
  return false
}
