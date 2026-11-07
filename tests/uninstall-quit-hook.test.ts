import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings } from '../src/types'
import { createLauncherControl } from '../electron/launcher-control'
import { writePackRegistry, type PackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uninstall-quit-hook-'))
  roots.push(root)
  const home = path.join(root, 'home-a')
  await mkdir(home, { recursive: true })
  const records: PackRecord[] = [
    { id: 'a', name: 'a', description: '', version: '1', homePath: home, source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] },
  ]
  await writePackRegistry(path.join(root, 'packs.json'), records)
  let stored: AppSettings = { ...defaultSettings({ homeDirectory: path.join(root, 'user'), documentsDirectory: path.join(root, 'docs') }), dshHome: home }
  const settings = {
    read: async () => stored,
    readStored: async () => stored,
    save: async (next: AppSettings) => {
      stored = { ...next }
      return stored
    },
  }
  const onUninstallStarted = vi.fn()
  const runCalls: unknown[] = []
  const uninstall = {
    plan: async () => ({ items: [], warnings: [] }),
    exportScript: async () => ({}),
    run: async (options: unknown) => {
      runCalls.push(options)
      return { started: true }
    },
  }
  const control = createLauncherControl({
    userData: root,
    cliPath: path.join(root, 'cli.cjs'),
    settings: settings as never,
    packManager: {} as never,
    prepareNodeRuntime: vi.fn(),
    preparePnpmRuntime: vi.fn(),
    openExternal: vi.fn(),
    fallbackWorkspace: () => root,
    fetchImpl: fetch,
    emitOutput: () => undefined,
    loginRegistration: vi.fn(),
    storage: {} as never,
    legacyRuntimeRunning: () => false,
    uninstall: uninstall as never,
    onUninstallStarted,
  })
  return { control, onUninstallStarted, runCalls }
}

describe('uninstall quit hook', () => {
  it('CLI 卸载成功后通知父级退出，否则 helper 会白等 120 秒', async () => {
    const f = await fixture()
    const result = await f.control.execute({ command: 'uninstall.run', args: { confirm: true } })
    expect(result).toEqual({ started: true })
    expect(f.runCalls).toEqual([{ deleteData: false }])
    expect(f.onUninstallStarted).toHaveBeenCalledTimes(1)
  })

  it('缺 --yes 时直接拒绝，不启动 helper 也不通知退出', async () => {
    const f = await fixture()
    await expect(f.control.execute({ command: 'uninstall.run', args: {} })).rejects.toThrow('--yes')
    expect(f.runCalls).toEqual([])
    expect(f.onUninstallStarted).not.toHaveBeenCalled()
  })

  it('只查计划或导出脚本不会让启动器退出', async () => {
    const f = await fixture()
    await f.control.execute({ command: 'uninstall.plan' })
    expect(f.onUninstallStarted).not.toHaveBeenCalled()
  })
})
