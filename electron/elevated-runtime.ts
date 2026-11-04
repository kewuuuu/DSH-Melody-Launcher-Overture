import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, writeFile, open, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildWindowsBatchCommand, trackSpawnedProcess } from './process'

const sessions = new WeakMap<ChildProcessWithoutNullStreams, () => Promise<void>>()
const quote = (s: string) => "'" + s.replace(/'/g, "''") + "'"

export async function spawnElevatedRuntime(executable: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<ChildProcessWithoutNullStreams> {
  if (process.platform !== 'win32') throw new Error('Administrator launch is only supported on Windows')
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-elevated-'))
  const stdoutPath = path.join(root, 'stdout.log'), stderrPath = path.join(root, 'stderr.log'), stopPath = path.join(root, 'stop')
  const envScript = Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([k,v]) => '[Environment]::SetEnvironmentVariable(' + quote(k) + ',' + quote(v) + ',"Process")').join('\n')
  const command = buildWindowsBatchCommand(executable, args)
  const script = [envScript,
    '$ErrorActionPreference="Stop"',
    '$owner = Get-Process -Id ' + process.pid + ' -ErrorAction Stop; $ownerStart = $owner.StartTime.ToUniversalTime().Ticks',
    '$p = Start-Process -FilePath $env:ComSpec -ArgumentList @(\'/d\',\'/s\',\'/c\',' + quote(command) + ') -WorkingDirectory ' + quote(options.cwd) + ' -RedirectStandardOutput ' + quote(stdoutPath) + ' -RedirectStandardError ' + quote(stderrPath) + ' -WindowStyle Hidden -PassThru',
    'while (!$p.HasExited) {',
    '$owner = Get-Process -Id ' + process.pid + ' -ErrorAction SilentlyContinue',
    'if (!$owner -or $owner.StartTime.ToUniversalTime().Ticks -ne $ownerStart) { & taskkill.exe /pid $p.Id /t /f | Out-Null; $p.WaitForExit(); break }',
    'if (Test-Path -LiteralPath ' + quote(stopPath) + ') { & taskkill.exe /pid $p.Id /t /f | Out-Null; $p.WaitForExit(); break }',
    'Start-Sleep -Milliseconds 100; $p.Refresh()',
    '}', 'exit $p.ExitCode'].join('\n')
  const scriptPath = path.join(root, 'supervise.ps1')
  await writeFile(scriptPath, '﻿' + script, 'utf8')
  const outer = '$ErrorActionPreference="Stop"; try { $p = Start-Process powershell.exe -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",' + quote('"' + scriptPath + '"') + ') -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
  const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'pipe' }) as ChildProcessWithoutNullStreams
  trackSpawnedProcess(child)
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
  child.once('exit', () => { clearInterval(timer); void flush().finally(() => rm(root, { recursive: true, force: true }).catch(() => undefined)) })
  sessions.set(child, async () => {
    await writeFile(stopPath, 'stop', 'utf8')
    if (child.exitCode === null) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Elevated pack did not acknowledge stop')), 15_000)
      child.once('exit', () => { clearTimeout(timeout); resolve() })
    })
  })
  return child
}

export async function stopElevatedRuntime(child: ChildProcessWithoutNullStreams): Promise<boolean> {
  const stop = sessions.get(child)
  if (!stop) return false
  await stop()
  return true
}
