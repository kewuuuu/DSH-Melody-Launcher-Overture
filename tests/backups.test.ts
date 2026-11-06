import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSafeArchiveMembers,
  backupBeforeDelete,
  createBackupEngine,
  DEFAULT_BACKUP_LIMIT_BYTES,
  setDefaultBackupEngine,
  type BackupArchiveTool,
} from '../electron/backups'
import { uninstallInstalledSkill } from '../electron/skill-format'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-backup-'))
  roots.push(root)
  return root
}

async function makeDir(base: string, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(base, name)
  for (const [relative, body] of Object.entries(files)) {
    const target = path.join(dir, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  await mkdir(dir, { recursive: true })
  return dir
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(absolute, relative)
      else out[relative] = await readFile(absolute, 'utf8')
    }
  }
  await walk(dir, '')
  return out
}

/** 只写固定字节数的假压缩包：让容量淘汰测试不必依赖真实数据的压缩后大小。 */
function fakeTool(bytes: number): BackupArchiveTool {
  return {
    kind: 'tar',
    async create(archivePath) {
      await writeFile(archivePath, Buffer.alloc(bytes, 0x61))
    },
    async list() {
      return []
    },
    async extract() {
      return
    },
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 手写 store 方式 zip：真实压缩工具造不出带 '..' 的成员，越界样本只能自己拼。 */
function buildStoreZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, entry.data)
    centrals.push(central, name)
    offset += 30 + name.length + entry.data.length
  }
  const localBlock = Buffer.concat(locals)
  const centralBlock = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBlock.length, 12)
  end.writeUInt32LE(localBlock.length, 16)
  return Buffer.concat([localBlock, centralBlock, end])
}

afterEach(async () => {
  setDefaultBackupEngine(null)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('备份区引擎', () => {
  it('真实 tar 往返：备份、破坏、恢复到内容一致', async () => {
    const root = await makeRoot()
    const dir = await makeDir(root, 'packs', { 'a.txt': '甲', 'nested/b.txt': '乙' })
    const engine = createBackupEngine({ root })

    const entry = await engine.create({ paths: [dir], label: '示例整合包', op: 'pack.delete', packId: 'demo' })
    expect(entry.op).toBe('pack.delete')
    expect(entry.label).toBe('示例整合包')
    expect(entry.packId).toBe('demo')
    expect(entry.fileCount).toBe(2)
    expect(entry.sizeBytes).toBeGreaterThan(0)
    expect(entry.locked).toBe(false)
    expect(entry.origin).toEqual([dir])
    expect(entry.archivePath).toBe(path.join(root, 'backups', entry.id + '.zip'))
    expect(existsSync(entry.archivePath)).toBe(true)

    const before = await readTree(dir)
    await rm(dir, { recursive: true, force: true })
    await makeDir(dir, '', {})
    await writeFile(path.join(dir, 'junk.txt'), '垃圾文件')

    const overview = await engine.restore(entry.id)
    expect(await readTree(dir)).toEqual(before)
    expect(existsSync(path.join(dir, 'junk.txt'))).toBe(false)
    expect(typeof overview.entries[0]?.restoredAt).toBe('number')
    const staging = (await readdir(path.join(root, 'backups'))).filter(name => name.startsWith('.restore-'))
    expect(staging).toEqual([])
  })

  it('超限时按最久未锁定优先淘汰，锁定条目和 unchecked 容量都不动它', async () => {
    const root = await makeRoot()
    const dirs: string[] = []
    for (let index = 0; index < 3; index += 1) dirs.push(await makeDir(root, 'src' + index, { ['f' + index + '.txt']: '内容' + index }))
    let clock = 1_000
    const engine = createBackupEngine({ root, tools: fakeTool(1_000), now: () => (clock += 1_000) })

    const entries = []
    for (const dir of dirs) entries.push(await engine.create({ paths: [dir], label: path.basename(dir), op: 'manual' }))
    expect(DEFAULT_BACKUP_LIMIT_BYTES).toBe(2147483648)

    let overview = await engine.setLimit(2_500)
    expect(overview.limitBytes).toBe(2_500)
    expect(overview.totalBytes).toBe(2_000)
    expect(overview.entries.map(item => item.id).sort()).toEqual([entries[1]!.id, entries[2]!.id].sort())
    expect(existsSync(entries[0]!.archivePath)).toBe(false)
    expect(existsSync(entries[1]!.archivePath)).toBe(true)

    const settings = JSON.parse(await readFile(path.join(root, 'backup-settings.json'), 'utf8')) as { limitBytes: number }
    expect(settings.limitBytes).toBe(2_500)

    await engine.setLocked(entries[2]!.id, true)
    overview = await engine.setLimit(1_500)
    expect(overview.entries.map(item => item.id)).toEqual([entries[2]!.id])
    expect(overview.entries[0]?.locked).toBe(true)
    expect(existsSync(entries[1]!.archivePath)).toBe(false)
    expect(existsSync(entries[2]!.archivePath)).toBe(true)

    overview = await engine.setLimit(0)
    expect(overview.entries).toHaveLength(1)
  })

  it('locked 与解锁都落到 index.json，删掉的备份条目一起消失', async () => {
    const root = await makeRoot()
    const dir = await makeDir(root, 'one', { 'a.txt': 'a' })
    const engine = createBackupEngine({ root, tools: fakeTool(10) })
    const entry = await engine.create({ paths: [dir], label: '单条', op: 'manual' })

    let overview = await engine.setLocked(entry.id, true)
    expect(overview.entries[0]?.locked).toBe(true)
    let index = JSON.parse(await readFile(path.join(root, 'backups', 'index.json'), 'utf8')) as { entries: { locked: boolean }[] }
    expect(index.entries[0]?.locked).toBe(true)

    overview = await engine.setLocked(entry.id, false)
    expect(overview.entries[0]?.locked).toBe(false)
    index = JSON.parse(await readFile(path.join(root, 'backups', 'index.json'), 'utf8')) as { entries: { locked: boolean }[] }
    expect(index.entries[0]?.locked).toBe(false)

    overview = await engine.remove(entry.id)
    expect(overview.entries).toEqual([])
    expect(existsSync(entry.archivePath)).toBe(false)
    await expect(engine.restore(entry.id)).rejects.toThrow(/没有找到这条备份/)
    await expect(engine.setLimit(-1)).rejects.toThrow(/容量上限/)
  })

  it('目标整合包正在运行时拒接恢复，且一个字节都不写', async () => {
    const root = await makeRoot()
    const dir = await makeDir(root, 'packs-p1', { 'a.txt': '原始内容' })
    const engine = createBackupEngine({
      root,
      isPackRunning: packId => packId === 'p1',
      packLabel: () => '星海整合包',
    })
    const entry = await engine.create({ paths: [dir], label: '星海整合包', op: 'pack.delete', packId: 'p1' })
    await writeFile(path.join(dir, 'a.txt'), '现场内容')

    await expect(engine.restore(entry.id)).rejects.toThrow('整合包 星海整合包 正在运行，请先停止再恢复')
    expect(await readFile(path.join(dir, 'a.txt'), 'utf8')).toBe('现场内容')
    expect((await readdir(path.join(root, 'backups'))).filter(name => name.startsWith('.restore-'))).toEqual([])
  })

  it('压缩包里的路径穿越被拒，解压不越过目标根', async () => {
    expect(() => assertSafeArchiveMembers(['/abs.txt'], ['packs'])).toThrow(/越界/)
    expect(() => assertSafeArchiveMembers(['C:/Windows/x'], ['packs'])).toThrow(/越界/)
    expect(() => assertSafeArchiveMembers(['packs/../../x'], ['packs'])).toThrow(/越界/)
    expect(() => assertSafeArchiveMembers(['other/x'], ['packs'])).toThrow(/越界/)
    expect(() => assertSafeArchiveMembers(['packs', 'packs/a.txt'], ['packs'])).not.toThrow()

    const root = await makeRoot()
    const target = await makeDir(root, 'restore', {})
    const origin = path.join(target, 'packs')
    await mkdir(origin, { recursive: true })
    await writeFile(path.join(origin, 'ok.txt'), '正常')
    const archiveDir = path.join(root, 'backups')
    await mkdir(archiveDir, { recursive: true })
    const archivePath = path.join(archiveDir, 'evil.zip')
    await writeFile(archivePath, buildStoreZip([
      { name: 'packs/ok.txt', data: Buffer.from('正常') },
      { name: '../evil.txt', data: Buffer.from('逃逸') },
    ]))
    await writeFile(path.join(archiveDir, 'index.json'), JSON.stringify({
      version: 1,
      entries: [{
        id: 'evil',
        op: 'manual',
        label: '恶意包',
        createdAt: 1,
        sizeBytes: 1,
        fileCount: 1,
        locked: false,
        origin: [origin],
        archivePath,
      }],
    }))

    const engine = createBackupEngine({ root })
    await expect(engine.restore('evil')).rejects.toThrow(/越界/)
    expect(existsSync(path.join(archiveDir, 'evil.txt'))).toBe(false)
    expect(existsSync(path.join(root, 'evil.txt'))).toBe(false)
    expect(await readFile(path.join(origin, 'ok.txt'), 'utf8')).toBe('正常')
  })

  it('并发创建时 index.json 不丢条目，也不留临时文件', async () => {
    const root = await makeRoot()
    const dirs: string[] = []
    for (let index = 0; index < 6; index += 1) dirs.push(await makeDir(root, 'src' + index, { ['f' + index + '.txt']: 'x' }))
    const engine = createBackupEngine({ root, tools: fakeTool(10) })

    const entries = await Promise.all(dirs.map(dir => engine.create({ paths: [dir], label: path.basename(dir), op: 'manual' })))
    expect(new Set(entries.map(entry => entry.id)).size).toBe(6)
    const index = JSON.parse(await readFile(path.join(root, 'backups', 'index.json'), 'utf8')) as { entries: { id: string }[] }
    expect(index.entries).toHaveLength(6)
    const leftovers = (await readdir(path.join(root, 'backups'))).filter(name => name !== 'index.json' && !name.endsWith('.zip'))
    expect(leftovers).toEqual([])
    const overview = await engine.list()
    expect(overview.entries).toHaveLength(6)
    expect(overview.totalBytes).toBe(60)
  })

  it('删除 hook：备份失败就中止 skill 卸载，成功后先有备份再删', async () => {
    const root = await makeRoot()
    const home = path.join(root, 'dsh-home')
    const skillDir = path.join(home, 'skills', 'demo-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 演示技能\n---\n正文\n')

    const broken = createBackupEngine({
      root,
      tools: {
        kind: 'tar',
        async create() {
          throw new Error('磁盘已满')
        },
        async list() {
          return []
        },
        async extract() {
          return
        },
      },
    })
    setDefaultBackupEngine(broken)
    await expect(uninstallInstalledSkill(home, 'demo-skill')).rejects.toThrow(/备份「demo-skill」失败，已阻止删除：磁盘已满/)
    expect(existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true)
    expect(existsSync(path.join(skillDir, 'SKILL.md.partial.zip'))).toBe(false)

    const working = createBackupEngine({ root })
    setDefaultBackupEngine(working)
    expect(await uninstallInstalledSkill(home, 'demo-skill')).toEqual([])
    expect(existsSync(skillDir)).toBe(false)
    const overview = await working.list()
    expect(overview.entries).toHaveLength(1)
    expect(overview.entries[0]?.op).toBe('skill.delete')
    expect(overview.entries[0]?.origin).toEqual([skillDir])
  })

  it('没有注入引擎时拒绝放行，调用方的删除不执行', async () => {
    const root = await makeRoot()
    const home = path.join(root, 'dsh-home')
    const skillDir = path.join(home, 'skills', 'demo-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo-skill\ndescription: 演示技能\n---\n正文\n')

    setDefaultBackupEngine(null)
    await expect(backupBeforeDelete({ paths: [skillDir], label: '示例技能', op: 'skill.delete' })).rejects.toThrow('备份引擎尚未就绪，已阻止删除：示例技能')
    await expect(uninstallInstalledSkill(home, 'demo-skill')).rejects.toThrow(/备份引擎尚未就绪，已阻止删除：demo-skill/)
    expect(existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true)
    expect(await readdir(path.join(home, 'skills'))).toEqual(['demo-skill'])

    const engine = createBackupEngine({ root, tools: fakeTool(10) })
    setDefaultBackupEngine(engine)
    expect(await uninstallInstalledSkill(home, 'demo-skill')).toEqual([])
    expect(existsSync(skillDir)).toBe(false)
    expect((await engine.list()).entries).toHaveLength(1)
  })
})
