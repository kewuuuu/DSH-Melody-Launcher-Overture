import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings } from '../src/types'
import { createLauncherControl } from '../electron/launcher-control'
import { LOGIN_ITEM_ARGS, launchAtLoginEnabled, loginItemSettings, syncLaunchAtLogin } from '../electron/login-item'
import { writePackRegistry, type PackRecord } from '../electron/pack-registry'
import { defaultSettings, mergeStoredSettings, validateSettings } from '../electron/settings'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'launch-at-login-test-'))
  roots.push(root)
  return root
}

async function launcherFixture() {
  const root = await temporary()
  const home = path.join(root, 'home-a')
  await mkdir(home, { recursive: true })
  const records: PackRecord[] = [{ id: 'a', name: 'a', description: '', version: '1', homePath: home, source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] }]
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
  const loginRegistration = vi.fn()
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
    loginRegistration,
    storage: {} as never,
    legacyRuntimeRunning: () => false,
  })
  return { root, control, settings, loginRegistration }
}

describe('login item settings', () => {
  it('registers the portable executable with background args', () => {
    expect(loginItemSettings(true, { executablePath: 'C:\\app\\electron.exe', portableExecutablePath: 'C:\\app\\DSH.exe' })).toEqual({
      openAtLogin: true,
      path: 'C:\\app\\DSH.exe',
      args: [...LOGIN_ITEM_ARGS],
    })
    expect(loginItemSettings(false, { executablePath: 'C:\\app\\electron.exe' })).toEqual({ openAtLogin: false, path: 'C:\\app\\electron.exe', args: ['--background'] })
    expect(loginItemSettings(true, { executablePath: '/opt/app/electron' }).args).toEqual(['--background'])
  })

  it('treats a missing launchAtLogin as off', () => {
    expect(launchAtLoginEnabled({})).toBe(false)
    expect(launchAtLoginEnabled(null)).toBe(false)
    expect(launchAtLoginEnabled(undefined)).toBe(false)
    expect(launchAtLoginEnabled({ launchAtLogin: false })).toBe(false)
    expect(launchAtLoginEnabled({ launchAtLogin: true })).toBe(true)
  })

  it('applies false by default so a stale registration is cleared', () => {
    const apply = vi.fn()
    expect(syncLaunchAtLogin({}, apply)).toBe(false)
    expect(apply).toHaveBeenCalledWith(false)
    const applyOn = vi.fn()
    expect(syncLaunchAtLogin({ launchAtLogin: true }, applyOn)).toBe(true)
    expect(applyOn).toHaveBeenCalledWith(true)
  })
})

describe('launchAtLogin in launcher settings', () => {
  it('defaults to false and survives validation and merging', () => {
    const defaults = defaultSettings({ homeDirectory: path.join(os.tmpdir(), 'la-home'), documentsDirectory: path.join(os.tmpdir(), 'la-docs') })
    expect(defaults.launchAtLogin).toBe(false)
    expect(validateSettings(defaults).launchAtLogin).toBe(false)
    expect(validateSettings({ ...defaults, launchAtLogin: true }).launchAtLogin).toBe(true)
    expect(mergeStoredSettings(defaults, { ...defaults, launchAtLogin: true }).launchAtLogin).toBe(true)
    expect(mergeStoredSettings(defaults, { ...defaults, launchAtLogin: false }).launchAtLogin).toBe(false)
    expect(mergeStoredSettings(defaults, defaults).launchAtLogin).toBe(false)
  })

  it('applies the login item as soon as the setting is saved', async () => {
    const f = await launcherFixture()
    expect(await f.control.execute({ command: 'settings.launchAtLogin' })).toEqual({ launchAtLogin: false })
    expect(f.loginRegistration).toHaveBeenLastCalledWith(false)
    expect(await f.control.execute({ command: 'settings.launchAtLogin', args: { enabled: true } })).toEqual({ launchAtLogin: true })
    expect(f.loginRegistration).toHaveBeenLastCalledWith(true)
    expect((await f.settings.readStored()).launchAtLogin).toBe(true)
    expect(await f.control.execute({ command: 'settings.launchAtLogin', args: { enabled: false } })).toEqual({ launchAtLogin: false })
    expect(f.loginRegistration).toHaveBeenLastCalledWith(false)
    expect((await f.settings.readStored()).launchAtLogin).toBe(false)
  })

  it('rejects a non boolean launchAtLogin and unknown keys', async () => {
    const f = await launcherFixture()
    await expect(f.control.execute({ command: 'settings.launchAtLogin', args: { enabled: 'yes' } })).rejects.toThrow('launchAtLogin 必须是布尔值。')
    await expect(f.control.execute({ command: 'settings.launchAtLogin', args: { theme: 'night' } })).rejects.toThrow('Unsupported launcher setting')
  })

  it('no longer registers a login item for pack autoStart', async () => {
    const f = await launcherFixture()
    f.loginRegistration.mockClear()
    await f.control.autoStart()
    expect(f.loginRegistration).not.toHaveBeenCalled()
    await f.control.execute({ command: 'pack.config.set', packId: 'a', args: { autoStart: true } })
    expect(f.loginRegistration).not.toHaveBeenCalled()
  })
})
