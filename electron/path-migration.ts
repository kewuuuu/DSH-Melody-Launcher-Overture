import { cp, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { MigratablePath, PathMigrationResult } from '../src/types'
import { getDefaultBackupEngine } from './backups'
import { pathExists } from './profile'

export const MIGRATION_BACKUP_OP = 'path.migrate'

const MIGRATION_KIND_LABELS: Record<MigratablePath, string> = {
  dshHome: 'DSH 数据目录',
  dshInstallPath: 'DSH 安装目录',
}

export interface MigrationTargetCheck {
  kind: MigratablePath
  target: string
  oldDir: string
  launcherDataDir?: string
}

export interface PathMigrationDeps {
  kind: MigratablePath
  target: string
  current: () => Promise<string>
  save: (next: string) => Promise<void>
  isBusy: () => boolean
  launcherDataDir?: string
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '未知错误'
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isMigratableKind(value: unknown): value is MigratablePath {
  return value === 'dshHome' || value === 'dshInstallPath'
}

export function assertMigrationTarget(input: MigrationTargetCheck): void {
  const kind = input.kind
  if (!isMigratableKind(kind)) {
    throw new Error('不支持的迁移目标：' + String(kind) + '，只能是 dshHome 或 dshInstallPath。')
  }
  const target = typeof input.target === 'string' ? input.target.trim() : ''
  if (!target) throw new Error('迁移目标目录不能为空。')
  if (!path.isAbsolute(target)) throw new Error('迁移目标必须是绝对路径：' + target)
  const oldDir = typeof input.oldDir === 'string' ? input.oldDir.trim() : ''
  if (!oldDir) throw new Error('当前目录尚未设置，无法迁移。')
  const targetKey = comparablePath(target)
  const oldKey = comparablePath(oldDir)
  if (targetKey === oldKey) throw new Error('迁移目标不能与当前目录相同：' + target)
  if (targetKey.startsWith(oldKey.endsWith(path.sep) ? oldKey : oldKey + path.sep)) {
    throw new Error('迁移目标不能位于当前目录内部：' + target)
  }
  const launcherDataDir = typeof input.launcherDataDir === 'string' ? input.launcherDataDir.trim() : ''
  if (launcherDataDir && comparablePath(launcherDataDir) === targetKey) {
    throw new Error('迁移目标不能是启动器数据目录：' + target)
  }
}

async function findConflictingEntry(source: string, target: string): Promise<string | null> {
  const entries = await readdir(source, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name)
    const targetPath = path.join(target, entry.name)
    const targetInfo = await stat(targetPath).catch(() => null)
    if (!targetInfo) continue
    if (entry.isDirectory() && targetInfo.isDirectory()) {
      const nested = await findConflictingEntry(sourcePath, targetPath)
      if (nested) return nested
      continue
    }
    return targetPath
  }
  return null
}

async function discardPartialCopy(source: string, target: string, targetCreated: boolean): Promise<void> {
  if (!targetCreated) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined)
    return
  }
  const entries = await readdir(source).catch(() => [] as string[])
  for (const name of entries) {
    await rm(path.join(target, name), { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function migratePath(deps: PathMigrationDeps): Promise<PathMigrationResult> {
  const kind = deps.kind
  if (!isMigratableKind(kind)) {
    throw new Error('不支持的迁移目标：' + String(kind) + '，只能是 dshHome 或 dshInstallPath。')
  }
  const oldDir = await deps.current()
  if (!oldDir || !oldDir.trim()) throw new Error('当前目录尚未设置，无法迁移：' + MIGRATION_KIND_LABELS[kind])
  assertMigrationTarget({ kind, target: deps.target, oldDir, launcherDataDir: deps.launcherDataDir })
  const target = path.resolve(deps.target)
  const source = path.resolve(oldDir)

  const sourceExists = await pathExists(source)
  const sourceInfo = sourceExists ? await stat(source).catch(() => null) : null
  const sourceIsDirectory = sourceInfo?.isDirectory() ?? false
  if (sourceExists && !sourceIsDirectory) throw new Error('当前目录不是文件夹，无法迁移：' + source)

  const hasSourceData = sourceIsDirectory ? (await readdir(source).catch(() => [] as string[])).length > 0 : false
  const targetExists = await pathExists(target)
  if (targetExists) {
    const targetInfo = await stat(target).catch(() => null)
    if (!targetInfo?.isDirectory()) throw new Error('迁移目标已存在且不是文件夹：' + target)
  }

  const conflict = sourceExists ? await findConflictingEntry(source, target) : null
  if (conflict) throw new Error('迁移目标中已存在同名内容：' + conflict + '，为避免覆盖已中止迁移。')

  let backupId: string | null = null
  if (hasSourceData) {
    const engine = getDefaultBackupEngine()
    if (!engine) throw new Error('备份引擎尚未就绪，已中止迁移：' + source)
    try {
      const entry = await engine.create({ paths: [source], label: '迁移 ' + kind, op: MIGRATION_BACKUP_OP })
      backupId = entry.id
    } catch (error) {
      throw new Error('备份旧目录失败，已中止迁移：' + messageOf(error))
    }
  }

  if (sourceExists) {
    try {
      await cp(source, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true })
    } catch (error) {
      await discardPartialCopy(source, target, targetExists)
      throw new Error('复制到新目录失败，已中止迁移：' + messageOf(error))
    }
  }

  try {
    await deps.save(target)
  } catch (error) {
    if (sourceExists) await discardPartialCopy(source, target, targetExists)
    throw new Error('写入设置失败，已放弃迁移并清理新目录：' + messageOf(error))
  }

  let removedOld = false
  let warning: string | null = null
  if (deps.isBusy()) {
    warning = '有整合包正在运行，旧目录暂未删除：' + source
  } else if (sourceExists) {
    try {
      await rm(source, { recursive: true, force: true })
      removedOld = true
    } catch (error) {
      warning = '旧目录删除失败，请手动清理：' + source + '（' + messageOf(error) + '）'
    }
  }

  return { kind, current: target, backupId, removedOld, warning }
}
