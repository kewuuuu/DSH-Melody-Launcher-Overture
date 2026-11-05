import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertWritableDirectory,
  clearStoragePointer,
  createStorageController,
  defaultDialogDirectory,
  describeLegacyData,
  readStoragePointer,
  resolveStorage,
  STORAGE_POINTER_FILENAME,
  writeStoragePointer,
  type ResolveStorageOptions,
} from '../electron/storage-root'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temporary(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'launcher-storage-'))
  cleanups.push(dir)
  return dir
}

interface Fixture {
  options: ResolveStorageOptions
  exeDir: string
  appDataPath: string
  pointerFile: string
}

function fixture(overrides: Partial<ResolveStorageOptions> = {}, portable = false): Fixture {
  const exeDir = temporary()
  const appDataPath = temporary()
  const options: ResolveStorageOptions = {
    isPackaged: true,
    execPath: path.join(exeDir, 'dsh-launcher.exe'),
    argv: [],
    env: portable ? { PORTABLE_EXECUTABLE_DIR: exeDir } : {},
    appDataPath,
    ...overrides,
  }
  return { options, exeDir, appDataPath, pointerFile: path.join(exeDir, STORAGE_POINTER_FILENAME) }
}

describe('resolveStorage', () => {
  it('打包且 portable 时把数据目录放在 EXE 旁的 launcher-data', () => {
    const { options, exeDir, pointerFile } = fixture({}, true)
    const resolution = resolveStorage(options)
    expect(resolution.source).toBe('portable')
    expect(resolution.dataDir).toBe(path.join(exeDir, 'launcher-data'))
    expect(resolution.portableDir).toBe(exeDir)
    expect(resolution.pointerFile).toBe(pointerFile)
    expect(resolution.warning).toBeNull()
  })

  it('打包但非 portable（安装版）同样落在 EXE 旁，来源是 install', () => {
    const { options, exeDir } = fixture()
    const resolution = resolveStorage(options)
    expect(resolution.source).toBe('install')
    expect(resolution.dataDir).toBe(path.join(exeDir, 'launcher-data'))
    expect(resolution.portableDir).toBe(exeDir)
  })

  it('launcher-storage.json 覆盖 portable 默认值', () => {
    const target = temporary()
    const { options, pointerFile } = fixture({}, true)
    writeFileSync(pointerFile, JSON.stringify({ dataDir: target }))
    const resolution = resolveStorage(options)
    expect(resolution.source).toBe('pointer')
    expect(resolution.dataDir).toBe(target)
    expect(resolution.pointerFile).toBe(pointerFile)
  })

  it('--data-dir 覆盖 launcher-storage.json', () => {
    const pointerTarget = temporary()
    const argumentTarget = temporary()
    const { options, pointerFile } = fixture({}, true)
    writeFileSync(pointerFile, JSON.stringify({ dataDir: pointerTarget }))
    const resolution = resolveStorage({ ...options, argv: ['--data-dir=' + argumentTarget] })
    expect(resolution.source).toBe('argument')
    expect(resolution.dataDir).toBe(argumentTarget)
  })

  it('--data-dir 也接受两个参数的形式', () => {
    const argumentTarget = temporary()
    const { options } = fixture()
    const resolution = resolveStorage({ ...options, argv: ['--no-sandbox', '--data-dir', argumentTarget] })
    expect(resolution.source).toBe('argument')
    expect(resolution.dataDir).toBe(argumentTarget)
  })

  it('非绝对路径的 --data-dir 被忽略并留下告警', () => {
    const { options, exeDir } = fixture({}, true)
    const resolution = resolveStorage({ ...options, argv: ['--data-dir', 'relative/data'] })
    expect(resolution.source).toBe('portable')
    expect(resolution.dataDir).toBe(path.join(exeDir, 'launcher-data'))
    expect(resolution.warning).toContain('--data-dir')
    expect(resolution.warning).toContain('不是绝对路径')
  })

  it.each([
    ['{ 这不是 JSON', '不是合法的 JSON'],
    ['[]', '必须是一个对象'],
    ['{"dataDir":"relative/dir"}', '不是绝对路径'],
    ['{"other":1}', '缺少 dataDir 字段'],
  ])('损坏的 launcher-storage.json 被忽略并留下告警：%s', (text, expected) => {
    const { options, exeDir, pointerFile } = fixture({}, true)
    writeFileSync(pointerFile, text)
    const resolution = resolveStorage(options)
    expect(resolution.source).toBe('portable')
    expect(resolution.dataDir).toBe(path.join(exeDir, 'launcher-data'))
    expect(resolution.warning).toContain(expected)
    expect(resolution.warning).toContain('storage reset')
  })

  it('开发态用 <appData>/dsh-launcher，不提供指针文件也不读 EXE 旁的配置', () => {
    const { options, exeDir, appDataPath } = fixture({ isPackaged: false }, true)
    writeFileSync(path.join(exeDir, STORAGE_POINTER_FILENAME), JSON.stringify({ dataDir: temporary() }))
    const resolution = resolveStorage({ ...options, env: {}, argv: [] })
    expect(resolution.source).toBe('development')
    expect(resolution.dataDir).toBe(path.join(appDataPath, 'dsh-launcher'))
    expect(resolution.portableDir).toBeNull()
    expect(resolution.pointerFile).toBeNull()
    expect(resolution.warning).toBeNull()
  })

  it('开发态的 --data-dir 仍然生效，且不写任何指针文件', () => {
    const argumentTarget = temporary()
    const { options, exeDir } = fixture({ isPackaged: false })
    const resolution = resolveStorage({ ...options, argv: ['--data-dir=' + argumentTarget] })
    expect(resolution.source).toBe('argument')
    expect(resolution.dataDir).toBe(argumentTarget)
    expect(resolution.portableDir).toBeNull()
    expect(resolution.pointerFile).toBeNull()
    expect(existsSync(path.join(exeDir, STORAGE_POINTER_FILENAME))).toBe(false)
  })

  it('开发态把 --user-data-dir 当作数据目录（vite 的 dev 隔离），来源是 argument', () => {
    const devUserData = temporary()
    const { options } = fixture({ isPackaged: false })
    const resolution = resolveStorage({ ...options, argv: ['--no-sandbox', '--user-data-dir=' + devUserData] })
    expect(resolution.source).toBe('argument')
    expect(resolution.dataDir).toBe(devUserData)
    expect(resolution.portableDir).toBeNull()
    expect(resolution.pointerFile).toBeNull()
  })

  it('--data-dir 与 --user-data-dir 同时出现时 --data-dir 生效', () => {
    const userDataDir = temporary()
    const dataDir = temporary()
    const { options } = fixture({ isPackaged: false })
    const resolution = resolveStorage({ ...options, argv: ['--user-data-dir=' + userDataDir, '--data-dir', dataDir] })
    expect(resolution.source).toBe('argument')
    expect(resolution.dataDir).toBe(dataDir)
    expect(resolution.warning).toBeNull()
  })
})

describe('defaultDialogDirectory', () => {
  it('只接受绝对路径，其余一律忽略', () => {
    const absolute = temporary()
    expect(defaultDialogDirectory(absolute)).toBe(path.resolve(absolute))
    expect(defaultDialogDirectory('  ' + absolute + '  ')).toBe(path.resolve(absolute))
    expect(defaultDialogDirectory('relative/dir')).toBeUndefined()
    expect(defaultDialogDirectory('')).toBeUndefined()
    expect(defaultDialogDirectory('   ')).toBeUndefined()
    expect(defaultDialogDirectory(undefined)).toBeUndefined()
    expect(defaultDialogDirectory(42)).toBeUndefined()
  })
})

describe('指针文件读写', () => {
  it('写入后能读回，删除后读不到', () => {
    const root = temporary()
    const pointerFile = path.join(root, STORAGE_POINTER_FILENAME)
    const target = temporary()
    writeStoragePointer(pointerFile, target)
    expect(readStoragePointer(pointerFile)).toBe(target)
    expect(JSON.parse(readFileSync(pointerFile, 'utf8'))).toEqual({ dataDir: target })
    clearStoragePointer(pointerFile)
    expect(existsSync(pointerFile)).toBe(false)
    expect(readStoragePointer(pointerFile)).toBeNull()
    expect(() => clearStoragePointer(pointerFile)).not.toThrow()
  })

  it('拒绝写入相对路径', () => {
    expect(() => writeStoragePointer(path.join(temporary(), STORAGE_POINTER_FILENAME), 'relative/dir')).toThrow(/绝对路径/)
  })
})

describe('assertWritableDirectory', () => {
  it('创建缺失的目录且不留下探测文件', () => {
    const target = path.join(temporary(), 'nested', 'launcher-data')
    assertWritableDirectory(target)
    expect(existsSync(target)).toBe(true)
    expect(readdirSync(target)).toEqual([])
  })

  it('对不可写路径抛中文错误', () => {
    const blocker = path.join(temporary(), 'blocker.txt')
    writeFileSync(blocker, '')
    expect(() => assertWritableDirectory(path.join(blocker, 'nested'))).toThrow(/无法创建数据目录/)
  })

  it('拒绝相对路径', () => {
    expect(() => assertWritableDirectory('relative/data')).toThrow(/绝对路径/)
  })
})

describe('describeLegacyData', () => {
  it('旧目录里有 packs.json 时 hasData 为 true', () => {
    const appDataPath = temporary()
    mkdirSync(path.join(appDataPath, 'dsh-launcher'), { recursive: true })
    writeFileSync(path.join(appDataPath, 'dsh-launcher', 'packs.json'), '{}')
    const legacy = describeLegacyData(appDataPath, path.join(appDataPath, 'launcher-data'))
    expect(legacy.dataDir).toBe(path.join(appDataPath, 'dsh-launcher'))
    expect(legacy.hasData).toBe(true)
  })

  it('旧目录就是当前数据目录时 hasData 为 false', () => {
    const appDataPath = temporary()
    const legacyDir = path.join(appDataPath, 'dsh-launcher')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(path.join(legacyDir, 'packs.json'), '{}')
    expect(describeLegacyData(appDataPath, legacyDir).hasData).toBe(false)
    // 末尾多一个分隔符也是同一个目录，不该被当成「另一份旧数据」。
    expect(describeLegacyData(appDataPath, legacyDir + path.sep).hasData).toBe(false)
  })

  it('旧目录不存在时 hasData 为 false', () => {
    const appDataPath = temporary()
    expect(describeLegacyData(appDataPath, path.join(appDataPath, 'launcher-data')).hasData).toBe(false)
  })
})

describe('createStorageController', () => {
  it('切换数据目录会写指针文件并把 restartRequired 置为 true', () => {
    const { options, pointerFile, appDataPath } = fixture({}, true)
    const controller = createStorageController({ resolution: resolveStorage(options), appDataPath })
    const target = temporary()
    expect(controller.get().restartRequired).toBe(false)
    const next = controller.set(target)
    expect(next.dataDir).toBe(target)
    expect(next.source).toBe('pointer')
    expect(next.restartRequired).toBe(true)
    expect(next.warning).toBeNull()
    expect(readStoragePointer(pointerFile)).toBe(target)
  })

  it('reset 删掉指针文件并保留本次进程正在用的目录', () => {
    const { options, pointerFile, appDataPath } = fixture({}, true)
    const controller = createStorageController({ resolution: resolveStorage(options), appDataPath })
    const target = temporary()
    controller.set(target)
    const after = controller.reset()
    expect(after.restartRequired).toBe(true)
    // 语义：dataDir 仍是本次进程正在用的目录，重启后才回到 EXE 旁的默认位置。
    expect(after.dataDir).toBe(target)
    expect(existsSync(pointerFile)).toBe(false)
  })

  it('开发态拒绝切换与重置', () => {
    const { options, appDataPath } = fixture({ isPackaged: false })
    const controller = createStorageController({ resolution: resolveStorage(options), appDataPath })
    expect(controller.get().pointerFile).toBeNull()
    expect(() => controller.set(temporary())).toThrow(/开发态不支持切换数据目录/)
    expect(() => controller.reset()).toThrow(/开发态不支持切换数据目录/)
  })

  it('状态里带上旧版目录的探测结果和解析告警', () => {
    const { options, appDataPath } = fixture({}, true)
    mkdirSync(path.join(appDataPath, 'dsh-launcher'), { recursive: true })
    writeFileSync(path.join(appDataPath, 'dsh-launcher', 'packs.json'), '{}')
    const controller = createStorageController({ resolution: resolveStorage({ ...options, argv: ['--data-dir', 'relative/data'] }), appDataPath })
    const state = controller.get()
    expect(state.legacy).toEqual({ dataDir: path.join(appDataPath, 'dsh-launcher'), hasData: true })
    expect(state.warning).toContain('不是绝对路径')
  })
})
