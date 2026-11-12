// 卸载计划：纯 node 计算，不碰 electron，也不真的删任何东西。
//
// 用户核心原则（原话）：「核心理念就是删掉启动这个软件之后新增的内容，之前的都不要动」。
// 所以只有本版启动器自己创建的文件进 delete 列表；%APPDATA%\\dsh-launcher（旧版启动器
// 数据）与用户目录下的 .dsh（DSH 家目录）永远只出现在 keep 里，并且带上原因。

import { execFileSync } from 'node:child_process'
import { existsSync as defaultExistsSync, readdirSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { UninstallItem, UninstallPlan } from '../src/types'
import { LEGACY_DATA_DIRNAME, STORAGE_DATA_DIRNAME, STORAGE_POINTER_FILENAME } from './storage-root'

/** 开机自启项的注册表位置与值名。 */
export const UNINSTALL_LOGIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
export const UNINSTALL_LOGIN_ITEM_NAME = 'electron.app.DSH-launcher-KEWU'

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

export interface UninstallResolvedPaths {
  executablePath: string
  installDir: string
  dataDir: string
  legacyDataDir: string
  dshHome: string
  tempDir: string
  /** 安装目录里的数据目录指针文件。 */
  pointerFile: string
}

/** 六个输入路径一次性解析成绝对路径；同步装配与异步统计共用同一份，路径口径不会漂。 */
function resolveUninstallPaths(input: UninstallPlanInput): UninstallResolvedPaths {
  const installDir = path.resolve(input.installDir)
  return {
    executablePath: path.resolve(input.executablePath),
    installDir,
    dataDir: path.resolve(input.dataDir),
    legacyDataDir: path.resolve(input.legacyDataDir),
    dshHome: path.resolve(input.dshHome),
    tempDir: path.resolve(input.tempDir),
    pointerFile: path.join(installDir, STORAGE_POINTER_FILENAME),
  }
}

export interface InstallDirInspection {
  /** 安装目录里不属于本版启动器的条目名。 */
  foreign: string[]
  /** 安装目录里留着要保留的本版数据：目录不能整体删。 */
  dataBlocksDir: boolean
  /** 除启动器自己的东西之外空无一物，可以整体删掉安装目录。 */
  canRemoveDir: boolean
}

/**
 * 安装目录的归属判断：只看目录项与路径、不看任何条目大小，
 * 所以同步装配与异步统计能共用同一份结论，不必各写一遍。
 */
function inspectInstallDir(options: {
  paths: UninstallResolvedPaths
  dataKept: boolean
  exists: (target: string) => boolean
  readDirNames: (dir: string) => string[]
}): InstallDirInspection {
  const { paths, dataKept } = options
  const ownedNames = new Set<string>([
    path.basename(paths.executablePath).toLowerCase(),
    STORAGE_POINTER_FILENAME.toLowerCase(),
    STORAGE_DATA_DIRNAME.toLowerCase(),
  ])
  if (isInside(paths.dataDir, paths.installDir)) ownedNames.add(path.basename(paths.dataDir).toLowerCase())
  const foreign = options.readDirNames(paths.installDir).filter((name) => !ownedNames.has(name.toLowerCase()))
  const dataBlocksDir = dataKept && isInside(paths.dataDir, paths.installDir)
  const canRemoveDir =
    options.exists(paths.installDir) &&
    foreign.length === 0 &&
    !isDriveRoot(paths.installDir) &&
    !isSamePath(paths.installDir, paths.dataDir) &&
    !isSamePath(paths.installDir, paths.legacyDataDir) &&
    !isSamePath(paths.installDir, paths.dshHome) &&
    !dataBlocksDir
  return { foreign, dataBlocksDir, canRemoveDir }
}

/** 异步统计的并发宽度：几十万个条目全并行会把句柄和内存吃光。 */
export const UNINSTALL_ASYNC_IO_CONCURRENCY = 8

/** 按固定宽度的工人池跑完一批任务，避免一次开几万个 promise。 */
async function mapLimit<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const width = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: width }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await run(item)
    }
  }))
}

/**
 * 异步版目录树统计：数法（文件数 + 字节数、UNINSTALL_TREE_ENTRY_LIMIT 上限、空树返回 null）与
 * defaultStatTree 一致，只把 readdirSync/statSync 换成 fs/promises，主进程不再被同步 IO 卡住。
 * 逐层推进以便按层并行；上限真的触发时统计到的子集可能与同步的深度优先不同，
 * 而这个上限本来就只是防呆——计划只需要「大致多大」。
 */
export async function statTreeAsync(target: string, limit: number = UNINSTALL_TREE_ENTRY_LIMIT): Promise<UninstallTreeInfo | null> {
  const state = { sizeBytes: 0, fileCount: 0, visited: 0, touched: false }
  let level: string[] = [target]
  while (level.length > 0 && state.visited < limit) {
    const next: string[] = []
    await mapLimit(level, UNINSTALL_ASYNC_IO_CONCURRENCY, async (current) => {
      if (state.visited >= limit) return
      let stats
      try {
        stats = await stat(current)
      } catch {
        return
      }
      state.touched = true
      state.visited += 1
      if (stats.isFile()) {
        state.sizeBytes += stats.size
        state.fileCount += 1
        return
      }
      if (!stats.isDirectory()) return
      let names: string[] = []
      try {
        names = await readdir(current)
      } catch {
        names = []
      }
      for (const name of names) {
        if (next.length >= limit) return
        next.push(path.join(current, name))
      }
    })
    level = next
  }
  return state.touched ? { sizeBytes: state.sizeBytes, fileCount: state.fileCount } : null
}

/**
 * 先把计划里每个可能被统计的路径异步量好，键是 normalizePath 的结果（与同步版比较口径一致）。
 * 这份目标集合必须与 createUninstallPlan 里的 measure() 调用严格对应，
 * 否则同步装配会拿到 undefined，把有内容的行报成 0。
 */
export async function collectUninstallTreeSizes(input: UninstallPlanInput): Promise<Map<string, UninstallTreeInfo>> {
  const exists = input.existsSync ?? defaultExistsSync
  const readDirNames = input.readDirNames ?? defaultReadDirNames
  const measure = input.statTree ?? statTreeAsync
  const deleteData = input.deleteData !== false
  const paths = resolveUninstallPaths(input)

  // 同步版 measure() 的目标全集：主程序、指针文件、本版数据、旧版数据、DSH 家目录、安装目录、
  // 安装目录里的每个外来子项、%TEMP% 里每个 3L* 残留。
  const targets: string[] = [paths.executablePath, paths.dataDir, paths.dshHome]
  if (exists(paths.pointerFile)) targets.push(paths.pointerFile)
  const dataIsLegacy = isSamePath(paths.dataDir, paths.legacyDataDir)
  if (!dataIsLegacy) targets.push(paths.legacyDataDir)

  const dataKept = dataIsLegacy || !deleteData
  const { foreign, canRemoveDir } = inspectInstallDir({ paths, dataKept, exists, readDirNames })
  if (canRemoveDir) targets.push(paths.installDir)
  else if (foreign.length > 0) for (const name of foreign) targets.push(path.join(paths.installDir, name))

  if (exists(paths.tempDir)) {
    for (const name of readDirNames(paths.tempDir)) {
      if (!name.toLowerCase().startsWith(UNINSTALL_TEMP_RESIDUE_PREFIX)) continue
      const target = path.join(paths.tempDir, name)
      if (exists(target)) targets.push(target)
    }
  }

  const unique = new Map<string, string>()
  for (const target of targets) {
    const key = normalizePath(target)
    if (!unique.has(key)) unique.set(key, target)
  }

  const sizes = new Map<string, UninstallTreeInfo>()
  await mapLimit([...unique.entries()], UNINSTALL_ASYNC_IO_CONCURRENCY, async ([key, target]) => {
    const info = await measure(target)
    if (info) sizes.set(key, info)
  })
  return sizes
}

/**
 * 异步版 createUninstallPlan：计划装配仍然只有同步版那一份（一行不改、注入点不变），
 * 这里只负责先把每个目标的量异步算进 Map，再把这个 Map 当成 statTree 注入进去。
 */
export async function createUninstallPlanAsync(input: UninstallPlanInput): Promise<UninstallPlan> {
  const sizes = await collectUninstallTreeSizes(input)
  return createUninstallPlan({
    ...input,
    // 返回副本：同步装配会就地扣减 install-dir 的字节数，别把算好的量改掉。
    statTree: (target: string) => {
      const info = sizes.get(normalizePath(target))
      return info ? { ...info } : null
    },
  })
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

  const paths = resolveUninstallPaths(input)
  const { executablePath, installDir, dataDir, legacyDataDir, dshHome, tempDir, pointerFile } = paths

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
  const { foreign, dataBlocksDir, canRemoveDir } = inspectInstallDir({ paths, dataKept, exists, readDirNames })

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
    // 安装目录里可能放着 Electron 运行时（几千个文件）：聚合成一行，别把计划刷成文件清单。
    let keptSize = 0
    let keptFiles = 0
    for (const name of foreign) {
      const info = measure(path.join(installDir, name))
      keptSize += info.sizeBytes
      keptFiles += info.fileCount
    }
    items.push({
      id: 'install-dir-keep-other',
      label: '安装目录里的其他内容（' + foreign.length + ' 项）',
      path: installDir,
      kind: 'directory',
      sizeBytes: keptSize,
      fileCount: keptFiles,
      action: 'keep',
      reason: '不属于本版启动器创建的内容，按规则保留',
    })
    const shown = foreign.slice(0, FOREIGN_ITEM_LIMIT)
    warnings.push(
      '安装目录里还有不属于本版启动器的内容（' + shown.join('、')
        + (foreign.length > shown.length ? ' 等 ' + foreign.length + ' 项' : '')
        + '）：本次只删除启动器文件，目录保留。',
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
