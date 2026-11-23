import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acceptIndependentRuntime, readIndependentRuntimeSession, spawnIndependentRuntime,
  stopIndependentRuntime, stopIndependentRuntimeSession, type IndependentRuntimeSession,
} from '../electron/independent-runtime'

const exec = promisify(execFile)
const roots: string[] = []
const stops: Array<() => Promise<unknown>> = []

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-independent-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.allSettled(stops.splice(0).map(stop => stop()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
})

describe('independent pack runtime', () => {
  async function verifyOwnerExit(mode: 'shutdown' | 'exit') {
    const root = await fixture()
    const { stdout } = await exec(process.execPath, [
      path.resolve('node_modules/vite-node/dist/cli.mjs'), 'tests/fixtures/independent-runtime-owner.ts', root, mode,
    ], { timeout: 12_000, windowsHide: true })
    const session = JSON.parse(stdout.trim().split(/\r?\n/).at(-1)!) as IndependentRuntimeSession
    stops.push(() => stopIndependentRuntimeSession(session))
    expect(await readIndependentRuntimeSession(session.sessionRoot)).toEqual(session)
    const count = async (file: string) => (await readFile(file, 'utf8')).trim().split('\n').length
    const before = await count(session.logPaths.stdout)
    await vi.waitFor(async () => {
      expect(await count(session.logPaths.stdout)).toBeGreaterThan(before)
      expect(await count(session.logPaths.stderr)).toBeGreaterThan(before)
    })
    await expect(stopIndependentRuntimeSession({ ...session, workerPid: session.workerPid + 1 })).rejects.toThrow('身份不匹配')
    await stopIndependentRuntimeSession(session)
    expect(await readIndependentRuntimeSession(session.sessionRoot)).toBeNull()
    expect(() => process.kill(session.runtimePid, 0)).toThrow()
  }

  it.each(['shutdown', 'exit'] as const)('survives owner %s, keeps logs and accepts verified stop', mode => verifyOwnerExit(mode), 20_000)

  it('cancels a worker before acceptance and consumes the launch configuration', async () => {
    const root = await fixture()
    const child = await spawnIndependentRuntime(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: root, env: process.env, root, nodeExecutable: process.execPath, readyTimeoutMs: 3000, elevated: false,
    })
    stops.push(() => stopIndependentRuntime(child))
    expect(await stopIndependentRuntime(child)).toBe(true)
    expect(await acceptIndependentRuntime(child)).toBeNull()
    const [folder] = await readdir(root)
    await expect(readFile(path.join(root, folder, 'launch.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 10_000)

  it('does not accept a failed pack spawn', async () => {
    const root = await fixture()
    const child = await spawnIndependentRuntime(path.join(root, 'missing.exe'), [], {
      cwd: root, env: process.env, root, nodeExecutable: process.execPath, readyTimeoutMs: 3000, elevated: false,
    })
    stops.push(() => stopIndependentRuntime(child))
    const [folder] = await readdir(root)
    const sessionRoot = path.join(root, folder)
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(path.join(sessionRoot, 'finished.json'), 'utf8'))).toHaveProperty('sessionId')
    })
    expect(await acceptIndependentRuntime(child)).toBeNull()
    expect(await readIndependentRuntimeSession(sessionRoot)).toBeNull()
    expect(await readFile(path.join(sessionRoot, 'stderr.log'), 'utf8')).toContain('ENOENT')
  }, 10_000)
})
