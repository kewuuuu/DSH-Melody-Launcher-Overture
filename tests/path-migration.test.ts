import { afterEach, describe, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setDefaultBackupEngine, type BackupEngine } from '../electron/backups'
import { assertMigrationTarget, migratePath } from '../electron/path-migration'
import type { BackupEntry, PathMigrationResult } from '../src/types'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  setDefaultBackupEngine(null)
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function temporary(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'path-migration-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false)
}

function entryOf(input: { paths: string[]; label: string; op?: string }): BackupEntry {
  return {
    id: 'b1',
    op: (input.op ?? 'manual') as BackupEntry['op'],
    label: input.label,
    createdAt: 1,
    sizeBytes: 10,
    fileCount: 1,
    locked: false,
    origin: input.paths,
    archivePath: 'b1.zip',
  }
}

function stubEngine(create: (input: { paths: string[]; label: string; op?: string }) => Promise<BackupEntry>) {
  const engine = { create: vi.fn(create) } as unknown as BackupEngine
  setDefaultBackupEngine(engine)
  return engine as unknown as { create: ReturnType<typeof vi.fn> }
}

async function seedSource(root: string): Promise<string> {
  const source = path.join(root, 'old-home')
  await mkdir(path.join(source, 'nested'), { recursive: true })
  await writeFile(path.join(source, 'a.txt'), '源文件内容', 'utf8')
  await writeFile(path.join(source, 'nested', 'b.txt'), '嵌套内容', 'utf8')
  return source
}

function deps(input: {
  kind?: 'dshHome' | 'dshInstallPath'
  target: string
  current: string
  save?: (next: string) => Promise<void>
  isBusy?: boolean
  launcherDataDir?: string
}) {
  return {
    kind: input.kind ?? ('dshHome' as const),
    target: input.target,
    current: async () => input.current,
    save: input.save ?? vi.fn(async () => undefined),
    isBusy: () => input.isBusy ?? false,
    ...(input.launcherDataDir ? { launcherDataDir: input.launcherDataDir } : {}),
  }
}

describe('path migration target validation', () => {
  it('拒绝相对路径、当前目录本身、子目录和启动器数据目录，且零写入', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    const dataDir = path.join(root, 'launcher-data')
    await mkdir(dataDir, { recursive: true })
    const create = vi.fn(async (input: { paths: string[]; label: string; op?: string }) => entryOf(input))
    const save = vi.fn(async () => undefined)
    setDefaultBackupEngine({ create } as unknown as BackupEngine)

    const cases: Array<{ target: string; message: string }> = [
      { target: 'relative-home', message: '迁移目标必须是绝对路径' },
      { target: source, message: '迁移目标不能与当前目录相同' },
      { target: path.join(source, 'inside'), message: '迁移目标不能位于当前目录内部' },
      { target: dataDir, message: '迁移目标不能是启动器数据目录' },
    ]
    for (const item of cases) {
      await expect(migratePath(deps({ target: item.target, current: source, launcherDataDir: dataDir }))).rejects.toThrow(item.message)
    }
    await expect(migratePath(deps({ kind: 'workspace' as never, target: path.join(root, 'next'), current: source }))).rejects.toThrow('不支持的迁移目标')
    expect(create).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    expect(await exists(path.join(root, 'relative-home'))).toBe(false)
    expect(await exists(path.join(source, 'inside'))).toBe(false)
    expect(await readFile(path.join(source, 'a.txt'), 'utf8')).toBe('源文件内容')
  })

  it('assertMigrationTarget 校验大小写不敏感，直接调用也给出中文错误', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    expect(() => assertMigrationTarget({ kind: 'dshHome', target: path.join(root, 'next-home'), oldDir: source })).not.toThrow()
    expect(() => assertMigrationTarget({ kind: 'dshHome', target: source.toUpperCase(), oldDir: source })).toThrow('迁移目标不能与当前目录相同')
  })
})

describe('path migration success', () => {
  it('先备份旧目录再拷贝，成功后删除旧目录', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    const target = path.join(root, 'new-home')
    const create = vi.fn(async (input: { paths: string[]; label: string; op?: string }) => entryOf(input))
    setDefaultBackupEngine({ create } as unknown as BackupEngine)
    const save = vi.fn(async () => undefined)

    const result: PathMigrationResult = await migratePath(deps({ target, current: source, save }))
    expect(result.kind).toBe('dshHome')
    expect(result.current).toBe(path.resolve(target))
    expect(result.backupId).toBe('b1')
    expect(result.removedOld).toBe(true)
    expect(result.warning).toBeNull()
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0]).toMatchObject({ paths: [source], label: '迁移 dshHome', op: 'path.migrate' })
    expect(save).toHaveBeenCalledWith(path.resolve(target))
    expect(await exists(source)).toBe(false)
    expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('源文件内容')
    expect(await readFile(path.join(target, 'nested', 'b.txt'), 'utf8')).toBe('嵌套内容')
  })

  it('目标已有无关内容时合并拷贝，不覆盖既有文件', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    const target = path.join(root, 'new-home')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'z.txt'), '原有内容', 'utf8')
    stubEngine(async input => entryOf(input))

    const result = await migratePath(deps({ target, current: source }))
    expect(result.removedOld).toBe(true)
    expect(await readFile(path.join(target, 'z.txt'), 'utf8')).toBe('原有内容')
    expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('源文件内容')
    expect(await exists(source)).toBe(false)
  })

  it('有整合包在跑时保留旧目录并给出中文 warning', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    const target = path.join(root, 'new-home')
    stubEngine(async input => entryOf(input))
    const save = vi.fn(async () => undefined)

    const result = await migratePath(deps({ target, current: source, save, isBusy: true }))
    expect(result.removedOld).toBe(false)
    expect(result.warning).toContain('有整合包正在运行，旧目录暂未删除')
    expect(save).toHaveBeenCalledTimes(1)
    expect(await exists(path.join(source, 'a.txt'))).toBe(true)
    expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('源文件内容')
  })

  it('旧目录为空时不产生备份条目，直接写设置并删除空目录', async () => {
    const root = await temporary()
    const source = path.join(root, 'empty-home')
    await mkdir(source, { recursive: true })
    const target = path.join(root, 'new-home')
    const create = vi.fn(async (input: { paths: string[]; label: string; op?: string }) => entryOf(input))
    setDefaultBackupEngine({ create } as unknown as BackupEngine)

    const result = await migratePath(deps({ target, current: source }))
    expect(result.backupId).toBeNull()
    expect(result.removedOld).toBe(true)
    expect(create).not.toHaveBeenCalled()
    expect(await exists(target)).toBe(true)
    expect(await exists(source)).toBe(false)
  })
})

describe('path migration aborts', () => {
  it('同名冲突时报错且不写目标、不写设置', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    const target = path.join(root, 'new-home')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'a.txt'), '已有内容', 'utf8')
    const create = vi.fn(async (input: { paths: string[]; label: string; op?: string }) => entryOf(input))
    setDefaultBackupEngine({ create } as unknown as BackupEngine)
    const save = vi.fn(async () => undefined)

    await expect(migratePath(deps({ target, current: source, save }))).rejects.toThrow('迁移目标中已存在同名内容')
    expect(save).not.toHaveBeenCalled()
    expect(await readFile(path.join(target, 'a.txt'), 'utf8')).toBe('已有内容')
    expect(await readdir(target)).toEqual(['a.txt'])
    expect(await readFile(path.join(source, 'a.txt'), 'utf8')).toBe('源文件内容')
  })

  it('备份失败就中止，不拷贝也不删旧目录', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    const target = path.join(root, 'new-home')
    stubEngine(async () => { throw new Error('磁盘已满') })
    const save = vi.fn(async () => undefined)

    await expect(migratePath(deps({ target, current: source, save }))).rejects.toThrow('备份旧目录失败，已中止迁移：磁盘已满')
    expect(save).not.toHaveBeenCalled()
    expect(await exists(target)).toBe(false)
    expect(await exists(source)).toBe(true)
  })

  it('备份引擎未就绪且旧目录非空时中止', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    const target = path.join(root, 'new-home')
    setDefaultBackupEngine(null)
    const save = vi.fn(async () => undefined)

    await expect(migratePath(deps({ target, current: source, save }))).rejects.toThrow('备份引擎尚未就绪，已中止迁移')
    expect(save).not.toHaveBeenCalled()
    expect(await exists(target)).toBe(false)
    expect(await exists(path.join(source, 'a.txt'))).toBe(true)
  })

  it('写设置失败时清理新目录并保留旧目录', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    const target = path.join(root, 'new-home')
    stubEngine(async input => entryOf(input))
    const save = vi.fn(async () => { throw new Error('设置文件被占用') })

    await expect(migratePath(deps({ target, current: source, save }))).rejects.toThrow('写入设置失败，已放弃迁移并清理新目录：设置文件被占用')
    expect(await exists(target)).toBe(false)
    expect(await readFile(path.join(source, 'a.txt'), 'utf8')).toBe('源文件内容')
  })

  it('写设置失败且目标是既有目录时，只清理复制过去的内容', async () => {
    const root = await temporary()
    const source = await seedSource(root)
    const target = path.join(root, 'new-home')
    await mkdir(target, { recursive: true })
    await writeFile(path.join(target, 'z.txt'), '原有内容', 'utf8')
    stubEngine(async input => entryOf(input))
    const save = vi.fn(async () => { throw new Error('设置文件被占用') })

    await expect(migratePath(deps({ target, current: source, save }))).rejects.toThrow('写入设置失败')
    expect(await readdir(target)).toEqual(['z.txt'])
    expect(await readFile(path.join(target, 'z.txt'), 'utf8')).toBe('原有内容')
    expect(await readFile(path.join(source, 'a.txt'), 'utf8')).toBe('源文件内容')
  })
})
