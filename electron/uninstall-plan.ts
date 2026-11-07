// 卸载计划：纯 node 计算，不碰 electron，也不真的删任何东西。
//
// 用户核心原则（原话）：「核心理念就是删掉启动这个软件之后新增的内容，之前的都不要动」。
// 所以只有本版启动器自己创建的文件进 delete 列表；%APPDATA%\\dsh-launcher（旧版启动器
// 数据）与用户目录下的 .dsh（DSH 家目录）永远只出现在 keep 里，并且带上原因。

import { execFileSync } from 'node:child_process'
import { existsSync as defaultExistsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { UninstallItem, UninstallPlan } from '../src/types'
import { LEGACY_DATA_DIRNAME, STORAGE_DATA_DIRNAME, STORAGE_POINTER_FILENAME } from './storage-root'

/** 开机自启项的注册表位置与值名。 */
export const UNINSTALL_LOGIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const UNINSTALL_LOGIN_ITEM_NAME = 'electron.app.DSH Launcher'

/** %TEMP% 里便携版自解压目录的命名（3L 开头）。 */
export const UNINSTALL_TEMP_RESIDUE_PREFIX = '3l'

/** 单个目录树最多数这么多个条目：旧版数据有几个 GB，量化保留量不值得阻塞主进程。 */
export const UNINSTALL_TREE_ENTRY_LIMIT = 50_000

/** 安装目录里最多为多少个「别人的东西」单独列一条。 */
const FOREIGN_ITEM_LIMIT = 20

export interface UninstallTreeInfo {
  sizeBytes: number
  fileCount: number
}

export interface UninstallPlanInput {
  /** 启动器 EXE 的绝对路径。 */
  executablePath: string
  /** 安装目录（EXE 所在目录）。 */
  installDir: string
  /** 本版数据目录，通常是 EXE 旁边的 launcher-data。 */
  dataDir: string
  /** 旧版启动器数据目录，通常是 %APPDATA%\\dsh-launcher。 */
  legacyDataDir: string
  /** DSH 家目录，通常是 ~/.dsh。 */
  dshHome: string
  tempDir: string
  /** 是否连本版数据目录一起删；缺省 true。 */
  deleteData?: boolean
  /** 正在运行的进程可执行文件路径；用来避开别的启动器实例的解压目录。缺省在 Windows 上问一次 PowerShell。 */
  processImagePaths?: () => string[]
  existsSync?: (target: string) => boolean
  statTree?: (target: string) => UninstallTreeInfo | null
  readDirNames?: (dir: string) => string[]
}

function normalizePath(target: string): string {
  return path.resolve(target).replace(/[\\/]+$/, '').toLowerCase()
}

function isSamePath(left: string, right: string): boolean {
  if (!left || !right) return false
  return normalizePath(left) === normalizePath(right)
}

function isInside(child: string, parent: string): boolean {
  if (!child || !parent) return false
  const c = normalizePath(child)
  const p = normalizePath(parent)
  if (c === p) return false
  return c.startsWith(p + '\\') || c.startsWith(p + '/')
}

function isDriveRoot(target: string): boolean {
  return /^[a-zA-Z]:$/.test(target.replace(/[\\/]+$/, ''))
}

/** 一次性取出所有进程的镜像路径；任何失败都当「查不到」，不影响其余计划。 */
function defaultProcessImagePaths(): string[] {
  if (process.platform !== 'win32') return []
  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    )
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

function defaultReadDirNames(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function defaultStatTree(target: string): UninstallTreeInfo | null {
  let sizeBytes = 0
  let fileCount = 0
  let visited = 0
  let touched = false

  const visit = (current: string): void => {
    if (visited >= UNINSTALL_TREE_ENTRY_LIMIT) return
    let stats
    try {
      stats = statSync(current)
    } catch {
      return
    }
    touched = true
    visited += 1
    if (stats.isFile()) {
      sizeBytes += stats.size
      fileCount += 1
      return
    }
    if (!stats.isDirectory()) return
    for (const name of defaultReadDirNames(current)) visit(path.join(current, name))
  }

  visit(target)
  if (!touched) return null
  return { sizeBytes, fileCount }
}

/**
 * 计算卸载计划。纯函数：同样的输入给同样的结果，不读进程状态、不删东西。
 */
export function createUninstallPlan(input: UninstallPlanInput): UninstallPlan {
  const exists = input.existsSync ?? defaultExistsSync
  const statTree = input.statTree ?? defaultStatTree
  const readDirNames = input.readDirNames ?? defaultReadDirNames
  const processImagePaths = input.processImagePaths
  const deleteData = input.deleteData !== false

  const executablePath = path.resolve(input.executablePath)
  const installDir = path.resolve(input.installDir)
  const dataDir = path.resolve(input.dataDir)
  const legacyDataDir = path.resolve(input.legacyDataDir)
  const dshHome = path.resolve(input.dshHome)
  const tempDir = path.resolve(input.tempDir)
  const pointerFile = path.join(installDir, STORAGE_POINTER_FILENAME)

  const items: UninstallItem[] = []
  const warnings: string[] = []
  const measure = (target: string): UninstallTreeInfo => statTree(target) ?? { sizeBytes: 0, fileCount: 0 }

  // 主程序自己。
  const exeSize = measure(executablePath)
  items.push({
    id: 'exe',
    label: '启动器主程序',
    path: executablePath,
    kind: 'file',
    sizeBytes: exeSize.sizeBytes,
    fileCount: exeSize.fileCount,
    action: 'delete',
  })
  if (!exists(executablePath)) {
    warnings.push('启动器主程序不在预期位置：' + executablePath + '（可能已经被删过一次，其余项目照常清理。）')
  }

  // 指针文件：本版启动器切到别处时留下的记录。
  if (exists(pointerFile)) {
    const pointerSize = measure(pointerFile)
    items.push({
      id: 'pointer',
      label: '数据目录指针文件',
      path: pointerFile,
      kind: 'file',
      sizeBytes: pointerSize.sizeBytes,
      fileCount: 1,
      action: 'delete',
    })
  }

  // 本版数据目录。它一旦就是旧版数据目录，就按 keep 处理，绝不删。
  const dataIsLegacy = isSamePath(dataDir, legacyDataDir)
  const dataKept = dataIsLegacy || !deleteData
  if (dataIsLegacy) {
    const info = measure(dataDir)
    items.push({
      id: 'data',
      label: '启动器数据目录（旧版）',
      path: dataDir,
      kind: 'directory',
      sizeBytes: info.sizeBytes,
      fileCount: info.fileCount,
      action: 'keep',
      reason: '这是旧版启动器数据，按规则保留',
    })
    warnings.push('本版数据目录与旧版启动器数据是同一个目录：数据整体保留，只删除程序文件。')
  } else if (deleteData) {
    const info = measure(dataDir)
    items.push({
      id: 'data',
      label: '本版数据目录',
      path: dataDir,
      kind: 'directory',
      sizeBytes: info.sizeBytes,
      fileCount: info.fileCount,
      action: 'delete',
    })
  } else {
    const info = measure(dataDir)
    items.push({
      id: 'data',
      label: '本版数据目录',
      path: dataDir,
      kind: 'directory',
      sizeBytes: info.sizeBytes,
      fileCount: info.fileCount,
      action: 'keep',
      reason: '本次选择保留数据，只删除程序文件',
    })
  }

  // 旧版启动器数据：永不删除。
  if (!dataIsLegacy) {
    const info = measure(legacyDataDir)
    items.push({
      id: 'legacy-data',
      label: '旧版启动器数据（' + LEGACY_DATA_DIRNAME + '）',
      path: legacyDataDir,
      kind: 'directory',
      sizeBytes: info.sizeBytes,
      fileCount: info.fileCount,
      action: 'keep',
      reason: '这是旧版启动器数据，按规则保留',
    })
  }

  // DSH 家目录：会话、配置、运行时都在里面，永不删除。
  const dshInfo = measure(dshHome)
  items.push({
    id: 'dsh-home',
    label: 'DSH 家目录（.dsh）',
    path: dshHome,
    kind: 'directory',
    sizeBytes: dshInfo.sizeBytes,
    fileCount: dshInfo.fileCount,
    action: 'keep',
    reason: '这是 DSH 的家目录（会话、配置与运行时都在里面），按规则保留',
  })

  // 安装目录：只有里面除了启动器自己的东西之外空无一物，才整体删掉。
  const ownedNames = new Set<string>([
    path.basename(executablePath).toLowerCase(),
    STORAGE_POINTER_FILENAME.toLowerCase(),
    STORAGE_DATA_DIRNAME.toLowerCase(),
  ])
  if (isInside(dataDir, installDir)) ownedNames.add(path.basename(dataDir).toLowerCase())
  const foreign = readDirNames(installDir).filter((name) => !ownedNames.has(name.toLowerCase()))
  const dataBlocksDir = dataKept && isInside(dataDir, installDir)
  const canRemoveDir =
    exists(installDir) &&
    foreign.length === 0 &&
    !isDriveRoot(installDir) &&
    !isSamePath(installDir, dataDir) &&
    !isSamePath(installDir, legacyDataDir) &&
    !isSamePath(installDir, dshHome) &&
    !dataBlocksDir

  if (canRemoveDir) {
    const info = measure(installDir)
    const subtract = (target: string): void => {
      if (!target) return
      const part = measure(target)
      info.sizeBytes = Math.max(0, info.sizeBytes - part.sizeBytes)
      info.fileCount = Math.max(0, info.fileCount - part.fileCount)
    }
    subtract(executablePath)
    subtract(pointerFile)
    if (isInside(dataDir, installDir) && !dataIsLegacy) subtract(dataDir)
    items.push({
      id: 'install-dir',
      label: '安装目录',
      path: installDir,
      kind: 'directory',
      sizeBytes: info.sizeBytes,
      fileCount: info.fileCount,
      action: 'delete',
    })
  } else if (foreign.length > 0) {
    const names = foreign.slice(0, FOREIGN_ITEM_LIMIT)
    for (const name of names) {
      const target = path.join(installDir, name)
      const info = measure(target)
      items.push({
        id: 'install-dir-keep-' + name.toLowerCase(),
        label: '安装目录里的其他内容',
        path: target,
        kind: 'file',
        sizeBytes: info.sizeBytes,
        fileCount: info.fileCount,
        action: 'keep',
        reason: '不属于本版启动器创建的内容，按规则保留',
      })
    }
    if (foreign.length > names.length) {
      items.push({
        id: 'install-dir-keep-rest',
        label: '安装目录里的其他内容（其余 ' + (foreign.length - names.length) + ' 项）',
        path: installDir,
        kind: 'directory',
        sizeBytes: 0,
        fileCount: 0,
        action: 'keep',
        reason: '不属于本版启动器创建的内容，按规则保留',
      })
    }
    warnings.push(
      '安装目录里还有不属于本版启动器的内容（' + names.join('、') + '）：本次只删除启动器文件，目录保留。',
    )
  } else if (dataBlocksDir) {
    warnings.push('安装目录里留着要保留的本版数据：目录整体保留，只删除程序文件。')
  }

  // 开机自启项。计划阶段不去读注册表（纯 node、跨平台可测），由执行层按存在性删。
  items.push({
    id: 'registry-run',
    label: '开机自启注册表项',
    path: UNINSTALL_LOGIN_RUN_KEY + '\\' + UNINSTALL_LOGIN_ITEM_NAME,
    kind: 'registry',
    sizeBytes: 0,
    fileCount: 0,
    action: 'delete',
  })

  // %TEMP% 里本版便携版自己解出来的 3L* 目录。
  if (exists(tempDir)) {
    const residues = readDirNames(tempDir).filter((name) => name.toLowerCase().startsWith(UNINSTALL_TEMP_RESIDUE_PREFIX))
    // 有进程正住在目录里（通常是另一个启动器实例）时不能删：删了那个实例随时会崩。
    const imagePaths = residues.length > 0 ? (processImagePaths ?? defaultProcessImagePaths)() : []
    for (const name of residues) {
      const target = path.join(tempDir, name)
      if (!exists(target)) continue
      const info = measure(target)
      const inUse = imagePaths.some((image) => isSamePath(image, target) || isInside(image, target))
      items.push({
        id: 'temp-residue-' + name.toLowerCase(),
        label: '便携版自解压残留',
        path: target,
        kind: 'directory',
        sizeBytes: info.sizeBytes,
        fileCount: info.fileCount,
        action: inUse ? 'keep' : 'delete',
        ...(inUse ? { reason: '有进程正从这个目录运行（可能是另一个启动器实例），按规则保留' } : {}),
      })
    }
  }

  const totals = summarize({ items })
  return {
    executablePath,
    installDir,
    dataDir,
    items,
    deleteBytes: totals.deleteBytes,
    keepBytes: totals.keepBytes,
    warnings,
  }
}

/** 按 action 汇总字节数；registry 项没有大小，天然是 0。 */
export function summarize(plan: { items?: UninstallItem[] | null }): { deleteBytes: number; keepBytes: number } {
  const items = Array.isArray(plan?.items) ? plan.items : []
  let deleteBytes = 0
  let keepBytes = 0
  for (const item of items) {
    const size = Number(item?.sizeBytes)
    const amount = Number.isFinite(size) && size > 0 ? size : 0
    if (item?.action === 'delete') deleteBytes += amount
    else keepBytes += amount
  }
  return { deleteBytes, keepBytes }
}
