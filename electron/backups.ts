// 备份区引擎：所有「可恢复的删除 / 迁移」都先压成一个 zip 放进 <userData>/backups，
// 再由调用方真正去删。所以这里任何一步失败都必须抛错并且不动原数据。
//
// 不引第三方压缩库：Windows 自带 bsdtar（System32\tar.exe）能按父目录进包、也能按成员解压，
// PowerShell 的 Compress-Archive / Expand-Archive 只作兜底。备份是删东西之前的最后一道保险，
// 多一个原生依赖就多一个装不上的理由。

import { execFile } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { BackupEntry, BackupOpKind, BackupOverview } from '../src/types'
import { writeFileAtomic } from './fs-atomic'

export const BACKUPS_DIRECTORY = 'backups'
export const BACKUP_INDEX_FILENAME = 'index.json'
export const BACKUP_SETTINGS_FILENAME = 'backup-settings.json'
/** 默认容量上限 2 GiB；0 表示不限。 */
export const DEFAULT_BACKUP_LIMIT_BYTES = 2147483648

const INDEX_VERSION = 1
const BACKUP_OPS: readonly BackupOpKind[] = [
  'pack.delete',
  'plugin.delete',
  'skill.delete',
  'preset.delete',
  'resource.unlink',
  'version.delete',
  'path.migrate',
  'manual',
]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GiB'
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MiB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KiB'
  return bytes + ' 字节'
}

async function pathExists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false)
}

/** 目录里的文件数（符号链接按一个文件算，与 tar 存链接的行为一致）。 */
async function countFiles(target: string): Promise<number> {
  const info = await stat(target).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return 1
  const entries = await readdir(target, { withFileTypes: true }).catch(() => [])
  let total = 0
  for (const entry of entries) total += await countFiles(path.join(target, entry.name))
  return total
}

/** rename 跨卷（EXDEV）时退回复制 + 删除。 */
async function moveOrCopy(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await rename(source, target)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  await cp(source, target, { recursive: true, force: true })
  await rm(source, { recursive: true, force: true })
}

function runTool(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr ?? '').trim()
        reject(new Error(detail || error.message))
        return
      }
      resolve(stdout ?? '')
    })
  })
}

/** 压缩工具面：只做建包、列成员、按成员解压三件事。 */
export interface BackupArchiveTool {
  readonly kind: 'tar' | 'powershell'
  create(archivePath: string, origins: string[]): Promise<void>
  list(archivePath: string): Promise<string[]>
  extract(archivePath: string, member: string, parent: string): Promise<void>
}

function tarTool(tarPath: string): BackupArchiveTool {
  return {
    kind: 'tar',
    async create(archivePath, origins) {
      const args = ['-a', '-cf', archivePath]
      for (const origin of origins) args.push('-C', path.dirname(origin), path.basename(origin))
      await runTool(tarPath, args)
    },
    async list(archivePath) {
      const stdout = await runTool(tarPath, ['-tf', archivePath])
      return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    },
    async extract(archivePath, member, parent) {
      await mkdir(parent, { recursive: true })
      await runTool(tarPath, ['-xf', archivePath, '-C', parent, member])
    },
  }
}

function powerShellQuote(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'"
}

function powerShellTool(shellPath: string): BackupArchiveTool {
  return {
    kind: 'powershell',
    async create(archivePath, origins) {
      const items = origins.map(powerShellQuote).join(',')
      await runTool(shellPath, [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Compress-Archive -LiteralPath @(' + items + ') -DestinationPath ' + powerShellQuote(archivePath) + ' -Force',
      ])
    },
    async list(archivePath) {
      // Expand-Archive 看不了成员名单，改走 .NET 的 ZipFile：只读打开再枚举。
      const script =
        'Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip = [System.IO.Compression.ZipFile]::OpenRead(' +
        powerShellQuote(archivePath) +
        '); try { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }'
      const stdout = await runTool(shellPath, ['-NoProfile', '-NonInteractive', '-Command', script])
      return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    },
    async extract(archivePath, member, parent) {
      await mkdir(parent, { recursive: true })
      // Expand-Archive 只能整包展开，于是先展到同卷临时目录，再只搬走要恢复的那一项。
      const staging = path.join(parent, '.ps-extract-' + randomSuffix())
      try {
        await runTool(shellPath, [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath ' + powerShellQuote(archivePath) + ' -DestinationPath ' + powerShellQuote(staging) + ' -Force',
        ])
        await moveOrCopy(path.join(staging, member), path.join(parent, member))
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  }
}

let resolvedTool: Promise<BackupArchiveTool> | null = null

async function resolveToolUncached(): Promise<BackupArchiveTool> {
  const systemRoot = process.env.SystemRoot?.trim() || 'C:\\Windows'
  const tarCandidates = [
    path.join(systemRoot, 'System32', 'tar.exe'),
    'C:\\Windows\\System32\\tar.exe',
  ]
  for (const candidate of tarCandidates) {
    if (await access(candidate).then(() => true, () => false)) return tarTool(candidate)
  }
  const shellCandidates = [
    path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(systemRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const candidate of shellCandidates) {
    if (await access(candidate).then(() => true, () => false)) return powerShellTool(candidate)
  }
  throw new Error('这台电脑上既找不到 tar.exe 也找不到 PowerShell，无法创建或恢复备份压缩包。')
}

/** 探测本机可用的压缩工具（成功结果缓存；失败不缓存，装好工具后重试即可）。 */
export function resolveBackupArchiveTool(): Promise<BackupArchiveTool> {
  const pending = resolveToolUncached()
  resolvedTool = pending
  pending.catch(() => {
    if (resolvedTool === pending) resolvedTool = null
  })
  return pending
}

/**
 * 恢复前的成员校验：只允许「相对路径 + 首段是这次备份里的原始名字」。
 * 绝对路径、盘符、以及 '..' 段一律拒绝——zip 里写什么都由文件内容决定，不能信。
 */
export function assertSafeArchiveMembers(members: string[], allowedRoots: string[]): void {
  const allowed = new Set(allowedRoots)
  const reject = (member: string): never => {
    throw new Error('备份压缩包里有越界的文件路径（' + member + '），已拒绝恢复。')
  }
  for (const raw of members) {
    const member = raw.replace(/\\/g, '/')
    if (!member || member.includes('\0')) reject(raw)
    if (member.startsWith('/') || /^[A-Za-z]:/.test(member)) reject(raw)
    const segments = member.split('/').filter(segment => segment.length > 0)
    if (segments.length === 0) reject(raw)
    if (segments.some(segment => segment === '..')) reject(raw)
    if (!allowed.has(segments[0] as string)) reject(raw)
  }
}

function normalizeLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : ''
  if (!label) throw new Error('备份名称不能为空。')
  return label.slice(0, 200)
}

function normalizeOp(value: unknown): BackupOpKind {
  if (value === undefined || value === null) return 'manual'
  if (typeof value === 'string' && (BACKUP_OPS as readonly string[]).includes(value)) return value as BackupOpKind
  throw new Error('备份来源无效。')
}

/** 原始路径规范化：绝对路径、去重、只留真实存在的路径。 */
async function normalizeOrigins(paths: unknown): Promise<string[]> {
  if (!Array.isArray(paths)) throw new Error('备份路径无效。')
  const seen = new Set<string>()
  const origins: string[] = []
  for (const item of paths) {
    if (typeof item !== 'string' || !item.trim()) throw new Error('备份路径无效。')
    const resolved = path.resolve(item)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    if (await pathExists(resolved)) origins.push(resolved)
  }
  origins.sort((left, right) => left.localeCompare(right))
  return origins
}

/** 一个 zip 里的成员名只能是各自的 basename，重名就没法分别恢复了。 */
function assertUniqueBasenames(origins: string[]): void {
  const seen = new Set<string>()
  for (const origin of origins) {
    const name = path.basename(origin)
    if (seen.has(name)) throw new Error('同一次备份里的路径不能同名（' + name + '），请分开备份。')
    seen.add(name)
  }
}

function normalizeId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(id)) throw new Error('备份标识无效。')
  return id
}

interface BackupIndexFile {
  version: number
  entries: BackupEntry[]
}

function isBackupEntry(value: unknown): value is BackupEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string'
    && typeof entry.op === 'string'
    && typeof entry.label === 'string'
    && typeof entry.createdAt === 'number'
    && typeof entry.sizeBytes === 'number'
    && typeof entry.fileCount === 'number'
    && typeof entry.locked === 'boolean'
    && Array.isArray(entry.origin)
    && entry.origin.every(item => typeof item === 'string')
    && typeof entry.archivePath === 'string'
}

export interface BackupEngineDeps {
  /** 启动器的 userData 目录；backups / index.json / backup-settings.json 都在它下面。 */
  root: string
  /** 整合包是否正在运行：恢复会覆盖目标目录，所以要拦下运行中的包。 */
  isPackRunning?: (packId: string) => boolean
  /** 整合包 id 到界面名字的映射（拒绝信息里用）。 */
  packLabel?: (packId: string) => string | null
  /** 某个目标路径属于哪个整合包；不给就只按 entry.packId 判定。 */
  packForPath?: (target: string) => string | null
  /** 覆盖压缩工具（测试与诊断用）。 */
  tools?: BackupArchiveTool
  /** 覆盖当前时间（测试注入稳定的 createdAt）。 */
  now?: () => number
}

export interface BackupCreateInput {
  paths: string[]
  label: string
  op?: BackupOpKind
  packId?: string
}

export interface BackupEngine {
  /** <userData>/backups */
  readonly directory: string
  list(): Promise<BackupOverview>
  create(input: BackupCreateInput): Promise<BackupEntry>
  restore(id: string): Promise<BackupOverview>
  remove(id: string): Promise<BackupOverview>
  setLocked(id: string, locked: boolean): Promise<BackupOverview>
  /** 0 表示不限制。 */
  setLimit(bytes: number): Promise<BackupOverview>
  /** 备份压缩包的绝对路径（reveal 用）。 */
  archivePath(id: string): Promise<string>
}

export function createBackupEngine(deps: BackupEngineDeps): BackupEngine {
  const rootDir = path.resolve(deps.root)
  const backupRoot = path.join(rootDir, BACKUPS_DIRECTORY)
  const indexPath = path.join(backupRoot, BACKUP_INDEX_FILENAME)
  const settingsPath = path.join(rootDir, BACKUP_SETTINGS_FILENAME)
  const now = deps.now ?? (() => Date.now())

  // 同一引擎上的写操作必须串行：index.json 是「读-改-写」，并发创建会互相覆盖条目。
  let queue: Promise<unknown> = Promise.resolve()
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  let toolPromise: Promise<BackupArchiveTool> | null = deps.tools ? Promise.resolve(deps.tools) : null
  function archiveTool(): Promise<BackupArchiveTool> {
    if (!toolPromise) toolPromise = resolveBackupArchiveTool()
    return toolPromise
  }

  async function readEntries(): Promise<BackupEntry[]> {
    const raw = await readFile(indexPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (raw === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('备份索引损坏，无法解析：' + indexPath)
    }
    const file = parsed as BackupIndexFile
    if (!file || !Array.isArray(file.entries) || !file.entries.every(isBackupEntry)) {
      throw new Error('备份索引格式无效：' + indexPath)
    }
    return file.entries
  }

  async function writeEntries(entries: BackupEntry[]): Promise<void> {
    const payload: BackupIndexFile = { version: INDEX_VERSION, entries }
    await writeFileAtomic(indexPath, JSON.stringify(payload, null, 2))
  }

  async function readLimit(): Promise<number> {
    const raw = await readFile(settingsPath, 'utf8').catch(() => null)
    if (raw === null) return DEFAULT_BACKUP_LIMIT_BYTES
    try {
      const parsed = JSON.parse(raw) as { limitBytes?: unknown }
      const value = parsed ? parsed.limitBytes : undefined
      // 容量配置坏了只是回到默认上限，不影响备份文件本身。
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
    } catch {
      // 同上：读不懂就用默认值。
    }
    return DEFAULT_BACKUP_LIMIT_BYTES
  }

  async function writeLimit(bytes: number): Promise<void> {
    await writeFileAtomic(settingsPath, JSON.stringify({ version: INDEX_VERSION, limitBytes: bytes }, null, 2))
  }

  function toOverview(entries: BackupEntry[], limitBytes: number): BackupOverview {
    const sorted = [...entries].sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    return {
      entries: sorted,
      totalBytes: sorted.reduce((sum, entry) => sum + Math.max(0, entry.sizeBytes), 0),
      limitBytes,
      directory: backupRoot,
    }
  }

  /** 超限就用最久远的未锁定条目换空间；锁定条目（用户点名保留）永不自动清理。 */
  async function evictOverflow(entries: BackupEntry[], limitBytes: number): Promise<BackupEntry[]> {
    if (limitBytes <= 0) return entries
    let total = entries.reduce((sum, entry) => sum + Math.max(0, entry.sizeBytes), 0)
    const remaining = [...entries]
    while (total > limitBytes) {
      const candidate = remaining
        .filter(entry => !entry.locked)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))[0]
      if (!candidate) break
      await rm(candidate.archivePath, { force: true }).catch(() => undefined)
      remaining.splice(remaining.indexOf(candidate), 1)
      total -= Math.max(0, candidate.sizeBytes)
    }
    return remaining
  }

  function findEntry(entries: BackupEntry[], id: string): BackupEntry {
    const entry = entries.find(item => item.id === id)
    if (!entry) throw new Error('没有找到这条备份（' + id + '）。')
    return entry
  }

  /** 恢复前拦下正在运行的整合包：覆盖一个活着的环境比恢复失败严重得多。 */
  function assertTargetsIdle(entry: BackupEntry): void {
    const packIds = new Set<string>()
    if (entry.packId) packIds.add(entry.packId)
    for (const origin of entry.origin) {
      const fromPath = deps.packForPath?.(origin)
      if (fromPath) packIds.add(fromPath)
    }
    for (const packId of packIds) {
      if (!deps.isPackRunning?.(packId)) continue
      const name = deps.packLabel?.(packId) || packId
      throw new Error('整合包 ' + name + ' 正在运行，请先停止再恢复')
    }
  }

  return {
    directory: backupRoot,

    list() {
      return serialize(async () => toOverview(await readEntries(), await readLimit()))
    },

    create(input) {
      return serialize(async () => {
        const label = normalizeLabel(input ? input.label : undefined)
        const op = normalizeOp(input ? input.op : undefined)
        const origins = await normalizeOrigins(input ? input.paths : undefined)
        if (origins.length === 0) throw new Error('没有找到要备份的内容（路径不存在或为空）。')
        assertUniqueBasenames(origins)
        const packId = input && typeof input.packId === 'string' && input.packId.trim() ? input.packId.trim() : undefined
        await mkdir(backupRoot, { recursive: true })

        const createdAt = now()
        const id = createdAt.toString(36) + '-' + randomSuffix()
        const archivePath = path.join(backupRoot, id + '.zip')
        // 先写成 .partial.zip 再改名：索引里永远只出现已经建好的包。
        const partialPath = path.join(backupRoot, id + '.partial.zip')
        try {
          const tool = await archiveTool()
          await tool.create(partialPath, origins)
          await rename(partialPath, archivePath)
        } catch (error) {
          await rm(partialPath, { force: true }).catch(() => undefined)
          throw new Error('备份失败：' + messageOf(error))
        }

        const info = await stat(archivePath)
        let fileCount = 0
        for (const origin of origins) fileCount += await countFiles(origin)
        const entry: BackupEntry = {
          id,
          op,
          label,
          createdAt,
          sizeBytes: info.size,
          fileCount,
          locked: false,
          origin: origins,
          archivePath,
          ...(packId ? { packId } : {}),
        }

        const limitBytes = await readLimit()
        const kept = await evictOverflow([...(await readEntries()), entry], limitBytes)
        if (!kept.some(item => item.id === id)) {
          throw new Error('这次备份有 ' + formatBytes(info.size) + '，超过容量上限 ' + formatBytes(limitBytes)
            + '，没能保留（请先清理备份区或调大上限）。')
        }
        await writeEntries(kept)
        return entry
      })
    },

    restore(id) {
      return serialize(async () => {
        const backupId = normalizeId(id)
        const entries = await readEntries()
        const entry = findEntry(entries, backupId)
        if (!(await pathExists(entry.archivePath))) throw new Error('备份压缩包已丢失：' + entry.archivePath)
        const tool = await archiveTool()
        const members = await tool.list(entry.archivePath).catch((error: unknown) => {
          throw new Error('读取备份压缩包失败：' + messageOf(error))
        })
        const expected = entry.origin.map(origin => path.basename(origin))
        assertSafeArchiveMembers(members, expected)
        assertTargetsIdle(entry)

        await mkdir(backupRoot, { recursive: true })
        const staging = await mkdtemp(path.join(backupRoot, '.restore-'))
        try {
          // 先全部解到 staging 再动原路径：解压失败时用户的数据还在原地。
          for (const origin of entry.origin) {
            await tool.extract(entry.archivePath, path.basename(origin), staging)
          }
          for (const origin of entry.origin) {
            if (!(await pathExists(path.join(staging, path.basename(origin))))) {
              throw new Error('备份里缺少 ' + path.basename(origin) + '，已中止恢复。')
            }
          }
          for (const origin of entry.origin) {
            await rm(origin, { recursive: true, force: true })
            await moveOrCopy(path.join(staging, path.basename(origin)), origin)
          }
        } finally {
          await rm(staging, { recursive: true, force: true }).catch(() => undefined)
        }

        const restoredAt = now()
        const next = entries.map(item => (item.id === backupId ? { ...item, restoredAt } : item))
        await writeEntries(next)
        return toOverview(next, await readLimit())
      })
    },

    remove(id) {
      return serialize(async () => {
        const backupId = normalizeId(id)
        const entries = await readEntries()
        const entry = findEntry(entries, backupId)
        await rm(entry.archivePath, { force: true }).catch(() => undefined)
        const next = entries.filter(item => item.id !== backupId)
        await writeEntries(next)
        return toOverview(next, await readLimit())
      })
    },

    setLocked(id, locked) {
      return serialize(async () => {
        const backupId = normalizeId(id)
        const entries = await readEntries()
        findEntry(entries, backupId)
        const next = entries.map(item => (item.id === backupId ? { ...item, locked: Boolean(locked) } : item))
        await writeEntries(next)
        return toOverview(next, await readLimit())
      })
    },

    setLimit(bytes) {
      return serialize(async () => {
        if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
          throw new Error('容量上限必须是不小于 0 的整数（单位字节）。')
        }
        await writeLimit(bytes)
        const kept = await evictOverflow(await readEntries(), bytes)
        await writeEntries(kept)
        return toOverview(kept, bytes)
      })
    },

    archivePath(id) {
      return serialize(async () => findEntry(await readEntries(), normalizeId(id)).archivePath)
    },
  }
}

/* ===== 删除类 hook：先备份，备份失败就中止删除 ===== */

let defaultEngine: BackupEngine | null = null

/**
 * 装配期把引擎交给删除 hook 用（main.ts 通过 registerBackupsIpc 完成）。
 * 不接引擎时 hook 直接放行：单测与命令行环境没有真实 userData，也不该因此删不了东西。
 */
export function setDefaultBackupEngine(engine: BackupEngine | null): void {
  defaultEngine = engine
}

export function getDefaultBackupEngine(): BackupEngine | null {
  return defaultEngine
}

export interface DeleteBackupInput {
  paths: string[]
  label: string
  op: BackupOpKind
  packId?: string
}

/**
 * 删除前的最后一道保险：把待删路径压进备份区，失败就抛中文错误让调用方中止删除。
 * 返回 null 表示没有可备份的内容（路径本就不存在）或没有接引擎。
 */
export async function backupBeforeDelete(input: DeleteBackupInput): Promise<BackupEntry | null> {
  const engine = defaultEngine
  if (!engine) return null
  const paths: string[] = []
  for (const candidate of input.paths) {
    if (candidate && (await pathExists(candidate))) paths.push(candidate)
  }
  if (paths.length === 0) return null
  try {
    return await engine.create({
      paths,
      label: input.label,
      op: input.op,
      ...(input.packId ? { packId: input.packId } : {}),
    })
  } catch (error) {
    // 引擎已用「备份失败：」起头，这里只保留真正的原因，别让两句话叠在一起。
    const detail = messageOf(error).replace(/^备份失败：/, '')
    throw new Error('备份「' + input.label + '」失败，已阻止删除：' + detail)
  }
}
