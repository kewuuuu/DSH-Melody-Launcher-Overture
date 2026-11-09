import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/types'
import { createPackManager } from '../electron/pack'
import { readPackRegistry, upsertPackRecord, type PackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

/**
 * 原地换 DSH 版本（pack.upgrade / upgradePackDshVersion）的守卫：
 * 只能升不能降、运行中拒绝、同版本不写盘、成功时记录与 profile.yaml 一起改。
 */

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }).catch(() => undefined)))
})

async function makeEnv() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-pack-upgrade-'))
  roots.push(root)
  const dshHome = path.join(root, 'dsh-home')
  await mkdir(path.join(dshHome, 'profiles'), { recursive: true })
  return {
    root,
    dshHome,
    packsRoot: path.join(root, 'dsh-packs'),
    registryPath: path.join(root, 'packs.json'),
    pluginReceiptsPath: path.join(root, 'plugin-installs.json'),
    presetReceiptsPath: path.join(root, 'preset-installs.json'),
    skillReceiptsPath: path.join(root, 'skill-installs.json'),
    snapshotRoot: path.join(root, 'pack-snapshots'),
  }
}

function makeStore(dshHome: string) {
  let current: AppSettings = {
    ...defaultSettings({ homeDirectory: os.homedir(), documentsDirectory: os.homedir() }),
    dshHome,
    profileName: 'pack-x',
    activePackId: 'pack-x',
  }
  return {
    readSettings: async () => current,
    saveSettings: async (next: AppSettings) => { current = next; return current },
    get current() { return current },
  }
}

async function setup(options: { running?: boolean; dshVersion?: string | null } = {}) {
  const env = await makeEnv()
  const store = makeStore(env.dshHome)
  const ensureDshVersionInstalled = vi.fn(async (_version: string) => {})
  const installer = {
    readProfile: vi.fn(async () => ({ initialized: true, profileDir: '', manifestPath: '', plugins: [], activeBundles: [], dependencyCount: 0, disabledCount: 0 })),
    installPluginTarget: vi.fn(async () => {}), installNpmPackage: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    togglePlugin: vi.fn(async () => ({})), reorderPlugins: vi.fn(async () => []),
    installSkill: vi.fn(async () => ({})), installSkillPinned: vi.fn(async () => ({})), installPreset: vi.fn(async () => ({})),
    installPresetLocal: vi.fn(async () => {}), installSkillLocal: vi.fn(async () => {}),
    toggleSkill: vi.fn(async () => []), togglePreset: vi.fn(async () => []),
  }
  const manager = createPackManager({
    readSettings: store.readSettings,
    saveSettings: store.saveSettings,
    registryPath: env.registryPath,
    snapshotRoot: env.snapshotRoot,
    pluginReceiptsPath: env.pluginReceiptsPath,
    presetReceiptsPath: env.presetReceiptsPath,
    skillReceiptsPath: env.skillReceiptsPath,
    applicationAddons: { list: async () => [], install: async () => ({}), uninstall: async () => [] },
    installer: installer as never,
    emitEvent: () => {},
    emitOutput: () => {},
    isRuntimeRunning: () => false,
    isInstallerBusy: () => false,
    isPackRunning: () => options.running === true,
    ensureDshVersionInstalled,
    unifiedProfiles: true,
    packsRoot: env.packsRoot,
    readStoredSettings: store.readSettings,
  })
  const homePath = path.join(env.packsRoot, 'pack-x')
  const profilePath = path.join(homePath, 'profiles', 'pack-x', 'profile.yaml')
  await mkdir(path.dirname(profilePath), { recursive: true })
  await writeFile(profilePath, 'dshVersion: 1.0.0\nname: pack-x\n', 'utf8')
  const version = options.dshVersion === undefined ? '1.0.0' : options.dshVersion
  const record: PackRecord = {
    id: 'pack-x', name: 'pack-x', description: '', version: '1.0.0',
    ...(version ? { dshVersion: version } : {}),
    homePath, source: 'created',
    installedAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    state: 'complete', plugins: [],
  }
  await upsertPackRecord(env.registryPath, record)
  return { env, store, manager, ensureDshVersionInstalled, profilePath }
}

describe('upgradePackDshVersion', () => {
  it('目标版本比当前旧：按降级拒绝，记录与 profile.yaml 都不动', async () => {
    const { env, manager, ensureDshVersionInstalled, profilePath } = await setup({ dshVersion: '1.1.0' })
    await expect(manager.upgradePackDshVersion('pack-x', '1.0.0')).rejects.toThrow('更旧')
    expect(ensureDshVersionInstalled).not.toHaveBeenCalled()
    expect((await readPackRegistry(env.registryPath))[0].dshVersion).toBe('1.1.0')
    expect(await readFile(profilePath, 'utf8')).toContain('dshVersion: 1.0.0')
  })

  it('整合包运行中：拒绝切换并提示先停止', async () => {
    const { env, manager, ensureDshVersionInstalled } = await setup({ running: true })
    await expect(manager.upgradePackDshVersion('pack-x', '1.1.0')).rejects.toThrow('请先停止')
    expect(ensureDshVersionInstalled).not.toHaveBeenCalled()
    expect((await readPackRegistry(env.registryPath))[0].dshVersion).toBe('1.0.0')
  })

  it('与当前版本相同：直接返回当前状态，不写盘也不装版本', async () => {
    const { env, manager, ensureDshVersionInstalled } = await setup()
    const status = await manager.upgradePackDshVersion('pack-x', 'v1.0.0')
    expect(status.dshVersion).toBe('1.0.0')
    expect(ensureDshVersionInstalled).not.toHaveBeenCalled()
    expect((await readPackRegistry(env.registryPath))[0].updatedAt).toBe('2026-09-09T00:00:00.000Z')
  })

  it('版本非法：中文报错且不落到记录上', async () => {
    const { env, manager } = await setup()
    await expect(manager.upgradePackDshVersion('pack-x', 'latest')).rejects.toThrow('DSH 版本无效：latest')
    expect((await readPackRegistry(env.registryPath))[0].dshVersion).toBe('1.0.0')
  })

  it('升级成功：记录与 profile.yaml 一起改，目标版本恰好装一次', async () => {
    const { env, manager, ensureDshVersionInstalled, profilePath } = await setup()
    const status = await manager.upgradePackDshVersion('pack-x', '1.1.0')
    expect(status.dshVersion).toBe('1.1.0')
    expect(ensureDshVersionInstalled).toHaveBeenCalledTimes(1)
    expect(ensureDshVersionInstalled).toHaveBeenCalledWith('1.1.0')
    const registry = await readPackRegistry(env.registryPath)
    expect(registry[0].dshVersion).toBe('1.1.0')
    expect(registry[0].updatedAt).not.toBe('2026-09-09T00:00:00.000Z')
    expect(await readFile(profilePath, 'utf8')).toContain('dshVersion: 1.1.0')
  })
})
