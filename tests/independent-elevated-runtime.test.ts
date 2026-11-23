import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acceptIndependentRuntime, readIndependentRuntimeSession, spawnIndependentRuntime,
  stopIndependentRuntime, stopIndependentRuntimeSession, type IndependentRuntimeSession,
} from '../electron/independent-runtime'

const bridge = vi.hoisted(() => ({ outer: '', inner: '', pending: false }))
vi.mock('node:child_process', async importActual => {
  const actual = await importActual<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn(command: string, args: string[], options: Parameters<typeof spawn>[2]) {
      if (command !== 'powershell.exe') return actual.spawn(command, args, options)
      bridge.outer = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
      const match = bridge.outer.match(/"-EncodedCommand",'([^']+)'/)
      if (!match) throw new Error('Missing elevated command')
      bridge.inner = match[1]
      // Run the actual elevated command as the test user. Only the UAC boundary is replaced.
      return bridge.pending
        ? actual.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options)
        : actual.spawn(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', bridge.inner], options)
    },
  }
})

let root = ''
let session: IndependentRuntimeSession | null = null
let child: Awaited<ReturnType<typeof spawnIndependentRuntime>> | null = null
async function start() {
  root = await mkdtemp(path.join(os.tmpdir(), 'dsh independent admin-'))
  return spawnIndependentRuntime(process.execPath, ['-e', 'setInterval(() => console.log("admin output"), 30)'], {
    cwd: root, env: process.env, root, nodeExecutable: process.execPath,
    readyTimeoutMs: 5000, elevated: true, runAs: true,
  })
}

afterEach(async () => {
  if (session) await stopIndependentRuntimeSession(session).catch(() => undefined)
  if (child) await stopIndependentRuntime(child).catch(() => undefined)
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  root = ''
  session = null
  child = null
  bridge.pending = false
})

describe.skipIf(process.platform !== 'win32')('independent RunAs bridge', () => {
  it('launches the generated worker and acknowledges stop with the Windows transport', async () => {
    child = await start()
    expect(bridge.outer).toContain('-Verb RunAs -Wait -PassThru')
    await vi.waitFor(async () => {
      session = await acceptIndependentRuntime(child!)
      expect(session).toMatchObject({ elevated: true })
    }, { timeout: 5_000 })
    expect(session!.workerPid).not.toBe(child.pid)
    await vi.waitFor(async () => {
      expect(await readFile(session!.logPaths.stdout, 'utf8')).toContain('admin output')
    })
    expect(await readIndependentRuntimeSession(session!.sessionRoot)).toEqual(session)
    await stopIndependentRuntimeSession(session!)
    expect(() => process.kill(session!.runtimePid, 0)).toThrow()
  }, 10_000)

  it('blocks a worker started after the authorization transport was canceled', async () => {
    bridge.pending = true
    child = await start()
    const [folder] = await readdir(root)
    const sessionRoot = path.join(root, folder)
    expect(await stopIndependentRuntime(child)).toBe(true)
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    const late = actual.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', bridge.inner], {
      windowsHide: true, stdio: 'ignore',
    })
    await new Promise<void>((resolve, reject) => {
      late.once('error', reject)
      late.once('close', code => code === 0 ? resolve() : reject(new Error('Late worker exited with ' + code)))
    })
    expect(await readIndependentRuntimeSession(sessionRoot)).toBeNull()
    await expect(readFile(path.join(sessionRoot, 'ready.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)
})
