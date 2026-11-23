import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolvePackExitChoice } from '../electron/pack-exit-policy'
import { createSettingsStore, defaultSettings, validateSettings } from '../electron/settings'
import type { AppSettings } from '../src/types'

vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}))

const filePath = '/fake-launcher/settings.json'
const createDefaults = () => defaultSettings({ homeDirectory: '/fake-home', documentsDirectory: '/fake-documents' })
const createStore = () => createSettingsStore({
  filePath,
  createDefaults,
  detectInstalledDsh: async () => ({ installed: false, version: null, executable: null, source: null }),
})

beforeEach(() => vi.resetAllMocks())

describe('pack exit setting', () => {
  it.each([undefined, 'keep', 1, null])('normalizes a missing or invalid policy (%s)', async value => {
    const packExitPolicy = value as AppSettings['packExitPolicy']
    const defaults = createDefaults()
    expect(defaults.packExitPolicy).toBe('ask')
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ ...defaults, packExitPolicy }))
    expect((await createStore().readStored()).packExitPolicy).toBe('ask')
    expect(validateSettings({ ...defaults, packExitPolicy }).packExitPolicy).toBe('ask')
  })

  it('persists stop and loads it in a fresh store', async () => {
    const saved = await createStore().save({ ...createDefaults(), packExitPolicy: 'stop' })
    expect(saved.packExitPolicy).toBe('stop')
    expect(mkdir).toHaveBeenCalledOnce()
    const [writtenPath, json, encoding] = vi.mocked(writeFile).mock.calls[0]
    expect(writtenPath).toBe(filePath)
    expect(encoding).toBe('utf8')
    expect(JSON.parse(String(json))).toMatchObject({ packExitPolicy: 'stop' })
    vi.mocked(readFile).mockResolvedValue(String(json))
    expect((await createStore().read()).packExitPolicy).toBe('stop')
  })
})

describe('resolvePackExitChoice', () => {
  it.each([undefined, 'ask', 'stop'] as const)('skips the dialog without active packs (%s)', async policy => {
    const prompt = vi.fn()
    expect(await resolvePackExitChoice(policy, false, prompt)).toBe('keep')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('stops active packs without prompting under the stop policy', async () => {
    const prompt = vi.fn()
    expect(await resolvePackExitChoice('stop', true, prompt)).toBe('stop')
    expect(prompt).not.toHaveBeenCalled()
  })

  it.each([[0, 'stop'], [1, 'keep'], [2, 'cancel'], [-1, 'cancel']] as const)(
    'maps dialog response %s to %s and defaults to cancellation',
    async (response, choice) => {
      const prompt = vi.fn().mockResolvedValue({ response })
      expect(await resolvePackExitChoice('ask', true, prompt)).toBe(choice)
      expect(prompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        buttons: ['停止整合包并退出', '保持整合包运行并退出', '取消退出'],
        defaultId: 2,
        cancelId: 2,
      }))
    },
  )

  it('asks when the policy is absent', async () => {
    const prompt = vi.fn().mockResolvedValue({ response: 2 })
    expect(await resolvePackExitChoice(undefined, true, prompt)).toBe('cancel')
    expect(prompt).toHaveBeenCalledOnce()
  })
})
