import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, writeFile, open, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'
import { clearElevatedSession, elevatedSessionPath } from './external-runtime'
import { buildWindowsBatchCommand, trackSpawnedProcess } from './process'

/** 每个提权会话的落盘位置：停止时要靠它认出监督进程写下的 child.json。 */
const sessions = new WeakMap<ChildProcessWithoutNullStreams, { root: string; stopPath: string }>()
const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'"
/** 写完 stop 文件后等「监督进程已就绪」证据（child.json）的硬顶：UAC 还没应答时它根本不存在。 */
export const ELEVATED_STOP_ACK_MS = 3_000
/** 监督进程确认后就等外层 powershell 退出；超过这个时间按「杀不掉」处理，不再无限等。 */
export const ELEVATED_EXIT_WAIT_MS = 20_000

export interface ElevatedRuntimeStash {
  /** 会话落盘目录，通常是 <userData>/elevated。 */
  root: string
  /** 整合包 ID，同时是会话文件名。 */
  packId: string
}

export interface ElevatedSpawnOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  /** 有 stash 时把这次提权会话的信息写到盘上，监督进程没了也还能靠它停下。 */
  stash?: ElevatedRuntimeStash
}

async function readChildPid(root: string): Promise<number | null> {
  const text = await readFile(path.join(root, 'child.json'), 'utf8').catch(() => null)
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as { pid?: unknown }
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) ? parsed.pid : null
  } catch { return null }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export async function spawnElevatedRuntime(executable: string, args: string[], options: ElevatedSpawnOptions): Promise<ChildProcessWithoutNullStreams> {
  if (process.platform !== 'win32') throw new Error('Administrator launch is only supported on Windows')
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-elevated-'))
  const stdoutPath = path.join(root, 'stdout.log'), stderrPath = path.join(root, 'stderr.log'), stopPath = path.join(root, 'stop')
  const childPath = path.join(root, 'child.json')
  const envScript = Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([k,v]) => '[Environment]::SetEnvironmentVariable(' + quote(k) + ',' + quote(v) + ',"Process")').join('\n')
  const command = buildWindowsBatchCommand(executable, args)
  const script = [envScript,
    '$ErrorActionPreference="Stop"',
    '$hideConsole = { try { Add-Type -MemberDefinition ' + quote('[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);') + ' -Name Native -Namespace Kewu | Out-Null; $handle = [Kewu.Native]::GetConsoleWindow(); if ($handle -ne [IntPtr]::Zero) { [void][Kewu.Native]::ShowWindow($handle, 0) } } catch {} }',
    '& $hideConsole',
    '$owner = Get-Process -Id ' + process.pid + ' -ErrorAction Stop; $ownerStart = $owner.StartTime.ToUniversalTime().Ticks',
    '$p = Start-Process -FilePath $env:ComSpec -ArgumentList @(\'/d\',\'/s\',\'/c\',' + quote(command) + ') -WorkingDirectory ' + quote(options.cwd) + ' -RedirectStandardOutput ' + quote(stdoutPath) + ' -RedirectStandardError ' + quote(stderrPath) + ' -WindowStyle Hidden -PassThru',
    // 子进程 pid 落到 child.json：监督进程被中断后，外面还能靠它认出真正的 DSH。
    'try { [IO.File]::WriteAllText(' + quote(childPath) + ', ([pscustomobject]@{ pid = [int]$p.Id; startedAt = (Get-Date).ToUniversalTime().ToString("o"); stopFile = ' + quote(stopPath) + ' } | ConvertTo-Json -Compress)) } catch {}',
    'try {',
    'while (!$p.HasExited) {',
    '$owner = Get-Process -Id ' + process.pid + ' -ErrorAction SilentlyContinue',
    'if (!$owner -or $owner.StartTime.ToUniversalTime().Ticks -ne $ownerStart) { & taskkill.exe /pid $p.Id /t /f | Out-Null; $p.WaitForExit(); break }',
    'if (Test-Path -LiteralPath ' + quote(stopPath) + ') { & taskkill.exe /pid $p.Id /t /f | Out-Null; $p.WaitForExit(); break }',
    'Start-Sleep -Milliseconds 100; $p.Refresh()',
    '}',
    // 脚本异常、被 Ctrl+C、被外部杀掉都要把子进程树收掉：finally 是最后一道闸。
    '} finally { try { $p.Refresh(); if (!$p.HasExited) { & taskkill.exe /pid $p.Id /t /f | Out-Null; $p.WaitForExit() } } catch {} }',
    'exit $p.ExitCode'].join('\n')
  const scriptPath = path.join(root, 'supervise.ps1')
  await writeFile(scriptPath, '\uFEFF' + script, 'utf8')
  const outer = '$ErrorActionPreference="Stop"; try { $p = Start-Process powershell.exe -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-WindowStyle","Hidden","-File",' + quote('"' + scriptPath + '"') + ') -WindowStyle Hidden -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
  const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' }) as ChildProcessWithoutNullStreams
  trackSpawnedProcess(child)
  const sessionFile = options.stash ? elevatedSessionPath(options.stash.root, options.stash.packId) : null
  if (sessionFile) {
    await writeFileAtomic(sessionFile, JSON.stringify({
      version: 1,
      packId: options.stash!.packId,
      outerPid: child.pid ?? null,
      elevatedRoot: root,
      stopFile: stopPath,
      startedAt: new Date().toISOString(),
      logPaths: { stdout: stdoutPath, stderr: stderrPath },
    }, null, 2) + '\n').catch(() => undefined)
  }
  let outOffset = 0, errOffset = 0, reading = false
  async function readChunk(file: string, offset: number): Promise<Buffer> {
    const handle = await open(file, 'r').catch(() => null)
    if (!handle) return Buffer.alloc(0)
    try { const buffer = Buffer.alloc(64 * 1024); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); return buffer.subarray(0, bytesRead) } finally { await handle.close() }
  }
  const flush = async () => {
    if (reading) return
    reading = true
    try {
      const [a,b] = await Promise.all([readChunk(stdoutPath, outOffset), readChunk(stderrPath, errOffset)])
      if (a.length) child.stdout.emit('data', a)
      if (b.length) child.stderr.emit('data', b)
      outOffset += a.length; errOffset += b.length
    } finally { reading = false }
  }
  const timer = setInterval(() => { void flush() }, 100)
  timer.unref()
  child.once('exit', () => {
    clearInterval(timer)
    void flush().finally(async () => {
      if (sessionFile) await dropSessionFile(sessionFile, child.pid)
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    })
  })
  sessions.set(child, { root, stopPath })
  return child
}

/** 只删自己写的会话：pid 对不上说明是别人（下一次启动器启动）覆盖过的，别动。 */
async function dropSessionFile(file: string, pid: number | undefined): Promise<void> {
  if (pid === undefined) return
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) return
  try {
    const parsed = JSON.parse(text) as { outerPid?: unknown }
    if (parsed.outerPid !== pid) return
  } catch { return }
  await clearElevatedSession(path.dirname(file), path.basename(file, '.json'))
}

/** 等 outer 的 'exit'：已经退出就立即返回 true，超时返回 false。 */
function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise<boolean>(resolve => {
    let timer: NodeJS.Timeout | null = null
    function onExit(): void { finish(true) }
    function finish(exited: boolean): void {
      if (timer) clearTimeout(timer)
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref()
    child.once('exit', onExit)
  })
}

/** 等监督进程把 child.json 写出来（提权启动真的进了 DSH）；外层提前退出时返回 'exited'。 */
async function waitForSupervisor(child: ChildProcessWithoutNullStreams, root: string, timeoutMs: number): Promise<'ready' | 'exited' | 'timeout'> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await readChildPid(root) !== null) return 'ready'
    if (child.exitCode !== null || child.signalCode !== null) return 'exited'
    if (Date.now() >= deadline) return 'timeout'
    await new Promise<void>(resolve => { setTimeout(resolve, 100) })
  }
}

/** 收掉一个 pid 的整棵树；taskkill 本身卡住（被拦、被杀软拖住）也不许把调用方挂死。 */
async function taskkillTree(pid: number | undefined): Promise<void> {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return
  const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], { windowsHide: true })
  await new Promise<void>(resolve => {
    let timer: NodeJS.Timeout | null = null
    function finish(): void {
      if (timer) clearTimeout(timer)
      killer.removeListener('exit', finish)
      killer.removeListener('error', finish)
      resolve()
    }
    // 有的进程已经退了才被我们等：这时 'exit' 不会再发第二次，等下去只会白等到兜底超时。
    if (killer.exitCode !== null || killer.signalCode !== null) { finish(); return }
    timer = setTimeout(finish, 5_000)
    timer.unref()
    killer.once('error', finish)
    killer.once('exit', finish)
  })
}

/** 提权进程普通权限杀不掉时，给用户一条能自救的命令。 */
function elevationHint(pid: number): string {
  return '结束整合包的 DSH 进程需要管理员权限（PID ' + pid + '）。请在管理员 PowerShell 里执行：taskkill /pid ' + pid + ' /t /f'
}

/**
 * 停止提权整合包。每个分支都有硬顶，不再出现「硬等 15 秒后抛错、状态还留在 running」：
 * 写 stop 文件 → 最多 3 秒等监督进程就绪（child.json）；没起来就把外层 powershell 撤掉，按「启动已取消」收尾；
 * 起来了就最多 20 秒等外层退出；外层退出后真正的 DSH 还活着，说明它提权后普通权限杀不掉，如实报错。
 */
export async function stopElevatedRuntime(child: ChildProcessWithoutNullStreams, options: { force?: boolean } = {}): Promise<boolean> {
  const session = sessions.get(child)
  if (!session) return false
  const { root, stopPath } = session

  if (options.force === true) {
    // 强制停：不信监督进程会优雅收尾，直接砍外层和已知的子进程树。
    await taskkillTree(child.pid)
    const known = await readChildPid(root)
    if (known !== null) await taskkillTree(known)
    const exited = await waitForExit(child, ELEVATED_STOP_ACK_MS)
    const survivor = await readChildPid(root)
    if (!exited && child.exitCode === null) throw new Error('强制结束提权整合包失败：外层 PowerShell（PID ' + (child.pid ?? '未知') + '）还在运行。请在管理员 PowerShell 里执行：taskkill /pid ' + (child.pid ?? '<PID>') + ' /t /f')
    if (survivor !== null && processAlive(survivor)) throw new Error(elevationHint(survivor))
    return true
  }

  await writeFile(stopPath, 'stop', 'utf8')
  const ack = await waitForSupervisor(child, root, ELEVATED_STOP_ACK_MS)
  if (ack !== 'ready') {
    // 监督进程还没起来（UAC 没应答时就是这样）：写下去的 stop 没人消费，只能把外层撤掉，按「启动已取消」收尾。
    await taskkillTree(child.pid)
    const cancelled = await waitForExit(child, ELEVATED_STOP_ACK_MS)
    const late = await readChildPid(root)
    if (late !== null && processAlive(late)) throw new Error(elevationHint(late))
    if (!cancelled && child.exitCode === null) throw new Error('取消提权启动失败：外层 PowerShell（PID ' + (child.pid ?? '未知') + '）没有退出。请在管理员 PowerShell 里执行：taskkill /pid ' + (child.pid ?? '<PID>') + ' /t /f')
    return true
  }

  const exited = await waitForExit(child, ELEVATED_EXIT_WAIT_MS)
  if (!exited) throw new Error('提权整合包没有确认停止（Elevated pack did not acknowledge stop）：外层 PowerShell 在 ' + Math.round(ELEVATED_EXIT_WAIT_MS / 1000) + ' 秒内没有退出。请在管理员 PowerShell 里执行：taskkill /pid ' + (child.pid ?? '<PID>') + ' /t /f')
  // 外层退出不等于结束了：真正的 DSH 可能还活着（它被提权过，普通权限杀不掉）。
  const pid = await readChildPid(root)
  if (pid !== null && processAlive(pid)) throw new Error(elevationHint(pid))
  return true
}

/** 监督进程是否已经确认启动（child.json 落盘）。不是提权会话、或还没确认都返回 false。 */
export async function elevatedRuntimeReady(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  const session = sessions.get(child)
  if (!session) return false
  return (await readChildPid(session.root)) !== null
}
