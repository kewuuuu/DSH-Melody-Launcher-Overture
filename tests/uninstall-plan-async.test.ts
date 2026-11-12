import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createUninstallService } from '../electron/uninstall'
import { createUninstallPlan, createUninstallPlanAsync, type UninstallPlanInput } from '../electron/uninstall-plan'
import { STORAGE_POINTER_FILENAME } from '../electron/storage-root'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function sandbox() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uninstall-async-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const installDir = path.join(root, 'app')
  const dataDir = path.join(installDir, 'launcher-data')
  const legacyDataDir = path.join(root, 'appdata', 'dsh-launcher')
  const dshHome = path.join(root, 'home', '.dsh')
  const tempDir = path.join(root, 'temp')
  const executablePath = path.join(installDir, 'DSH Launcher.exe')
  await mkdir(installDir, { recursive: true })
  await writeFile(executablePath, 'exe-bytes')
  await writeFile(path.join(installDir, STORAGE_POINTER_FILENAME), '{"dataDir":"launcher-data"}')
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'settings.json'), '{"ui":1}')
  await mkdir(path.join(installDir, 'plugins', 'one'), { recursive: true })
  await writeFile(path.join(installDir, 'plugins', 'one', 'main.js'), 'console.log(1)')
  await mkdir(legacyDataDir, { recursive: true })
  await writeFile(path.join(legacyDataDir, 'legacy.bin'), 'old-data')
  await mkdir(path.join(dshHome, 'nested'), { recursive: true })
  await writeFile(path.join(dshHome, 'config.json'), '{}')
  await writeFile(path.join(dshHome, 'nested', 'two.json'), '[]')
  await mkdir(path.join(tempDir, '3labc12'), { recursive: true })
  await writeFile(path.join(tempDir, '3labc12', 'r.bin'), 'residue')
  await mkdir(path.join(tempDir, 'unrelated'), { recursive: true })
  await writeFile(path.join(tempDir, 'unrelated', 'x.bin'), 'keep')
  return { root, installDir, dataDir, legacyDataDir, dshHome, tempDir, executablePath }
}

type Layout = Awaited<ReturnType<typeof sandbox>>

const planInput = (layout: Layout, overrides: Partial<UninstallPlanInput> = {}): UninstallPlanInput => ({
  executablePath: layout.executablePath,
  installDir: layout.installDir,
  dataDir: layout.dataDir,
  legacyDataDir: layout.legacyDataDir,
  dshHome: layout.dshHome,
  tempDir: layout.tempDir,
  // 默认不查真进程：测试要可重复。
  processImagePaths: () => [],
  ...overrides,
})

describe('createUninstallPlanAsync', () => {
  it('与同步计划逐字段一致（安装目录里还有外来内容）', async () => {
    const layout = await sandbox()
    const input = planInput(layout)
    const syncPlan = createUninstallPlan(input)
    const asyncPlan = await createUninstallPlanAsync(input)
    expect(asyncPlan).toStrictEqual(syncPlan)
    expect(syncPlan.items.map(item => item.id)).toContain('install-dir-keep-other')
  })

  it('安装目录可整体删除时也一致（含指针与主程序的扣减）', async () => {
    const layout = await sandbox()
    const externalDataDir = path.join(layout.root, 'data')
    await mkdir(externalDataDir, { recursive: true })
    await writeFile(path.join(externalDataDir, 'settings.json'), '{}')
    await rm(path.join(layout.installDir, 'plugins'), { recursive: true, force: true })
    await rm(path.join(layout.installDir, 'launcher-data'), { recursive: true, force: true })
    const input = planInput(layout, { dataDir: externalDataDir, deleteData: true })
    const syncPlan = createUninstallPlan(input)
    const asyncPlan = await createUninstallPlanAsync(input)
    expect(asyncPlan).toStrictEqual(syncPlan)
    const installItem = syncPlan.items.find(item => item.id === 'install-dir')
    expect(installItem).toBeDefined()
    expect(installItem?.sizeBytes).toBe(0)
  })
})

describe('卸载计划缓存', () => {
  it('30 秒内重复 plan() 只统计一次，过期后重新统计', async () => {
    const layout = await sandbox()
    let clock = 1_000
    let statCalls = 0
    const input = planInput(layout, {
      // 统计注入点：只数调用次数，量本身固定。
      statTree: () => {
        statCalls += 1
        return { sizeBytes: 1, fileCount: 1 }
      },
    })
    const service = createUninstallService({ plan: input, tempDir: layout.tempDir, now: () => clock })

    const first = await service.plan()
    const afterFirst = statCalls
    expect(afterFirst).toBeGreaterThan(0)

    const second = await service.plan()
    expect(second).toBe(first)
    expect(statCalls).toBe(afterFirst)

    clock += 29_999
    await service.plan()
    expect(statCalls).toBe(afterFirst)

    clock += 1
    await service.plan()
    expect(statCalls).toBe(afterFirst * 2)
  })
})
