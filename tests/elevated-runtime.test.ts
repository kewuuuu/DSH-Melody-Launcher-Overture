import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
import { spawnElevatedRuntime, stopElevatedRuntime } from '../electron/elevated-runtime'

/** 括号配平：以前 $hideConsole 少一个 }，整个 supervise.ps1 解析失败，提权会话永远进不了 DSH。 */
function braceBalance(text: string): number {
  let depth = 0
  for (const char of text) {
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
  }
  return depth
}

describe('Windows administrator runtime bridge', () => {
  const stashRoots: string[] = []
  afterEach(async () => {
    await Promise.all(stashRoots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
    mocked.spawn.mockReset()
  })
  async function stashRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'elevated-stash-test-'))
    stashRoots.push(dir)
    return dir
  }
  function fakeChild(pid: number): ChildProcessWithoutNullStreams {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    Object.assign(child, { pid, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
    mocked.spawn.mockReturnValue(child)
    return child
  }
  it.skipIf(process.platform !== 'win32')('requests RunAs, supervises its tree, forwards output and acknowledges scoped stop without invoking UAC', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    Object.assign(child, { pid: 123456789, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
    mocked.spawn.mockReturnValue(child)
    const started = await spawnElevatedRuntime('C:/fixture/node.exe', ['entry.js', '--port', '49999'], { cwd: 'C:/fixture', env: { DSH_HOME: 'C:/fixture/pack home' } })
    const args = mocked.spawn.mock.calls[0][1] as string[]
    const outer = Buffer.from(args[2], 'base64').toString('utf16le')
    expect(outer).toContain('-Verb RunAs -Wait -PassThru')
    // 提权出来的 PowerShell 窗口必须自己藏起来：RunAs 会新开一个可见控制台。
    expect(outer).toContain('-WindowStyle Hidden -Verb RunAs')
    expect(outer).toContain('"-WindowStyle","Hidden"')
    const match = outer.match(/"([^"]+supervise[.]ps1)"/)
    expect(match).not.toBeNull()
    const root = path.dirname(match![1])
    const script = await readFile(match![1], 'utf8')
    expect(script).toContain('DSH_HOME'); expect(script).toContain('C:/fixture/pack home')
    expect(script).toContain('Get-Process -Id ' + process.pid)
    expect(script).toContain('$ownerStart'); expect(script).toContain('taskkill.exe /pid $p.Id /t /f')
    expect(script).toContain('Test-Path -LiteralPath')
    expect(script).toContain('ShowWindow')
    expect(script).toContain('GetConsoleWindow')
    let output = ''; child.stdout.on('data', chunk => { output += chunk.toString() })
    await writeFile(path.join(root, 'stdout.log'), 'http://127.0.0.1:49999')
    await vi.waitFor(() => expect(output).toContain('http://127.0.0.1:49999'))
    const stopping = stopElevatedRuntime(started)
    await vi.waitFor(async () => expect(await readFile(path.join(root, 'stop'), 'utf8')).toBe('stop'))
    Object.assign(child, { exitCode: 0 }); child.emit('exit', 0)
    expect(await stopping).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('stashes the elevated session so any later launcher can stop it', async () => {
    const child = fakeChild(123456789)
    const root = await stashRoot()
    const started = await spawnElevatedRuntime('C:/fixture/node.exe', ['entry.js', '--port', '49999'], { cwd: 'C:/fixture', env: { DSH_HOME: 'C:/fixture/pack home' }, stash: { root, packId: 'pack-test' } })
    expect(started).toBe(child)
    const file = path.join(root, 'pack-test.json')
    const session = JSON.parse(await readFile(file, 'utf8'))
    expect(session).toMatchObject({ version: 1, packId: 'pack-test', outerPid: 123456789 })
    expect(session.stopFile.endsWith(path.sep + 'stop')).toBe(true)
    expect(session.logPaths.stdout.endsWith('stdout.log')).toBe(true)
    // 监督脚本把子进程 pid 落盘，并且用 finally 收尾：脚本自己被中断也不许留孤儿。
    const script = await readFile(path.join(session.elevatedRoot, 'supervise.ps1'), 'utf8')
    expect(script).toContain('child.json')
    expect(script).toContain('} finally {')
    // 回归：脚本块自身必须闭合，否则 PowerShell 直接 ParserError: MissingEndCurlyBrace。
    expect(braceBalance(script)).toBe(0)
    expect(script).toContain('} catch {} }')
    Object.assign(child, { exitCode: 0 }); child.emit('exit', 0)
    await vi.waitFor(async () => expect(await readFile(file, 'utf8').catch(() => null)).toBeNull())
  })

  it.skipIf(process.platform !== 'win32')('leaves a session file that another launcher rewrote alone', async () => {
    const child = fakeChild(222333)
    const root = await stashRoot()
    await spawnElevatedRuntime('C:/fixture/node.exe', ['entry.js'], { cwd: 'C:/fixture', env: {}, stash: { root, packId: 'pack-test' } })
    const file = path.join(root, 'pack-test.json')
    const ours = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ version: 1, packId: 'pack-test', outerPid: 999888 }), 'utf8')
    Object.assign(child, { exitCode: 0 }); child.emit('exit', 0)
    await vi.waitFor(async () => expect(await readFile(path.join(ours.elevatedRoot, 'supervise.ps1'), 'utf8').catch(() => null)).toBeNull())
    expect(JSON.parse(await readFile(file, 'utf8')).outerPid).toBe(999888)
  })

  it.skipIf(process.platform !== 'win32')('cancels an elevated start whose supervisor never appeared instead of waiting 15 seconds', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    Object.assign(child, { pid: 555111, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
    mocked.spawn.mockImplementation((command: string) => {
      if (command !== 'taskkill.exe') return child
      const killer = new EventEmitter()
      // 真实 taskkill 会立刻退出并把外层 powershell 也带走，这里同样让它把外层收掉。
      setTimeout(() => { Object.assign(child, { exitCode: 1 }); child.emit('exit', 1); killer.emit('exit', 0) }, 10)
      return killer as unknown as ChildProcessWithoutNullStreams
    })
    const started = await spawnElevatedRuntime('C:/fixture/node.exe', ['entry.js'], { cwd: 'C:/fixture', env: {} })
    const begin = Date.now()
    expect(await stopElevatedRuntime(started)).toBe(true)
    const elapsed = Date.now() - begin
    // 监督进程没起来（UAC 还没应答）＝写下去的 stop 没人消费：3 秒后必须改走 taskkill，绝不能再硬等 15 秒。
    expect(elapsed).toBeGreaterThanOrEqual(2_000)
    expect(elapsed).toBeLessThan(9_000)
    const kill = mocked.spawn.mock.calls.find(call => call[0] === 'taskkill.exe')
    expect(kill).toBeTruthy()
    expect(kill![1]).toEqual(['/pid', '555111', '/t', '/f'])
  }, 15_000)

  it.skipIf(process.platform !== 'win32')('force stop kills the outer shell directly without writing the stop file', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    Object.assign(child, { pid: 666222, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
    mocked.spawn.mockImplementation((command: string) => {
      if (command !== 'taskkill.exe') return child
      const killer = new EventEmitter()
      setTimeout(() => killer.emit('exit', 0), 5)
      return killer as unknown as ChildProcessWithoutNullStreams
    })
    const started = await spawnElevatedRuntime('C:/fixture/node.exe', ['entry.js'], { cwd: 'C:/fixture', env: {} })
    const args = mocked.spawn.mock.calls[0][1] as string[]
    const outer = Buffer.from(args[2], 'base64').toString('utf16le')
    const root = path.dirname(outer.match(/"([^"]+supervise[.]ps1)"/)![1])
    const stopping = stopElevatedRuntime(started, { force: true })
    await vi.waitFor(() => expect(mocked.spawn.mock.calls.some(call => call[0] === 'taskkill.exe')).toBe(true))
    // force 语义就是跳过优雅停止：这一步不能有 stop 文件。
    expect(await readFile(path.join(root, 'stop'), 'utf8').catch(() => null)).toBeNull()
    Object.assign(child, { exitCode: 0 }); child.emit('exit', 0)
    expect(await stopping).toBe(true)
    expect(mocked.spawn.mock.calls.find(call => call[0] === 'taskkill.exe')![1]).toEqual(['/pid', '666222', '/t', '/f'])
  }, 15_000)
})
