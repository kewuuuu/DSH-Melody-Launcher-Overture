import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { setTimeout as delay } from 'node:timers/promises'
import { buildWindowsBatchCommand, withExecutableDirectoryOnPath } from './process'

const FILE = {
  config: 'launch.json', ready: 'ready.json', accepted: 'accepted', finished: 'finished.json',
  stop: 'stop', stdout: 'stdout.log', stderr: 'stderr.log',
} as const
const POLL_MS = 100
const STOP_TIMEOUT_MS = 20_000

export interface IndependentRuntimeOptions {
  /** A persistent, launcher-owned directory outside the installation being updated. */
  root: string
}

export interface IndependentRuntimeSession {
  version: 1
  sessionId: string
  sessionRoot: string
  runtimePid: number
  workerPid: number
  startedAt: string
  elevated: boolean
  stopFile: string
  logPaths: { stdout: string; stderr: string }
}

interface LaunchOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  root: string
  nodeExecutable: string
  readyTimeoutMs: number
  elevated: boolean
  runAs?: boolean
}

interface LocalSession {
  root: string
  elevated: boolean
  completed: boolean
  spawnError?: Error
  exitCode: number | null
}

const sessions = new WeakMap<ChildProcess, LocalSession>()

// This worker runs under the pack's independent Node executable and needs only built-in modules.
const WORKER = String.raw`import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const file = ${JSON.stringify(FILE)}
const root = process.argv[2]
const at = name => join(root, name)
const has = name => existsSync(at(name))
const save = (name, value) => {
  writeFileSync(at(name + '.tmp'), JSON.stringify(value), { mode: 0o600 })
  renameSync(at(name + '.tmp'), at(name))
}
const log = (name, chunk) => appendFileSync(at(name), chunk)
const alive = pid => {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}
function run() {
  if (has(file.stop)) return
  const config = JSON.parse(readFileSync(at(file.config), 'utf8'))
  rmSync(at(file.config), { force: true })
  const pending = () => !has(file.accepted) && (Date.now() >= config.deadline || !alive(config.ownerPid))
  if (has(file.stop) || pending()) {
    save(file.finished, { sessionId: config.sessionId })
    return
  }
  const windows = process.platform === 'win32'
  const child = spawn(config.command, config.args, {
    cwd: config.cwd, env: config.env, windowsHide: true,
    windowsVerbatimArguments: config.windowsVerbatimArguments,
    detached: !windows, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const startedAt = new Date().toISOString()
  let stopping = false
  const stop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null || stopping) return
    stopping = true
    if (windows) {
      // Keep the process handle open for the whole stop operation.
      const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true, stdio: 'ignore', timeout: 5000,
      })
      if (result.status !== 0) stopping = false
    } else {
      try { process.kill(-child.pid, 'SIGKILL') }
      catch { child.kill('SIGKILL') }
    }
  }
  const relay = (name, chunk) => {
    try { log(name, chunk) } catch { stop() }
  }
  child.stdout.on('data', chunk => relay(file.stdout, chunk))
  child.stderr.on('data', chunk => relay(file.stderr, chunk))
  child.on('error', error => relay(file.stderr, error.message + '\n'))
  child.once('spawn', () => {
    try {
      save(file.ready, { version: 1, sessionId: config.sessionId, runtimePid: child.pid,
        workerPid: process.pid, startedAt, elevated: config.elevated })
    } catch { stop() }
  })
  const tick = setInterval(() => {
    if (has(file.stop) || pending()) { stop(); return }
    if (child.exitCode !== null || child.signalCode !== null || !child.pid || !has(file.accepted)) return
    try {
      for (const name of readdirSync(root)) {
        if (/^probe-[0-9a-f-]{36}$/.test(name)) rmSync(at(name), { force: true })
      }
    } catch { stop() }
  }, ${POLL_MS})
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  child.once('close', code => {
    clearInterval(tick)
    save(file.finished, { sessionId: config.sessionId })
    process.exitCode = code ?? (stopping ? 0 : 1)
  })
}
try { run() }
catch (error) { log(file.stderr, error.message + '\n'); process.exitCode = 1 }
`

const exists = async (file: string): Promise<boolean> => {
  try { await access(file); return true }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function record(root: string, file: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path.join(root, file), 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  }
}

async function readSession(root: string): Promise<IndependentRuntimeSession | null> {
  const value = await record(root, FILE.ready)
  if (!value || value.version !== 1 || typeof value.sessionId !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(value.sessionId) || typeof value.runtimePid !== 'number' ||
      !Number.isSafeInteger(value.runtimePid) || value.runtimePid <= 0 || typeof value.workerPid !== 'number' ||
      !Number.isSafeInteger(value.workerPid) || value.workerPid <= 0 || typeof value.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.startedAt)) || typeof value.elevated !== 'boolean') return null
  return {
    version: 1, sessionId: value.sessionId, sessionRoot: root, runtimePid: value.runtimePid, workerPid: value.workerPid,
    startedAt: value.startedAt, elevated: value.elevated, stopFile: path.join(root, FILE.stop),
    logPaths: { stdout: path.join(root, FILE.stdout), stderr: path.join(root, FILE.stderr) },
  }
}

function sameSession(a: IndependentRuntimeSession | null, b: IndependentRuntimeSession): boolean {
  return !!a && a.sessionId === b.sessionId && a.runtimePid === b.runtimePid &&
    a.workerPid === b.workerPid && a.startedAt === b.startedAt && a.elevated === b.elevated
}

/** Ask the original worker for live proof. A stale file or a reused PID cannot answer. */
export async function readIndependentRuntimeSession(root: string): Promise<IndependentRuntimeSession | null> {
  const session = await readSession(root)
  if (!session || !await exists(path.join(root, FILE.accepted)) || await exists(session.stopFile) || await exists(path.join(root, FILE.finished))) return null
  const probe = path.join(root, 'probe-' + randomUUID())
  await writeFile(probe, '', { flag: 'wx' })
  try {
    const deadline = Date.now() + 2000
    do {
      if (await exists(session.stopFile) || await exists(path.join(root, FILE.finished))) return null
      if (!await exists(probe)) return sameSession(await readSession(root), session) ? session : null
      await delay(POLL_MS)
    } while (Date.now() < deadline)
    return null
  } finally {
    await rm(probe, { force: true })
  }
}

async function waitForStop(root: string, sessionId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  do {
    if ((await record(root, FILE.finished))?.sessionId === sessionId) return
    await delay(POLL_MS)
  } while (Date.now() < deadline)
  throw new Error('独立整合包没有确认停止，无法确认进程已退出。')
}

/** Stop through the original worker, which holds the process handle. Never kill a recorded PID. */
export async function stopIndependentRuntimeSession(session: IndependentRuntimeSession): Promise<void> {
  if (!sameSession(await readSession(session.sessionRoot), session)) throw new Error('独立整合包会话身份不匹配。')
  await writeFile(path.join(session.sessionRoot, FILE.stop), 'stop', { mode: 0o600 })
  await waitForStop(session.sessionRoot, session.sessionId, STOP_TIMEOUT_MS)
}

function spawnThroughRunAs(node: string, worker: string, root: string): ChildProcess {
  const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'"
  const encode = (command: string) => Buffer.from(command, 'utf16le').toString('base64')
  const inner = encode('$ErrorActionPreference="Stop"; Remove-Item Env:NODE_OPTIONS,Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue; & ' + quote(node) + ' ' + quote(worker) + ' ' + quote(root) + '; exit $LASTEXITCODE')
  const outer = '$ErrorActionPreference="Stop"; $p = Start-Process powershell.exe -ArgumentList @("-NoProfile","-NonInteractive","-WindowStyle","Hidden","-EncodedCommand",' + quote(inner) + ') -WorkingDirectory ' + quote(root) + ' -WindowStyle Hidden -Verb RunAs -Wait -PassThru; exit $p.ExitCode'
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(outer)], {
    cwd: root, windowsHide: true, stdio: 'ignore',
  })
}

export async function spawnIndependentRuntime(executable: string, args: string[], options: LaunchOptions): Promise<ChildProcess> {
  if (options.runAs && process.platform !== 'win32') throw new Error('Administrator launch is only supported on Windows')
  if (!path.isAbsolute(options.nodeExecutable) || (process.versions.electron && path.resolve(options.nodeExecutable) === path.resolve(process.execPath))) {
    throw new Error('独立整合包需要启动器安装目录之外的 Node.js 可执行文件。')
  }
  const base = path.resolve(options.root)
  await mkdir(base, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(path.join(base, 'runtime-'))
  const worker = path.join(root, 'worker.mjs')
  const config = path.join(root, FILE.config)
  const env = withExecutableDirectoryOnPath(executable, options.env)
  const batch = process.platform === 'win32' && /.(?:cmd|bat)$/i.test(executable)
  try {
    await Promise.all([
      writeFile(worker, WORKER, { mode: 0o600 }),
      writeFile(path.join(root, FILE.stdout), '', { mode: 0o600 }),
      writeFile(path.join(root, FILE.stderr), '', { mode: 0o600 }),
    ])
    await writeFile(config, JSON.stringify({
      ownerPid: process.pid, sessionId: randomUUID(), deadline: Date.now() + options.readyTimeoutMs,
      cwd: options.cwd, env, elevated: options.elevated,
      command: batch ? env.ComSpec || process.env.ComSpec || 'cmd.exe' : executable,
      args: batch ? ['/d', '/s', '/v:off', '/c', buildWindowsBatchCommand(executable, args)] : args,
      windowsVerbatimArguments: batch,
    }), { mode: 0o600 })
    const child = options.runAs ? spawnThroughRunAs(options.nodeExecutable, worker, root) : spawn(options.nodeExecutable, [worker, root], {
      cwd: root, detached: true, windowsHide: true, stdio: 'ignore',
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NODE_OPTIONS|ELECTRON_RUN_AS_NODE)$/i.test(key))),
    })
    const local: LocalSession = { root, elevated: Boolean(options.runAs), completed: false, exitCode: null }
    sessions.set(child, local)
    child.once('error', error => { local.spawnError = error })
    child.once('close', code => {
      local.completed = true
      local.exitCode = code
      void rm(config, { force: true }).catch(() => undefined)
    })
    child.unref()
    return child
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function acceptIndependentRuntime(child: ChildProcess): Promise<IndependentRuntimeSession | null> {
  const local = sessions.get(child)
  if (!local) return null
  const session = await readSession(local.root)
  if (!session || local.completed || await exists(session.stopFile) || await exists(path.join(local.root, FILE.finished))) return null
  await writeFile(path.join(local.root, FILE.accepted), '', { mode: 0o600 })
  return session
}

export async function liveIndependentRuntime(child: ChildProcess): Promise<IndependentRuntimeSession | null> {
  const local = sessions.get(child)
  return local ? readIndependentRuntimeSession(local.root) : null
}

export async function stopIndependentRuntime(child: ChildProcess): Promise<boolean> {
  const local = sessions.get(child)
  if (!local) return false
  if (local.completed && !await readSession(local.root)) return true
  await writeFile(path.join(local.root, FILE.stop), 'stop', { mode: 0o600 })
  const session = await readSession(local.root)
  if (session) await waitForStop(local.root, session.sessionId, STOP_TIMEOUT_MS)
  else {
    // A delayed RunAs approval will see the stop marker even if the outer process is gone.
    await rm(path.join(local.root, FILE.config), { force: true })
    if (local.elevated && !local.completed) child.kill()
    const deadline = Date.now() + 3000
    while (!local.completed && Date.now() < deadline) await delay(POLL_MS)
    const late = await readSession(local.root)
    if (late) await waitForStop(local.root, late.sessionId, STOP_TIMEOUT_MS)
    else if (!local.completed) throw new Error('取消独立整合包启动失败。')
  }
  return true
}

export function observeIndependentRuntime(
  child: ChildProcess,
  onOutput: (level: 'info' | 'error', text: string) => void,
  onExit: (code: number | null, error?: Error) => void,
): boolean {
  const local = sessions.get(child)
  if (!local) return false
  const logs = [{ file: FILE.stdout, level: 'info' as const }, { file: FILE.stderr, level: 'error' as const }]
    .map(log => ({ ...log, offset: 0, decoder: new StringDecoder('utf8') }))
  let reading = false
  const flush = async () => {
    if (reading) return
    reading = true
    const finished = local.completed
    try {
      for (const log of logs) {
        const handle = await open(path.join(local.root, log.file), 'r')
        try {
          const buffer = Buffer.alloc(64 * 1024)
          do {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, log.offset)
            if (!bytesRead) break
            log.offset += bytesRead
            const text = log.decoder.write(buffer.subarray(0, bytesRead))
            if (text) onOutput(log.level, text)
          } while (finished)
          if (finished) {
            const rest = log.decoder.end()
            if (rest) onOutput(log.level, rest)
          }
        } finally { await handle.close() }
      }
    } catch (error) {
      onOutput('error', error instanceof Error ? error.message : String(error))
    } finally {
      reading = false
      if (finished) {
        clearInterval(timer)
        onExit(local.exitCode, local.spawnError)
      }
    }
  }
  const timer = setInterval(() => { void flush() }, POLL_MS)
  timer.unref()
  return true
}
