import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const fake = vi.hoisted(() => ({ execute: vi.fn(), runtimeUrl: vi.fn() }))

// 只换掉 createPackControl：真正的 launcher-control 逻辑（含「等 URL 再投递」）保持原样。
vi.mock('../electron/pack-control', async importOriginal => ({
  ...(await importOriginal<typeof import('../electron/pack-control')>()),
  createPackControl: () => ({
    execute: fake.execute,
    runtimeUrl: fake.runtimeUrl,
    autoStart: async () => undefined,
    shutdown: async () => undefined,
    isRunning: () => false,
    isPackRunning: () => false,
    assertPackRemovable: async () => undefined,
    forgetPack: async () => undefined,
    hasRunningHome: () => false,
  }),
}))

import { createLauncherControl } from '../electron/launcher-control'
import type { AppSettings } from '../src/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))) })

async function build(deliver: (packId: string, url: string) => Promise<unknown>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'restart-delivery-')); roots.push(root)
  const settings: AppSettings = { dshHome: path.join(root, 'dsh'), dshInstallPath: root, profileName: 'web', launchExecutable: 'dsh', launchArgs: ['web'], webPort: 45321, workspace: root, openAfterLaunch: false }
  const save = vi.fn(async (input: AppSettings) => input)
  return createLauncherControl({
    userData: root,
    cliPath: path.join(root, 'cli.cjs'),
    settings: { readStored: async () => settings, read: async () => settings, save },
    packManager: {} as never,
    prepareNodeRuntime: vi.fn(),
    preparePnpmRuntime: vi.fn(),
    openExternal: vi.fn(),
    fallbackWorkspace: () => root,
    fetchImpl: fetch,
    emitOutput: () => undefined,
    loginRegistration: vi.fn(),
    storage: { get: () => ({ dataDir: root, source: 'install' as const, portableDir: root, pointerFile: null, legacy: { dataDir: root, hasData: false }, restartRequired: false, warning: null }), set: vi.fn(), reset: vi.fn() },
    legacyRuntimeRunning: () => false,
    pendingResumeQueue: { deliver, enqueue: vi.fn(), list: async () => [], retry: async () => [], discard: async () => [] } as never,
  })
}

describe('pack.restart 之后的续接投递', () => {
  it('不带 --resume 的重启也会等运行时出 URL，再投递积压的续接请求', async () => {
    let url: string | null = null
    fake.runtimeUrl.mockImplementation(() => url)
    fake.execute.mockResolvedValue({ accepted: true, restarting: true })
    const deliver = vi.fn(async () => [])
    const control = await build(deliver)
    await expect(control.execute({ command: 'pack.restart', packId: 'a' })).resolves.toMatchObject({ accepted: true, restarting: true })
    // 还没有 URL 就先别投：投到启动前的旧地址只会失败，队列里那条还会被标成已发过。
    await new Promise(resolve => setTimeout(resolve, 700))
    expect(deliver).not.toHaveBeenCalled()
    url = 'http://127.0.0.1:45321'
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith('a', 'http://127.0.0.1:45321'), { timeout: 5_000 })
    // 只投一次：带 --resume 的分支已经投过时，兜底分支不能重复投递。
    expect(deliver).toHaveBeenCalledTimes(1)
  }, 15_000)
})
