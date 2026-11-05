import { describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/types'
import { IPC } from '../src/constants'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: () => 'C:/launcher-user-data', getAppPath: () => 'C:/launcher-app', isPackaged: false, getVersion: () => '0.0.0', getName: () => 'launcher' },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) } },
  BrowserWindow: class {},
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn() },
  clipboard: { writeText: vi.fn(), readText: () => '' },
  nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
  Menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn(() => ({})), getApplicationMenu: () => null },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }) },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
  Notification: class {},
  powerMonitor: { on: vi.fn() },
  session: { defaultSession: {} },
}))

const { registerIpcHandlers } = await import('../electron/ipc')
const { defaultSettings } = await import('../electron/settings')

function dependencies(initial: Partial<AppSettings>) {
  const notBusy = { isBusy: () => false }
  let stored: AppSettings = { ...defaultSettings({ homeDirectory: 'C:/launcher-home', documentsDirectory: 'C:/launcher-docs' }), ...initial }
  const settings = {
    read: async () => stored,
    readStored: async () => stored,
    save: async (next: AppSettings) => {
      stored = { ...next }
      return stored
    },
  }
  const loginRegistration = vi.fn()
  registerIpcHandlers({
    settings: settings as never,
    loginRegistration,
    apiLibrary: { list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn() },
    packApis: { getState: vi.fn(), setGrant: vi.fn() },
    installer: notBusy,
    packManager: notBusy,
    pluginTrial: notBusy,
    aiInstaller: notBusy,
    copilot: { isMutationBusy: () => false },
    applicationAddons: notBusy,
    dshMarket: notBusy,
    desktopPlugins: notBusy,
    recommendedWebUi: notBusy,
    runtimeVersions: notBusy,
    runtime: { isRunning: () => false },
    githubAuth: { fetch },
  } as never)
  return { settings, loginRegistration, current: () => stored }
}

describe('launcher:settings:save login item', () => {
  it('applies launchAtLogin to the login item when the renderer saves settings', async () => {
    const f = dependencies({ launchAtLogin: false })
    const save = handlers.get(IPC.settingsSave)
    expect(save).toBeTypeOf('function')
    const savedOn = (await save!(null, { ...f.current(), launchAtLogin: true })) as AppSettings
    expect(savedOn.launchAtLogin).toBe(true)
    expect(f.loginRegistration).toHaveBeenLastCalledWith(true)
    const savedOff = (await save!(null, { ...f.current(), launchAtLogin: false })) as AppSettings
    expect(savedOff.launchAtLogin).toBe(false)
    expect(f.loginRegistration).toHaveBeenLastCalledWith(false)
  })

  it('registers the api library and per-pack grant channels', async () => {
    dependencies({ launchAtLogin: false })
    expect([...handlers.keys()]).toEqual(expect.arrayContaining([IPC.apiLibraryList, IPC.apiLibrarySave, IPC.apiLibraryRemove, IPC.packApisGet, IPC.packApisSet]))
  })
})
