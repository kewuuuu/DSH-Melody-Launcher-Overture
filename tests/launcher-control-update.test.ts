import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLauncherControl } from '../electron/launcher-control'
import { createStorageController } from '../electron/storage-root'
import type { UpdateFlowService, UpdateFlowState } from '../electron/update-flow'
import { defaultSettings } from '../electron/settings'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const state = (phase: UpdateFlowState['phase'], message: string | null = null): UpdateFlowState => ({
  phase,
  waitMinutes: 10,
  localVersion: '1.3.1',
  remoteVersion: '1.3.2',
  busy: [],
  resumePacks: [],
  startedAt: null,
  message,
})

async function fixture(withFlow = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'launcher-control-update-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const pointerFile = path.join(root, 'launcher-storage.json')
  const controller = createStorageController({
    resolution: { dataDir: path.join(root, 'launcher-data'), source: 'install', portableDir: root, pointerFile, warning: null },
    appDataPath: root,
  })
  const calls: unknown[] = []
  const flow: UpdateFlowService = {
    status: () => state('idle', '空闲'),
    check: async () => { calls.push({ op: 'check' }); return { state: 'update-available', localVersion: '1.3.1', remoteVersion: '1.3.2', releaseUrl: null, assetName: null, assetSize: null, checkedAt: null, message: '' } },
    start: async options => { calls.push({ op: 'start', options }); return state('checking') },
    cancel: async () => { calls.push({ op: 'cancel' }); return state('idle', '已取消本次更新。') },
    settled: async () => undefined,
  }
  const settings = defaultSettings({ homeDirectory: root, documentsDirectory: path.join(root, 'Documents'), platform: 'win32' })
  const control = createLauncherControl({
    userData: root,
    cliPath: path.join(root, 'cli.cjs'),
    settings: { readStored: async () => settings, read: async () => settings, save: vi.fn() } as never,
    packManager: {} as never,
    prepareNodeRuntime: vi.fn(),
    preparePnpmRuntime: vi.fn(),
    openExternal: vi.fn(),
    fallbackWorkspace: () => root,
    fetchImpl: fetch,
    emitOutput: () => undefined,
    loginRegistration: vi.fn(),
    legacyRuntimeRunning: () => false,
    storage: controller,
    ...(withFlow ? { updateFlow: flow } : {}),
  })
  return { control, calls, root }
}

describe('launcher control update commands', () => {
  it('routes update.status / check / cancel to the flow service', async () => {
    const f = await fixture()
    expect(await f.control.execute({ command: 'update.status' })).toMatchObject({ phase: 'idle', message: '空闲' })
    expect(await f.control.execute({ command: 'update.check' })).toMatchObject({ state: 'update-available' })
    expect(await f.control.execute({ command: 'update.cancel' })).toMatchObject({ phase: 'idle' })
    expect(f.calls).toEqual([{ op: 'check' }, { op: 'cancel' }])
  })

  it('passes wait minutes and force through to update.apply', async () => {
    const f = await fixture()
    await f.control.execute({ command: 'update.apply', args: { waitMinutes: 3, force: true } })
    await f.control.execute({ command: 'update.apply' })
    expect(f.calls).toEqual([
      { op: 'start', options: { waitMinutes: 3, force: true } },
      { op: 'start', options: { waitMinutes: undefined, force: false } },
    ])
  })

  it('rejects a bad wait value, an unknown action and a missing flow', async () => {
    const f = await fixture()
    await expect(f.control.execute({ command: 'update.apply', args: { waitMinutes: 'soon' } })).rejects.toThrow('waitMinutes 必须是数字')
    await expect(f.control.execute({ command: 'update.restart' })).rejects.toThrow('update check|status|apply|cancel')
    const bare = await fixture(false)
    await expect(bare.control.execute({ command: 'update.check' })).rejects.toThrow('更新服务没有装配')
  })

  it('keeps the wait minutes in the launcher settings surface', async () => {
    const f = await fixture()
    expect(await f.control.execute({ command: 'settings.get' })).toMatchObject({ updateWaitMinutes: 10 })
    await expect(f.control.execute({ command: 'settings.set', args: { updateWaitMinutes: 30 } })).resolves.toBeTruthy()
  })
})
