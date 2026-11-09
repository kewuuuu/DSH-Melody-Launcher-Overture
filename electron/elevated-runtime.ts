import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, writeFile, open, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'
import { clearElevatedSession, elevatedSessionPath } from './external-runtime'
import { buildWindowsBatchCommand, trackSpawnedProcess } from './process'

const sessions = new WeakMap<ChildProcessWithoutNullStreams, () => Promise<void>>()
const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'"

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
    '$hideConsole = { try { Add-Type -MemberDefinition ' + quote('[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);') + ' -Name Native -Namespace Kewu | Out-Null; $handle = [Kewu.Native]::GetConsoleWindow(); if ($handle -ne [IntPtr]::Zero) { [void][Kewu.Native]::ShowWindow($handle, 0) } } catch {}',
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
  sessions.set(child, async () => {
    await writeFile(stopPath, 'stop', 'utf8')
    if (child.exitCode === null) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Elevated pack did not acknowledge stop')), 15_000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
    })
    // 外层 powershell 已经退出时不能直接当成功：真正的 DSH 可能还活着（它被提权过，普通权限杀不掉）。
    if (child.exitCode !== null) {
      const pid = await readChildPid(root)
      if (pid !== null && processAlive(pid)) throw new Error('结束整合包的 DSH 进程需要管理员权限（PID ' + pid + '）。请在管理员 PowerShell 里执行：taskkill /pid ' + pid + ' /t /f')
    }
  })
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

export async function stopElevatedRuntime(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  const stop = sessions.get(child)
  if (!stop) return false
  await stop()
  return true
}
