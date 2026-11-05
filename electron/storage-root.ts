// 启动器数据目录的解析与切换。
//
// 打包后默认落在 EXE 旁边的 launcher-data：同一台机器上放在不同文件夹的多份启动器
// 因此各自拥有独立的 userData，单实例锁与 packs 数据都不再互相干扰。
// 这个模块刻意不依赖 electron —— 解析规则要能在 node 环境里直接测，主进程只负责把
// app.getPath / process.argv 这些事实传进来，再执行 app.setPath。

import {
  existsSync as defaultExistsSync,
  mkdirSync,
  readFileSync as defaultReadFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import type { StorageSource, StorageState } from '../src/types'

export type { StorageSource } from '../src/types'

/** 打包态的数据目录名，同时也是「这份数据属于旁边那个 EXE」的标记。 */
export const STORAGE_DATA_DIRNAME = 'launcher-data'
/** 记住自定义数据目录的文件，放在 EXE 旁边（切换数据目录的唯一持久手段）。 */
export const STORAGE_POINTER_FILENAME = 'launcher-storage.json'
/** Chromium 的缓存目录名，压在数据目录下保持顶层整洁。 */
export const STORAGE_BROWSER_DATA_DIRNAME = 'browser-data'
/** 旧版启动器固定的数据目录名（%APPDATA% 下的 dsh-launcher）。 */
export const LEGACY_DATA_DIRNAME = 'dsh-launcher'

export interface StorageResolution {
  dataDir: string
  source: StorageSource
  /** EXE 所在目录（打包态）；开发态为 null。 */
  portableDir: string | null
  /** 指向 <exeDir>/launcher-storage.json；开发态为 null。 */
  pointerFile: string | null
  /** 解析过程中的告警（配置损坏、回退说明等）；没有则为 null。 */
  warning: string | null
}

export interface ResolveStorageOptions {
  isPackaged: boolean
  execPath: string
  argv: string[]
  env: Record<string, string | undefined>
  /** app.getPath('appData')：开发态默认位置与旧数据探测都从这里起算。 */
  appDataPath: string
  existsSync?: (target: string) => boolean
  readFileSync?: (target: string) => string
}

export interface StorageControllerOptions {
  resolution: StorageResolution
  appDataPath: string
  existsSync?: (target: string) => boolean
}

export interface StorageController {
  get(): StorageState
  /** 切换数据目录：校验并写指针文件，本次进程不变，重启后生效。 */
  set(dataDir: string): StorageState
  /** 删除指针文件，回到 EXE 决定的默认目录，重启后生效。 */
  reset(): StorageState
}

const SWITCH_DISABLED = '开发态不支持切换数据目录：切换要写 EXE 旁边的 launcher-storage.json，开发态没有这个文件。请改用打包后的启动器切换，或以 --data-dir <绝对路径> 启动。'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left)
  const b = path.resolve(right)
  // Windows 的路径比较不区分大小写，别把 C:\Apps 与 c:\apps 当成两份数据。
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function joinWarnings(warnings: string[]): string | null {
  return warnings.length === 0 ? null : warnings.join(' ')
}

/** EXE 所在目录：portable 运行时由 electron-builder 注入 PORTABLE_EXECUTABLE_DIR。 */
function exeDirectory(options: { execPath: string; env: Record<string, string | undefined> }): string {
  const portable = options.env.PORTABLE_EXECUTABLE_DIR?.trim()
  return portable ? portable : path.dirname(options.execPath)
}

/** EXE 决定的默认数据目录：portable/安装版落在 EXE 旁，开发态保持 %APPDATA% 下的老位置。 */
function defaultLocation(options: ResolveStorageOptions): { dataDir: string; source: 'portable' | 'install' | 'development' } {
  if (!options.isPackaged) return { dataDir: path.join(options.appDataPath, LEGACY_DATA_DIRNAME), source: 'development' }
  const portable = options.env.PORTABLE_EXECUTABLE_DIR?.trim()
  if (portable) return { dataDir: path.join(portable, STORAGE_DATA_DIRNAME), source: 'portable' }
  return { dataDir: path.join(path.dirname(options.execPath), STORAGE_DATA_DIRNAME), source: 'install' }
}

type PointerParse = { dataDir: string } | { error: string }

function parsePointer(text: string): PointerParse {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return { error: '文件不是合法的 JSON（' + errorMessage(error) + '）' }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { error: '文件内容必须是一个对象' }
  const dataDir = (value as { dataDir?: unknown }).dataDir
  if (typeof dataDir !== 'string' || dataDir.trim() === '') return { error: '缺少 dataDir 字段' }
  if (!path.isAbsolute(dataDir)) return { error: 'dataDir 不是绝对路径（' + dataDir + '）' }
  return { dataDir: path.resolve(dataDir) }
}

/** 读 --flag=<path> 或 --flag <path>；没给或给了空值返回 null。 */
function readPathArgument(argv: string[], flag: string): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === flag) {
      const next = argv[index + 1]
      return next && !next.startsWith('--') ? next : null
    }
    if (item.startsWith(flag + '=')) {
      const value = item.slice(flag.length + 1)
      return value.trim() === '' ? null : value
    }
  }
  return null
}

/**
 * 「选择数据目录」对话框的初始位置。只认绝对路径：相对路径、空串、非字符串一律忽略，
 * 由系统决定初始位置 —— 这个值只影响对话框停在哪，绝不参与数据目录解析，也不写进配置。
 */
export function defaultDialogDirectory(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  if (trimmed === '' || !path.isAbsolute(trimmed)) return undefined
  return path.resolve(trimmed)
}

export function resolveStorage(options: ResolveStorageOptions): StorageResolution {
  const existsSync = options.existsSync ?? defaultExistsSync
  const readFileSync = options.readFileSync ?? ((target: string) => defaultReadFileSync(target, 'utf8'))
  const exeDir = exeDirectory(options)
  const portableDir = options.isPackaged ? exeDir : null
  const pointerFile = options.isPackaged ? path.join(exeDir, STORAGE_POINTER_FILENAME) : null
  const warnings: string[] = []

  // 1. 命令行优先：临时换一份数据目录，不需要改任何文件。
  // --data-dir 是本项目自己的开关，优先于 Electron 的 --user-data-dir（vite 用它启动 dev Electron 做隔离）。
  for (const flag of ['--data-dir', '--user-data-dir']) {
    const argument = readPathArgument(options.argv, flag)
    if (argument === null) continue
    if (path.isAbsolute(argument)) {
      return { dataDir: path.resolve(argument), source: 'argument', portableDir, pointerFile, warning: joinWarnings(warnings) }
    }
    warnings.push('已忽略 ' + flag + '：' + argument + ' 不是绝对路径，本次仍按后面解析到的数据目录启动。')
  }

  // 2. EXE 旁边的 launcher-storage.json：界面与 CLI 切换数据目录写的就是它。
  if (pointerFile !== null && existsSync(pointerFile)) {
    let text: string | null = null
    try {
      text = readFileSync(pointerFile)
    } catch (error) {
      warnings.push('读取 ' + pointerFile + ' 失败（' + errorMessage(error) + '），已按默认数据目录启动。')
    }
    if (text !== null) {
      const parsed = parsePointer(text)
      if ('dataDir' in parsed) return { dataDir: parsed.dataDir, source: 'pointer', portableDir, pointerFile, warning: joinWarnings(warnings) }
      warnings.push('已忽略 ' + pointerFile + '：' + parsed.error + '。请删除该文件，或运行 storage reset 恢复默认数据目录。')
    }
  }

  // 3/4/5. 都没命中就由 EXE 决定：portable 与安装版落在 EXE 目录，开发态保持 %APPDATA%。
  const fallback = defaultLocation(options)
  return { dataDir: fallback.dataDir, source: fallback.source, portableDir, pointerFile, warning: joinWarnings(warnings) }
}

export function readStoragePointer(pointerFile: string, readFileSync: (target: string) => string = (target: string) => defaultReadFileSync(target, 'utf8')): string | null {
  let text: string
  try {
    text = readFileSync(pointerFile)
  } catch {
    return null
  }
  const parsed = parsePointer(text)
  return 'dataDir' in parsed ? parsed.dataDir : null
}

/** 原子写指针文件：先写唯一临时文件再 rename 覆盖，避免留下半截 JSON。 */
export function writeStoragePointer(pointerFile: string, dataDir: string): void {
  if (!path.isAbsolute(dataDir)) throw new Error('写入的数据目录必须是绝对路径，收到：' + String(dataDir))
  const target = path.resolve(dataDir)
  const directory = path.dirname(pointerFile)
  try {
    mkdirSync(directory, { recursive: true })
  } catch (error) {
    throw new Error('无法创建数据目录配置文件所在目录 ' + directory + '：' + errorMessage(error) + '。请确认启动器所在目录可写。')
  }
  const temp = pointerFile + '.' + process.pid + '.' + Date.now() + '.tmp'
  try {
    writeFileSync(temp, JSON.stringify({ dataDir: target }, null, 2) + '\n', { flag: 'wx' })
    renameSync(temp, pointerFile)
  } catch (error) {
    try {
      rmSync(temp, { force: true })
    } catch {
      // 临时文件清不掉也要把真正的错误抛出去。
    }
    throw new Error('无法写入数据目录配置 ' + pointerFile + '：' + errorMessage(error) + '。请确认该文件没有被其他程序占用后重试。')
  }
}

export function clearStoragePointer(pointerFile: string): void {
  try {
    rmSync(pointerFile, { force: true })
  } catch (error) {
    throw new Error('无法删除数据目录配置 ' + pointerFile + '：' + errorMessage(error) + '。请确认该文件没有被其他程序占用后重试。')
  }
}

/** 旧版默认目录 %APPDATA%\dsh-launcher；与当前数据目录相同时不算「旧数据」。 */
export function describeLegacyData(appDataPath: string, dataDir: string, existsSync: (target: string) => boolean = defaultExistsSync): { dataDir: string; hasData: boolean } {
  const legacyDir = path.join(appDataPath, LEGACY_DATA_DIRNAME)
  const hasData = !samePath(legacyDir, dataDir) && existsSync(path.join(legacyDir, 'packs.json'))
  return { dataDir: legacyDir, hasData }
}

/** 校验目录可用：不存在就创建，创建不了或写不进去抛中文错误。 */
export function assertWritableDirectory(dir: string): void {
  if (!path.isAbsolute(dir)) throw new Error('数据目录必须是绝对路径（例如 D:\\launcher-data），收到：' + String(dir))
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw new Error('无法创建数据目录 ' + dir + '：' + errorMessage(error) + '。请改选一个已存在且有写入权限的目录。')
  }
  const probe = path.join(dir, '.launcher-write-test-' + process.pid + '-' + Date.now())
  try {
    writeFileSync(probe, '')
  } catch (error) {
    throw new Error('数据目录 ' + dir + ' 不可写：' + errorMessage(error) + '。请改选一个有写入权限的目录，例如用户目录下的文件夹。')
  }
  try {
    rmSync(probe, { force: true })
  } catch {
    // 探测文件删不掉不影响结论，只是留下一个空文件。
  }
}

export function createStorageController(options: StorageControllerOptions): StorageController {
  let resolution = options.resolution
  let restartRequired = false

  const state = (): StorageState => ({
    dataDir: resolution.dataDir,
    source: resolution.source,
    portableDir: resolution.portableDir,
    pointerFile: resolution.pointerFile,
    legacy: describeLegacyData(options.appDataPath, resolution.dataDir, options.existsSync),
    restartRequired,
    warning: resolution.warning,
  })

  return {
    get: state,
    set(dataDir) {
      if (resolution.pointerFile === null) throw new Error(SWITCH_DISABLED)
      if (!path.isAbsolute(dataDir)) throw new Error('数据目录必须是绝对路径（例如 D:\\launcher-data），收到：' + String(dataDir))
      assertWritableDirectory(dataDir)
      writeStoragePointer(resolution.pointerFile, dataDir)
      // 本次进程仍用旧目录：所有服务在启动时就把路径绑死了。dataDir 这里表示「重启后将生效的
      // 目录」，restartRequired 才是让用户重启的信号。
      resolution = { ...resolution, dataDir: path.resolve(dataDir), source: 'pointer', warning: null }
      restartRequired = true
      return state()
    },
    reset() {
      if (resolution.pointerFile === null) throw new Error(SWITCH_DISABLED)
      clearStoragePointer(resolution.pointerFile)
      // 语义：dataDir 仍是本次进程正在用的目录（可能来自刚删掉的指针文件），重启后才回到默认。
      restartRequired = true
      return state()
    },
  }
}
