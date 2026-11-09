import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ExternalRuntime } from '../src/types'

/**
 * 外部 DSH 进程：不在本进程内存里的 RuntimeController，启动器重启、提权监督进程已经退掉的
 * 遗留进程都算。这里只做「认领」和「停止」，不做端口探测以外的任何网络动作。
 */

export interface ProcessSnapshot {
  pid: number
  name?: string | null
  commandLine?: string | null
  startedAt?: string | null
  elevated?: boolean | null
}

export interface ScanExternalRuntimesInput {
  packs: Array<{ id: string; profileName?: string }>
  excludePids?: number[]
  timeoutMs?: number
}

export interface StopExternalRuntimeOptions {
  dataDir: string
  allowElevation: boolean
  log?: (text: string) => void
}

export type StopExternalRuntimeMethod = 'session' | 'taskkill' | 'elevated'

export interface ElevatedSessionRecord {
  version?: number
  packId?: string
  outerPid?: number
  elevatedRoot?: string
  stopFile?: string
  startedAt?: string
  logPaths?: Record<string, string>
}

export interface ExternalRuntimeDeps {
  platform: NodeJS.Platform
  now: () => number
  sleep: (ms: number) => Promise<void>
  runPowerShell: (script: string, timeoutMs: number) => Promise<string>
  runCommand: (command: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>
  isAlive: (pid: number) => boolean
  readTextFile: (file: string) => Promise<string | null>
  writeTextFile: (file: string, content: string) => Promise<void>
}

const CACHE_TTL_MS = 2000
const DEFAULT_SCAN_TIMEOUT_MS = 4000
const SESSION_STOP_WAIT_MS = 15_000
const ELEVATED_KILL_WAIT_MS = 20_000
const POLL_INTERVAL_MS = 200
const COMMAND_TIMEOUT_MS = 30_000

/** 一次 CIM 查询拿全量快照：命令行、启动时间、映像名，外加 OpenProcess(PROCESS_TERMINATE) 探测提权。 */
const SCAN_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -Namespace LauncherOverture -Name Native -MemberDefinition '[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(int access, bool inherit, int pid); [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);'
$rows = @()
foreach ($row in (Get-CimInstance Win32_Process | Where-Object { $_.Name -match '(?i)^(node|cmd)([.]exe)?$' })) {
  if (-not $row.CommandLine) { continue }
  $handle = [LauncherOverture.Native]::OpenProcess(0x0001, $false, [int]$row.ProcessId)
  $elevated = $handle -eq [IntPtr]::Zero
  if ($handle -ne [IntPtr]::Zero) { [void][LauncherOverture.Native]::CloseHandle($handle) }
  $started = $null
  if ($row.CreationDate) { $started = ([datetime]$row.CreationDate).ToUniversalTime().ToString('o') }
  $rows += [pscustomobject]@{ pid = [int]$row.ProcessId; name = $row.Name; commandLine = $row.CommandLine; startedAt = $started; elevated = [bool]$elevated }
}
if ($rows.Count -eq 0) { [Console]::Out.Write('[]') } else { [Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Depth 4 -Compress)) }`

function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* 已经退出 */ }
      reject(new Error('命令执行超时：' + command))
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(error) })
    child.once('close', code => { if (settled) return; settled = true; clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }) })
  })
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程还在，只是没权限碰它。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const defaultDeps: ExternalRuntimeDeps = {
  platform: process.platform,
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() }),
  runPowerShell: (script, timeoutMs) => runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeoutMs).then(result => result.stdout),
  runCommand: runProcess,
  isAlive: processAlive,
  readTextFile: async file => {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  writeTextFile: async (file, text) => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text, 'utf8')
  },
}

let deps: ExternalRuntimeDeps = { ...defaultDeps }
const cache = new Map<string, { at: number; result: Map<string, ExternalRuntime> }>()

/** 测试注入用：传 null 恢复默认实现并清空扫描缓存。 */
export function __setExternalRuntimeDeps(overrides: Partial<ExternalRuntimeDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : { ...defaultDeps }
  cache.clear()
}

export function clearExternalRuntimeCache(): void {
  cache.clear()
}

/** 提权会话落在 <dataDir>/elevated/<id>.json，写方是 elevated-runtime 的 stash。 */
export function elevatedSessionPath(root: string, id: string): string {
  return path.join(root, id.replace(/[^A-Za-z0-9._-]/g, '_') + '.json')
}

export async function readSessionAt(file: string | null | undefined): Promise<ElevatedSessionRecord | null> {
  if (!file) return null
  const text = await deps.readTextFile(file).catch(() => null)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as ElevatedSessionRecord
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export async function readElevatedSession(root: string, id: string): Promise<ElevatedSessionRecord | null> {
  if (!root || !id) return null
  return readSessionAt(elevatedSessionPath(root, id))
}

export async function clearElevatedSession(root: string, id: string): Promise<void> {
  if (!root || !id) return
  await rm(elevatedSessionPath(root, id), { force: true }).catch(() => undefined)
}

/** 命令行里的 --profile 值，支持 --profile x / --profile=x / 带引号。 */
function profileValues(commandLine: string): string[] {
  const values: string[] = []
  const pattern = /--profile(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(commandLine)) !== null) values.push(match[1] ?? match[2] ?? match[3] ?? '')
  return values
}

function portValue(commandLine: string): number | null {
  const match = /--port(?:=|\s+)(\d{1,5})/.exec(commandLine)
  if (!match) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
}

/** dsh 本体：dsh-runtime 安装目录、dsh\lib\bin.js，或者 .pnpm 里解出来的 harness 包。 */
function isDshRuntime(commandLine: string): boolean {
  if (/dsh-runtime/i.test(commandLine)) return true
  if (/dsh[\\/]+lib[\\/]+bin[.]js/i.test(commandLine)) return true
  if (/dsh-harness/i.test(commandLine) && /bin[.]js/i.test(commandLine)) return true
  return false
}

function parseSnapshot(text: string): ProcessSnapshot[] {
  const trimmed = (text ?? '').trim()
  if (!trimmed) return []
  const arrayAt = trimmed.indexOf('[')
  const objectAt = trimmed.indexOf('{')
  let body = trimmed
  if (arrayAt >= 0 && (objectAt < 0 || arrayAt < objectAt)) body = trimmed.slice(arrayAt)
  else if (objectAt >= 0) body = trimmed.slice(objectAt)
  const attempts = [body]
  const end = body.lastIndexOf(']')
  if (end >= 0) attempts.push(body.slice(0, end + 1))
  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt) as unknown
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return list.filter((row): row is ProcessSnapshot => !!row && typeof row === 'object' && Number.isInteger((row as ProcessSnapshot).pid))
    } catch {
      continue
    }
  }
  return []
}

function describe(row: ProcessSnapshot, profileName: string): ExternalRuntime {
  const commandLine = row.commandLine ?? ''
  const port = portValue(commandLine)
  return {
    pid: row.pid,
    port,
    startedAt: row.startedAt ?? null,
    url: port === null ? null : 'http://127.0.0.1:' + port + '/',
    profileName,
    requiresElevation: row.elevated === true,
    elevatedSession: null,
  }
}

function pickForProfile(rows: ProcessSnapshot[], profileName: string, exclude: Set<number>): ProcessSnapshot | null {
  const candidates = rows
    .filter(row => !!row.commandLine)
    .filter(row => !exclude.has(row.pid))
    .filter(row => profileValues(row.commandLine as string).includes(profileName))
    .filter(row => isDshRuntime(row.commandLine as string))
    .sort((a, b) => a.pid - b.pid)
  if (!candidates.length) return null
  // 同一个包可能同时命中 cmd 外壳和真正的 node 本体，本体才是能停的那个。
  const nodeRuntime = candidates.find(row => /bin[.]js/i.test(row.commandLine as string))
  return nodeRuntime ?? candidates[0]
}

/**
 * 一次 PowerShell 快照 + 本地匹配。超时、PowerShell 起不来、输出不是 JSON 都只返回空 Map：
 * 列表页不能因为探测失败整页变红。结果缓存 2 秒，界面会频繁拉 pack.list。
 */
export async function scanExternalRuntimes(input: ScanExternalRuntimesInput): Promise<Map<string, ExternalRuntime>> {
  const packs = (input?.packs ?? []).filter(pack => !!pack && typeof pack.id === 'string' && !!pack.id && typeof pack.profileName === 'string' && !!pack.profileName)
  if (!packs.length) return new Map()
  const exclude = new Set<number>([...(input.excludePids ?? []).filter(pid => Number.isInteger(pid)), process.pid])
  const key = JSON.stringify({ packs: packs.map(pack => [pack.id, pack.profileName]), exclude: [...exclude].sort((a, b) => a - b) })
  const hit = cache.get(key)
  if (hit && deps.now() - hit.at < CACHE_TTL_MS) return new Map(hit.result)
  const timeoutMs = Number.isFinite(input.timeoutMs) && (input.timeoutMs as number) > 0 ? Math.min(input.timeoutMs as number, 60_000) : DEFAULT_SCAN_TIMEOUT_MS
  let rows: ProcessSnapshot[] = []
  try {
    rows = parseSnapshot(await deps.runPowerShell(SCAN_SCRIPT, timeoutMs))
  } catch {
    rows = []
  }
  const result = new Map<string, ExternalRuntime>()
  for (const pack of packs) {
    const row = pickForProfile(rows, pack.profileName as string, exclude)
    if (row) result.set(pack.id, describe(row, pack.profileName as string))
  }
  if (cache.size >= 16) cache.clear()
  cache.set(key, { at: deps.now(), result })
  return new Map(result)
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = deps.now() + timeoutMs
  while (true) {
    if (!deps.isAlive(pid)) return true
    if (deps.now() >= deadline) return false
    await deps.sleep(POLL_INTERVAL_MS)
  }
}

function quotePowerShell(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

/** 提权结束进程：UAC 只弹一次，里面跑的仍然是同一句 taskkill。 */
function elevatedKillScript(pid: number): string {
  return String.raw`$ErrorActionPreference = 'Stop'
Start-Process -FilePath ` + quotePowerShell('powershell.exe') + String.raw` -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ` + quotePowerShell('taskkill.exe /pid ' + String(pid) + ' /t /f') + String.raw`)`
}

function needsAdminMessage(pid: number): string {
  return '结束整合包的 DSH 进程需要管理员权限（PID ' + pid + '）。请在管理员 PowerShell 里执行：taskkill /pid ' + pid + ' /t /f'
}

/**
 * 停止一个外部 DSH 进程。三步依次尝试，每一步都复查 pid 真的消失，不看退出码：
 * ① 提权会话留下的停止文件（监督进程还在时最干净）② 普通 taskkill ③ 提权 taskkill。
 */
export async function stopExternalRuntime(target: ExternalRuntime, options: StopExternalRuntimeOptions): Promise<StopExternalRuntimeMethod> {
  const log = options.log ?? (() => undefined)
  const pid = target.pid
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('外部 DSH 进程的 PID 无效：' + String(pid))
  if (!deps.isAlive(pid)) {
    log('进程 ' + pid + ' 已经不在了')
    return 'taskkill'
  }
  // 会话文件在 <dataDir>/elevated/<packId>.json，和 elevated-runtime 的 stash 同一处。调用方
  // 已经从 pack.list 认出了具体是哪个包时就直接用那条路径：profileName 和 packId 通常不是一个字符串。
  const session = await readSessionAt(target.elevatedSession) ?? await readElevatedSession(path.join(options.dataDir, 'elevated'), target.profileName)
  if (session?.stopFile) {
    log('写入提权会话停止文件 ' + session.stopFile)
    try {
      await deps.writeTextFile(session.stopFile, 'stop')
    } catch (error) {
      log('写停止文件失败：' + (error instanceof Error ? error.message : String(error)))
    }
    if (await waitForExit(pid, SESSION_STOP_WAIT_MS)) return 'session'
    log('提权会话在 15 秒内没有停下，改用 taskkill')
  }
  if (deps.platform === 'win32') {
    log('执行 taskkill /pid ' + pid + ' /t /f')
    try {
      const killed = await deps.runCommand('taskkill', ['/pid', String(pid), '/t', '/f'], COMMAND_TIMEOUT_MS)
      if (killed.stderr.trim()) log(killed.stderr.trim())
    } catch (error) {
      log('taskkill 执行失败：' + (error instanceof Error ? error.message : String(error)))
    }
  } else {
    try { process.kill(pid, 'SIGKILL') } catch (error) { log('kill 执行失败：' + (error instanceof Error ? error.message : String(error))) }
  }
  if (await waitForExit(pid, ELEVATED_KILL_WAIT_MS)) return 'taskkill'
  if (target.requiresElevation && options.allowElevation) {
    log('目标进程需要管理员权限，弹一次 UAC 结束它')
    try {
      await deps.runPowerShell(elevatedKillScript(pid), COMMAND_TIMEOUT_MS)
    } catch (error) {
      log('提权结束进程失败：' + (error instanceof Error ? error.message : String(error)))
    }
    if (await waitForExit(pid, ELEVATED_KILL_WAIT_MS)) return 'elevated'
  }
  throw new Error(needsAdminMessage(pid))
}
