import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setDefaultBackupEngine, type BackupEngine } from '../electron/backups'

/** 删除链路会先备份；这些用例测的是删除本身，注入一个不落盘的桩引擎。 */
const backupStub = {
  create: async (input: { label: string; op?: string; paths: string[] }) => ({
    id: 'stub-backup',
    op: input.op ?? 'manual',
    label: input.label,
    createdAt: 0,
    sizeBytes: 0,
    fileCount: 0,
    locked: false,
    origin: input.paths,
    archivePath: 'stub.zip',
  }),
} as unknown as BackupEngine

beforeEach(() => {
  setDefaultBackupEngine(backupStub)
})

afterEach(() => {
  setDefaultBackupEngine(null)
})
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readdir } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createPackControl } from '../electron/pack-control'
import * as atomic from '../electron/fs-atomic'
import { createLauncherControl } from '../electron/launcher-control'
import { writePackRegistry, type PackRecord } from '../electron/pack-registry'
import type { AppSettings, RuntimeState } from '../src/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))) })
type FixtureRuntimeHooks = {
  isElevated?: () => Promise<boolean>
  spawnElevatedProcess?: typeof import('../electron/elevated-runtime').spawnElevatedRuntime
}
async function fixture(real = false, extra: FixtureRuntimeHooks = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-control-test-')); roots.push(root)
  const records = ['a', 'b'].map(id => ({ id, name: id, description: '', version: '1', homePath: path.join(root, id), source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] }) as PackRecord)
  for (const r of records) await mkdir(r.homePath!, { recursive: true })
  const registryPath = path.join(root, 'packs.json'); await writePackRegistry(registryPath, records)
  const settings: AppSettings = { dshHome: path.join(root, 'default'), dshInstallPath: root, profileName: 'web', launchExecutable: 'dsh', launchArgs: ['web'], webPort: 45321, workspace: root, openAfterLaunch: false, activePackId: 'a' }
  const script = path.join(root, 'fixture.cjs')
  await writeFile(script, "const net=require('node:net'); const port=Number(process.argv[process.argv.indexOf('--port')+1]); const server=net.createServer(s=>s.end(process.env.DSH_HOME)); server.listen(port,'127.0.0.1',()=>console.log('http://127.0.0.1:'+port));")
  const spawned: Array<{ home: string; args: string[] }> = []
  let pid = 1000
  const control = createPackControl({
    userData: root, registryPath, readSettings: async () => settings,
    resolveSettings: async (r,c) => ({ ...settings, dshHome: r.homePath!, webPort: c.port }),
    runtimeOptions: () => ({ ...extra, prepareNodeRuntime: async () => ({ node: process.execPath, npm: 'npm', npx: 'npx', root, managed: false }), fallbackWorkspace: () => root, emitOutput: () => undefined, emitState: () => undefined, openExternal: () => undefined,
      spawnProcess: (_exe,args,options) => {
        spawned.push({ home: options.env.DSH_HOME!, args })
        if (real) return spawn(process.execPath, [script, ...args], { cwd: root, env: options.env, stdio: 'pipe' }) as ChildProcessWithoutNullStreams
        const child = new EventEmitter() as ChildProcessWithoutNullStreams
        Object.assign(child, { pid: pid++, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
        return child
      },
      stopProcess: async child => { if (real) { child.kill(); await new Promise<void>(resolve => child.once('exit', () => resolve())) } else child.emit('exit', 0) },
    }), openExternal: async () => undefined,
    // 外部进程探测在测试里必须注入：真实实现会起 PowerShell 甚至 taskkill。
    externalRuntime: { scan: async () => new Map(), stop: async (): Promise<'taskkill'> => 'taskkill' },
  })
  return { root, control, settings, spawned }
}

function runtimeChild(pid: number): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams
  Object.assign(child, { pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
  return child
}

describe('explicit pack control', () => {
  it('runs real fixture servers independently and retains the second connection after stop/restart', async () => {
    const { control, root } = await fixture(true)
    async function states() { return (await control.execute({ command: 'pack.list' }) as { packs: Array<{ id: string; runtime: RuntimeState }> }).packs }
    async function homeAt(port: number) { return new Promise<string>((resolve, reject) => { let text = ''; const socket = connect(port, '127.0.0.1'); socket.on('data', chunk => { text += chunk }); socket.on('end', () => resolve(text)); socket.on('error', reject) }) }
    try {
      await Promise.all(['a','b'].map(packId => control.execute({ command: 'pack.start', packId })))
      await vi.waitFor(async () => expect((await states()).every(p => p.runtime.url)).toBe(true))
      let list = await states()
      expect(await homeAt(list[0].runtime.port!)).toBe(path.join(root, 'a'))
      expect(await homeAt(list[1].runtime.port!)).toBe(path.join(root, 'b'))
      const bPid = list[1].runtime.pid
      await control.execute({ command: 'pack.restart', packId: 'a' })
      await vi.waitFor(async () => expect((await states())[0].runtime.url).toBeTruthy())
      await control.execute({ command: 'pack.stop', packId: 'a' })
      list = await states(); expect(list[1].runtime.pid).toBe(bPid)
      expect(await homeAt(list[1].runtime.port!)).toBe(path.join(root, 'b'))
    } finally { await control.shutdown() }
  })
  it('starts two isolated homes concurrently, guards duplicate start, restarts and stops only its target', async () => {
    const { control, settings, spawned } = await fixture()
    try {
      const [a,b] = await Promise.all([control.execute({ command: 'pack.start', packId: 'a' }), control.execute({ command: 'pack.start', packId: 'b' })]) as RuntimeState[]
      expect(a.running && b.running).toBe(true); expect(a.port).not.toBe(b.port)
      expect(spawned[0].home).not.toBe(spawned[1].home)
      await Promise.all([control.execute({ command: 'pack.start', packId: 'a' }), control.execute({ command: 'pack.start', packId: 'a' })])
      expect(spawned).toHaveLength(2)
      await control.execute({ command: 'pack.restart', packId: 'a' }); expect(spawned).toHaveLength(3)
      await control.execute({ command: 'pack.stop', packId: 'a' })
      const list = await control.execute({ command: 'pack.list' }) as { packs: Array<{ id: string; runtime: RuntimeState }> }
      expect(list.packs.find(p => p.id === 'b')?.runtime.running).toBe(true)
      expect(list.packs.find(p => p.id === 'a')?.runtime.running).toBe(false)
      expect(settings.activePackId).toBe('a')
    } finally { await control.shutdown() }
  })
  it('rejects busy fixed ports and automatically falls back', async () => {
    const { control } = await fixture()
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await control.execute({ command: 'pack.config.set', packId: 'a', args: { portMode: 'fixed', port } })
      await expect(control.execute({ command: 'pack.start', packId: 'a' })).rejects.toThrow(/端口/)
      await control.execute({ command: 'pack.config.set', packId: 'a', args: { portMode: 'auto' } })
      const state = await control.execute({ command: 'pack.start', packId: 'a' }) as RuntimeState
      expect(state.port).not.toBe(port)
    } finally { await control.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('persists concurrent configuration patches without loss and invalid packs never spawn or write', async () => {
    const { control, root, spawned } = await fixture()
    await Promise.all([control.execute({ command: 'pack.config.set', packId: 'a', args: { autoStart: true } }), control.execute({ command: 'pack.config.set', packId: 'a', args: { port: 45444 } }), control.execute({ command: 'pack.config.set', packId: 'b', args: { pinnedAt: '2026-01-01T00:00:00Z' } })])
    const stored = JSON.parse(await readFile(path.join(root, 'pack-control.json'), 'utf8'))
    expect(stored.a.autoStart).toBe(true); expect(stored.a.port).toBe(45444); expect(stored.b.pinnedAt).toBeTruthy()
    const before = await readFile(path.join(root, 'pack-control.json'), 'utf8')
    await expect(control.execute({ command: 'pack.start', packId: '../missing' })).rejects.toThrow('Unknown pack')
    await expect(control.execute({ command: 'pack.config.set', packId: 'missing', args: { port: 2 } })).rejects.toThrow('Unknown pack')
    expect(spawned).toHaveLength(0); expect(await readFile(path.join(root, 'pack-control.json'), 'utf8')).toBe(before)
    await expect(control.execute({ command: 'pack.config.set', packId: 'a', args: { port: '123' } })).rejects.toThrow('Invalid port')
  })
  it('shares plugins by reference with provenance and refuses removing an in-use source', async () => {
    const { control, root } = await fixture()
    const source = path.join(root, 'a', 'profiles', 'web', 'node_modules', 'fixture-plugin')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }))
    await control.execute({ command: 'pack.resources.link', packId: 'b', args: { kind: 'plugins', name: 'fixture-plugin', sourcePackId: 'a' } })
    const list = await control.execute({ command: 'pack.resources.list', packId: 'b', args: { kind: 'plugins' } }) as { items: Array<{ packageName: string; shared: boolean; sourcePackId: string }> }
    expect(list.items.find(i => i.packageName === 'fixture-plugin')).toMatchObject({ shared: true, sourcePackId: 'a' })
    await expect(control.execute({ command: 'pack.delete', packId: 'a' })).rejects.toThrow('Unlink shared references')
    await control.execute({ command: 'pack.resources.remove', packId: 'b', args: { kind: 'plugins', name: 'fixture-plugin' } })
    expect(JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).name).toBe('fixture-plugin')
  })
  it('rolls back plugin links and manifest if recording provenance fails', async () => {
    const { control, root } = await fixture()
    const source = path.join(root, 'a', 'profiles', 'web', 'node_modules', 'fixture-plugin')
    const dest = path.join(root, 'b', 'profiles', 'web', 'node_modules', 'fixture-plugin')
    const manifestPath = path.join(root, 'b', 'profiles', 'web', 'package.json')
    await mkdir(source, { recursive: true }); await mkdir(path.dirname(manifestPath), { recursive: true })
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0' }))
    const original = JSON.stringify({ name: 'fixture', dependencies: {}, dsh: { profile: { bundles: [] } } }); await writeFile(manifestPath, original)
    const write = atomic.writeFileAtomic
    const spy = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async (file, ...args) => { if (file.includes('.launcher-shared-')) throw new Error('Fixture provenance write failed'); return write(file, ...args) })
    try {
      await expect(control.execute({ command: 'pack.resources.link', packId: 'b', args: { kind: 'plugins', name: 'fixture-plugin', sourcePackId: 'a' } })).rejects.toThrow('Fixture provenance')
      expect(await readFile(manifestPath, 'utf8')).toBe(original)
      await expect(lstat(dest)).rejects.toThrow()
    } finally { spy.mockRestore() }
  })
  it('resolves the pack profile by id without selecting it globally', async () => {
    const { root, settings } = await fixture()
    const home = path.join(root, 'b')
    await mkdir(path.join(home, 'profiles', 'b'), { recursive: true })
    await writeFile(path.join(home, 'profiles', 'b', 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' }, dsh: { profile: { bundles: ['fixture-plugin'] } } }))
    const save = vi.fn()
    const control = createLauncherControl({ userData: root, cliPath: path.join(root, 'cli.cjs'), settings: { readStored: async () => settings, read: async () => settings, save }, packManager: {} as never, prepareNodeRuntime: vi.fn(), preparePnpmRuntime: vi.fn(), openExternal: vi.fn(), fallbackWorkspace: () => root, fetchImpl: fetch, emitOutput: () => undefined, loginRegistration: vi.fn(), storage: { get: () => ({ dataDir: root, source: 'install' as const, portableDir: root, pointerFile: null, legacy: { dataDir: root, hasData: false }, restartRequired: false, warning: null }), set: vi.fn(), reset: vi.fn() }, legacyRuntimeRunning: () => false })
    const list = await control.execute({ command: 'pack.resources.list', packId: 'b', args: { kind: 'plugins' } }) as { items: Array<{ packageName: string }> }
    expect(list.items.some(i => i.packageName === 'fixture-plugin')).toBe(true)
    expect(save).not.toHaveBeenCalled(); expect(settings.activePackId).toBe('a')
  })
  it('shares flat skills as file references and removes only the target link', async () => {
    const { control, root } = await fixture()
    const sourceRoot = path.join(root, 'a', 'skills'); await mkdir(sourceRoot, { recursive: true })
    const source = path.join(sourceRoot, 'flat-skill.md')
    await writeFile(source, '---\nname: flat-skill\ndescription: Fixture\n---\nFlat')
    await control.execute({ command: 'pack.resources.link', packId: 'b', args: { kind: 'skills', name: 'flat-skill', sourcePackId: 'a' } })
    const list = await control.execute({ command: 'pack.resources.list', packId: 'b', args: { kind: 'skills' } }) as { items: Array<{ name: string; shared: boolean; format: string }> }
    expect(list.items[0]).toMatchObject({ name: 'flat-skill', shared: true, format: 'flat' })
    await control.execute({ command: 'pack.resources.remove', packId: 'b', args: { kind: 'skills', name: 'flat-skill' } })
    expect(await readFile(source, 'utf8')).toContain('Flat')
  })
  it('links skills with provenance and unlinks without removing source', async () => {
    const { control, root } = await fixture()
    const source = path.join(root, 'a', 'skills', 'shared-skill'); await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: shared-skill\ndescription: Fixture\n---\nHello')
    await control.execute({ command: 'pack.resources.link', packId: 'b', args: { kind: 'skills', name: 'shared-skill', sourcePackId: 'a' } })
    const list = await control.execute({ command: 'pack.resources.list', packId: 'b', args: { kind: 'skills' } }) as { items: Array<{ shared: boolean; sourcePackId: string }> }
    expect(list.items[0]).toMatchObject({ shared: true, sourcePackId: 'a' })
    await expect(control.execute({ command: 'pack.resources.enabled', packId: 'a', args: { kind: 'skills', name: 'shared-skill', enabled: false } })).rejects.toThrow('Unlink shared references')
    await expect(control.assertPackRemovable('a')).rejects.toThrow('Unlink shared references')
    await control.execute({ command: 'pack.resources.remove', packId: 'b', args: { kind: 'skills', name: 'shared-skill' } })
    expect(await readFile(path.join(source, 'SKILL.md'), 'utf8')).toContain('Hello')
  })
  it('reads a config file saved with a BOM instead of failing the whole pack list', async () => {
    const { root, control } = await fixture()
    await writeFile(path.join(root, 'pack-control.json'), '\uFEFF' + JSON.stringify({ a: { portMode: 'fixed', port: 46100 } }))
    const list = await control.execute({ command: 'pack.list' }) as { packs: Array<{ id: string; config: { portMode: string; port: number } }> }
    expect(list.packs.find(p => p.id === 'a')!.config).toMatchObject({ portMode: 'fixed', port: 46100 })
  })
  it('keeps the list usable when the config file is broken and archives the broken file', async () => {
    const { root, control } = await fixture()
    await writeFile(path.join(root, 'pack-control.json'), '{"a": {"portMode": "fix')
    const list = await control.execute({ command: 'pack.list' }) as { packs: Array<{ id: string; config: { portMode: string } }> }
    expect(list.packs.map(p => p.id)).toEqual(['a', 'b'])
    expect(list.packs[0].config.portMode).toBe('auto')
    expect((await readdir(root)).some(name => name.startsWith('pack-control.json.corrupt-'))).toBe(true)
    await expect(readFile(path.join(root, 'pack-control.json'), 'utf8')).rejects.toThrow()
  })
  it('applies resource changes while the pack is running and leaves the running DSH alone', async () => {
    const { control, root } = await fixture()
    const source = path.join(root, 'a', 'skills', 'live-skill'); await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'SKILL.md'), '---\nname: live-skill\ndescription: Fixture\n---\nLive')
    try {
      const started = await control.execute({ command: 'pack.start', packId: 'a' }) as RuntimeState
      const list = await control.execute({ command: 'pack.resources.enabled', packId: 'a', args: { kind: 'skills', name: 'live-skill', enabled: false } }) as { items: Array<{ name: string }> }
      expect(list.items.some(item => item.name === 'live-skill')).toBe(true)
      // 运行中也真的写进家目录：skill 挪进 .disabled，下次启动生效。
      await expect(readFile(path.join(root, 'a', 'skills', '.disabled', 'live-skill', 'SKILL.md'), 'utf8')).resolves.toContain('Live')
      const packs = (await control.execute({ command: 'pack.list' }) as { packs: Array<{ id: string; runtime: RuntimeState }> }).packs
      expect(packs.find(pack => pack.id === 'a')?.runtime).toMatchObject({ running: true, pid: started.pid })
    } finally { await control.shutdown() }
  })
  it('explains a locked resource write in Chinese instead of failing silently', async () => {
    const { control, root } = await fixture()
    const profile = path.join(root, 'a', 'profiles', 'web'); await mkdir(profile, { recursive: true })
    await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dependencies: { 'fixture-plugin': '1.0.0' }, dsh: { profile: { bundles: ['fixture-plugin'] } } }))
    const request = { command: 'pack.resources.enabled', packId: 'a', args: { kind: 'plugins', name: 'fixture-plugin', enabled: false } }
    try {
      await control.execute({ command: 'pack.start', packId: 'a' })
      const locked = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async () => { throw Object.assign(new Error('Fixture locked write'), { code: 'EPERM' }) })
      await expect(control.execute(request)).rejects.toThrow('正在运行，这次改动没能写进它的家目录（EPERM）')
      locked.mockRestore()
      const other = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async () => { throw new Error('Fixture unexpected write failure') })
      // 只有文件占用类错误才翻译成中文；别的失败保留原文，方便排查。
      await expect(control.execute(request)).rejects.toThrow('Fixture unexpected write failure')
      other.mockRestore()
    } finally { await control.shutdown() }
  })
  it('inherits the launcher administrator token instead of raising UAC when already elevated', async () => {
    const elevated = vi.fn(async (_executable: string, _args: string[], _options: unknown) => runtimeChild(4242))
    const { control, root } = await fixture(false, { isElevated: async () => true, spawnElevatedProcess: elevated })
    await writeFile(path.join(root, 'pack-control.json'), JSON.stringify({ a: { runAsAdmin: true } }))
    try {
      const state = await control.execute({ command: 'pack.start', packId: 'a' }) as RuntimeState
      expect(state.running).toBe(true)
      // 已提权的启动器直接普通 spawn，子进程继承管理员令牌：不再弹 UAC、不再起看护进程。
      expect(elevated).not.toHaveBeenCalled()
    } finally { await control.shutdown() }
  })
  it('still goes through the UAC bridge when the launcher is not elevated', async () => {
    const elevated = vi.fn(async (_executable: string, _args: string[], _options: unknown) => runtimeChild(4243))
    const { control, root, spawned } = await fixture(false, { isElevated: async () => false, spawnElevatedProcess: elevated })
    await writeFile(path.join(root, 'pack-control.json'), JSON.stringify({ a: { runAsAdmin: true } }))
    try {
      const state = await control.execute({ command: 'pack.start', packId: 'a' }) as RuntimeState
      expect(elevated).toHaveBeenCalledTimes(1)
      expect(elevated.mock.calls[0][0]).toBe('dsh')
      expect(spawned).toHaveLength(0)
      expect(state.pid).toBe(4243)
    } finally { await control.shutdown() }
  })
})
