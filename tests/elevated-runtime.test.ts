import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocked.spawn }))
import { spawnElevatedRuntime, stopElevatedRuntime } from '../electron/elevated-runtime'

describe('Windows administrator runtime bridge', () => {
  it.skipIf(process.platform !== 'win32')('requests RunAs, supervises its tree, forwards output and acknowledges scoped stop without invoking UAC', async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams
    Object.assign(child, { pid: 123456789, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
    mocked.spawn.mockReturnValue(child)
    const started = await spawnElevatedRuntime('C:/fixture/node.exe', ['entry.js', '--port', '49999'], { cwd: 'C:/fixture', env: { DSH_HOME: 'C:/fixture/pack home' } })
    const args = mocked.spawn.mock.calls[0][1] as string[]
    const outer = Buffer.from(args[2], 'base64').toString('utf16le')
    expect(outer).toContain('-Verb RunAs -Wait -PassThru')
    const match = outer.match(/"([^"]+supervise[.]ps1)"/)
    expect(match).not.toBeNull()
    const root = path.dirname(match![1])
    const script = await readFile(match![1], 'utf8')
    expect(script).toContain('DSH_HOME'); expect(script).toContain('C:/fixture/pack home')
    expect(script).toContain('Get-Process -Id ' + process.pid)
    expect(script).toContain('$ownerStart'); expect(script).toContain('taskkill.exe /pid $p.Id /t /f')
    expect(script).toContain('Test-Path -LiteralPath')
    let output = ''; child.stdout.on('data', chunk => { output += chunk.toString() })
    await writeFile(path.join(root, 'stdout.log'), 'http://127.0.0.1:49999')
    await vi.waitFor(() => expect(output).toContain('http://127.0.0.1:49999'))
    const stopping = stopElevatedRuntime(started)
    await vi.waitFor(async () => expect(await readFile(path.join(root, 'stop'), 'utf8')).toBe('stop'))
    Object.assign(child, { exitCode: 0 }); child.emit('exit', 0)
    expect(await stopping).toBe(true)
  })
})
