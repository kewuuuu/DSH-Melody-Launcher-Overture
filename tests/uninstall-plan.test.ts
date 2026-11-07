import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  createUninstallPlan,
  summarize,
  UNINSTALL_LOGIN_ITEM_NAME,
  UNINSTALL_LOGIN_RUN_KEY,
} from '../electron/uninstall-plan'
import type { UninstallItem, UninstallPlan } from '../src/types'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uninstall-plan-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const installDir = path.join(root, 'app')
  const legacyDataDir = path.join(root, 'appdata', 'dsh-launcher')
  const dshHome = path.join(root, 'home', '.dsh')
  const tempDir = path.join(root, 'temp')
  await mkdir(installDir, { recursive: true })
  await mkdir(legacyDataDir, { recursive: true })
  await mkdir(dshHome, { recursive: true })
  await mkdir(tempDir, { recursive: true })
  const executablePath = path.join(installDir, 'DSH Launcher.exe')
  await writeFile(executablePath, 'exe')
  const dataDir = path.join(installDir, 'launcher-data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'settings.json'), '{}')
  await writeFile(path.join(legacyDataDir, 'legacy.bin'), 'old')
  await writeFile(path.join(dshHome, 'config.json'), '{}')
  return { root, installDir, legacyDataDir, dshHome, tempDir, executablePath, dataDir }
}

type Layout = Awaited<ReturnType<typeof sandbox>>
const planFor = (layout: Layout, overrides: Record<string, unknown> = {}) =>
  createUninstallPlan({
    executablePath: layout.executablePath,
    installDir: layout.installDir,
    dataDir: layout.dataDir,
    legacyDataDir: layout.legacyDataDir,
    dshHome: layout.dshHome,
    tempDir: layout.tempDir,
    ...overrides,
  })
const byId = (plan: UninstallPlan, id: string): UninstallItem | undefined =>
  plan.items.find(item => item.id === id)

describe('uninstall plan', () => {
  it('默认计划只删本版创建的东西，旧版数据与 DSH 家目录列为保留', async () => {
    const layout = await sandbox()
    const plan = planFor(layout)

    expect(plan.executablePath).toBe(layout.executablePath)
    expect(plan.dataDir).toBe(layout.dataDir)
    expect(plan.items.map(item => item.id)).toEqual([
      'exe',
      'data',
      'legacy-data',
      'dsh-home',
      'install-dir',
      'registry-run',
    ])

    expect(byId(plan, 'exe')).toMatchObject({ action: 'delete', kind: 'file', path: layout.executablePath })
    expect(byId(plan, 'data')).toMatchObject({ action: 'delete', kind: 'directory', path: layout.dataDir })
    expect(byId(plan, 'legacy-data')).toMatchObject({ action: 'keep', path: layout.legacyDataDir })
    expect(byId(plan, 'legacy-data')?.reason).toContain('旧版启动器数据')
    expect(byId(plan, 'dsh-home')).toMatchObject({ action: 'keep', path: layout.dshHome })
    expect(byId(plan, 'dsh-home')?.reason).toContain('DSH 的家目录')
    expect(byId(plan, 'install-dir')).toMatchObject({ action: 'delete', path: layout.installDir, sizeBytes: 0 })
    expect(byId(plan, 'registry-run')).toMatchObject({
      action: 'delete',
      kind: 'registry',
      sizeBytes: 0,
      path: UNINSTALL_LOGIN_RUN_KEY + '\\' + UNINSTALL_LOGIN_ITEM_NAME,
    })

    expect(plan.warnings).toEqual([])
    expect(plan.deleteBytes).toBeGreaterThan(0)
    expect(plan.keepBytes).toBeGreaterThan(0)
    for (const item of plan.items) if (item.action === 'keep') expect(item.reason).toBeTruthy()
  })

  it('本版数据目录就是旧版数据目录时，数据一律保留、只删程序', async () => {
    const layout = await sandbox()
    const plan = planFor(layout, { dataDir: layout.legacyDataDir })

    expect(byId(plan, 'data')).toMatchObject({ action: 'keep', path: layout.legacyDataDir })
    expect(byId(plan, 'data')?.reason).toContain('这是旧版启动器数据，按规则保留')
    expect(byId(plan, 'legacy-data')).toBeUndefined()
    expect(plan.items.some(item => item.action === 'delete' && item.path === layout.legacyDataDir)).toBe(false)
    expect(plan.warnings.join()).toContain('同一个目录')
    expect(byId(plan, 'exe')?.action).toBe('delete')
  })

  it('安装目录里混了别人的文件时只删 EXE，目录整条保留并写警告', async () => {
    const layout = await sandbox()
    await writeFile(path.join(layout.installDir, 'notes.txt'), 'mine')
    const plan = planFor(layout)

    expect(byId(plan, 'install-dir')).toBeUndefined()
    expect(byId(plan, 'exe')?.action).toBe('delete')
    const kept = plan.items.find(item => item.path === path.join(layout.installDir, 'notes.txt'))
    expect(kept).toMatchObject({ action: 'keep' })
    expect(kept?.reason).toContain('按规则保留')
    expect(plan.warnings.join()).toContain('安装目录里还有不属于本版启动器的内容')
  })

  it('指针文件存在才进删除列表', async () => {
    const layout = await sandbox()
    const pointerFile = path.join(layout.installDir, 'launcher-storage.json')
    await writeFile(pointerFile, JSON.stringify({ dataDir: 'D:/elsewhere' }))

    expect(byId(planFor(layout), 'pointer')).toMatchObject({ action: 'delete', path: pointerFile })
    await rm(pointerFile)
    expect(byId(planFor(layout), 'pointer')).toBeUndefined()
  })

  it('%TEMP% 下只列 3L* 自解压残留，并提醒可能删不掉', async () => {
    const layout = await sandbox()
    await mkdir(path.join(layout.tempDir, '3Labc123'))
    await writeFile(path.join(layout.tempDir, '3Labc123', 'payload.bin'), 'x')
    await mkdir(path.join(layout.tempDir, '3Ldef456'))
    await mkdir(path.join(layout.tempDir, 'unrelated'))

    const plan = planFor(layout)
    expect(byId(plan, 'temp-residue-3labc123')).toMatchObject({ action: 'delete', kind: 'directory' })
    expect(byId(plan, 'temp-residue-3ldef456')).toMatchObject({ action: 'delete' })
    expect(byId(plan, 'temp-residue-unrelated')).toBeUndefined()
    expect(plan.warnings.join()).toContain('自解压残留可能正被占用')
  })

  it('EXE 不在预期位置时给警告，但计划照旧继续', async () => {
    const layout = await sandbox()
    await rm(layout.executablePath)
    const plan = planFor(layout)

    expect(byId(plan, 'exe')).toMatchObject({ action: 'delete', path: layout.executablePath })
    expect(plan.warnings.join()).toContain('启动器主程序不在预期位置')
    expect(byId(plan, 'data')?.action).toBe('delete')
  })

  it('选择保留数据时数据列 keep、安装目录也不整体删', async () => {
    const layout = await sandbox()
    const plan = planFor(layout, { deleteData: false })

    expect(byId(plan, 'data')).toMatchObject({ action: 'keep', path: layout.dataDir })
    expect(byId(plan, 'data')?.reason).toContain('保留数据')
    expect(byId(plan, 'install-dir')).toBeUndefined()
    expect(plan.warnings.join()).toContain('留着要保留的本版数据')
  })

  it('summarize 按 action 汇总，registry 项天然记 0', () => {
    const totals = summarize({
      items: [
        { id: 'a', label: 'a', path: '/a', kind: 'file', sizeBytes: 100, fileCount: 1, action: 'delete' },
        { id: 'b', label: 'b', path: '/b', kind: 'directory', sizeBytes: 900, fileCount: 2, action: 'keep', reason: 'keep' },
        { id: 'c', label: 'c', path: 'HKCU\\x', kind: 'registry', sizeBytes: 0, fileCount: 0, action: 'delete' },
      ],
    })
    expect(totals).toEqual({ deleteBytes: 100, keepBytes: 900 })
    expect(summarize({ items: [] })).toEqual({ deleteBytes: 0, keepBytes: 0 })
    expect(summarize({})).toEqual({ deleteBytes: 0, keepBytes: 0 })
  })
})
