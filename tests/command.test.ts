import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { collectCommandOutput, runCommand, type CommandProcess } from '../electron/command'

/** 一个只实现 collectCommandOutput 所需接口的子进程替身。 */
function fakeProcess() {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = {
    stdout,
    stderr,
    once: (event: string, listener: (...args: any[]) => void) => emitter.once(event, listener),
  } as unknown as CommandProcess
  return { child, stdout, stderr, emitter }
}

describe('collectCommandOutput', () => {
  it('merges stdout and stderr in arrival order and reports the exit code', async () => {
    const { child, stdout, stderr, emitter } = fakeProcess()
    const pending = collectCommandOutput(child)

    stdout.write('hello ')
    stderr.write('warning ')
    stdout.write('world')
    emitter.emit('exit', 0)

    await expect(pending).resolves.toEqual({ exitCode: 0, output: 'hello warning world' })
  })

  it('forwards each chunk with its stream level', async () => {
    const { child, stdout, stderr, emitter } = fakeProcess()
    const seen: Array<[string, string]> = []
    const pending = collectCommandOutput(child, { onOutput: (text, level) => seen.push([level, text]) })

    stdout.write('out')
    stderr.write('err')
    emitter.emit('exit', 0)
    await pending

    expect(seen).toEqual([['info', 'out'], ['error', 'err']])
  })

  it('keeps only the tail of the output once the capture limit is reached', async () => {
    const { child, stdout, emitter } = fakeProcess()
    const pending = collectCommandOutput(child, { captureLimit: 5 })

    stdout.write('abcdefgh')
    emitter.emit('exit', 0)

    await expect(pending).resolves.toEqual({ exitCode: 0, output: 'defgh' })
  })

  it('treats a null exit code as a failure', async () => {
    const { child, emitter } = fakeProcess()
    const pending = collectCommandOutput(child)
    emitter.emit('exit', null)
    await expect(pending).resolves.toMatchObject({ exitCode: 1 })
  })

  it('rejects when the process fails to start', async () => {
    const { child, emitter } = fakeProcess()
    const pending = collectCommandOutput(child)
    emitter.emit('error', new Error('ENOENT'))
    await expect(pending).rejects.toThrow('ENOENT')
  })
})

describe('runCommand execution log', () => {
  it('records the command, output, working directory and exit code', async () => {
    const seen: Array<[string, string]> = []
    const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("command-ok")'], {
      cwd: process.cwd(),
      env: process.env,
      onOutput: (text, level) => seen.push([level, text]),
    })

    expect(result.exitCode).toBe(0)
    expect(seen.some(([level, text]) => level === 'info' && text.includes('命令：'))).toBe(true)
    expect(seen.some(([, text]) => text.includes('工作目录：'))).toBe(true)
    expect(seen.some(([, text]) => text.includes('command-ok'))).toBe(true)
    expect(seen.some(([level, text]) => level === 'info' && text.includes('命令退出：0'))).toBe(true)
  })
})

describe('runCommand timeout', () => {
  it('terminates a hung subprocess after the timeout and reports exitCode -1', async () => {
    const startedAt = Date.now()
    const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], {
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 500,
    })
    expect(result.exitCode).toBe(-1)
    expect(result.output).toContain('命令执行超时')
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })
})


describe('managed command cleanup', () => {
  it('awaits both process close and the terminator on timeout', async () => {
    vi.useFakeTimers()
    try {
      const { child, emitter } = fakeProcess()
      let release!: () => void
      const stop = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
      const completed = vi.fn()
      const pending = collectCommandOutput(child, { timeoutMs: 1_000 }, stop).then(completed)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(stop).toHaveBeenCalledOnce()
      emitter.emit('exit', 1)
      emitter.emit('close', 1)
      await Promise.resolve()
      expect(completed).not.toHaveBeenCalled()
      release()
      await pending
      expect(completed).toHaveBeenCalledWith(expect.objectContaining({ exitCode: -1, timedOut: true }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('kills a running command when its signal aborts', async () => {
    const controller = new AbortController()
    const reason = new Error('cancel fixture')
    const onClose = vi.fn()
    const pending = runCommand(process.execPath, ['-e', 'console.log("running"); setInterval(() => {}, 1000)'], {
      cwd: process.cwd(), env: process.env, timeoutMs: 4_000, signal: controller.signal,
      onSpawn: child => { child.once('close', onClose) },
      onOutput: text => { if (text.includes('running') && !text.includes('命令：')) controller.abort(reason) },
    })
    await expect(pending).rejects.toBe(reason)
    expect(onClose).toHaveBeenCalledOnce()
  }, 8_000)
})


describe.skipIf(process.platform !== 'win32')('Windows install Job Object', () => {
  it('cancels a descendant that still holds pipes after its parent exits', async () => {
    const controller = new AbortController()
    const reason = new Error('orphan fixture cancelled')
    const root = await mkdtemp(path.join(tmpdir(), 'dsh orphan fixture '))
    try {
      const grandchild = [
        'const parent = Number(process.argv[2])',
        'const timer = setInterval(() => {',
        '  try { process.kill(parent, 0) } catch (error) {',
        '    if (error.code !== "ESRCH") throw error',
        '    clearInterval(timer); console.log("PARENT_GONE"); setInterval(() => {}, 1000)',
        '  }',
        '}, 20)',
      ].join('\n')
      const parent = [
        'const child = require("node:child_process").spawn(process.execPath, [process.argv[2], String(process.pid)], { stdio: ["ignore", "inherit", "inherit"], detached: true })',
        'child.once("spawn", () => process.exit(0))',
      ].join("\n")
      const parentFile = path.join(root, "parent.cjs")
      const childFile = path.join(root, "child.cjs")
      await Promise.all([writeFile(parentFile, parent), writeFile(childFile, grandchild)])
      const output: string[] = []
      const pending = runCommand(process.execPath, [parentFile, childFile], {
        cwd: process.cwd(), env: process.env, timeoutMs: 6_000, signal: controller.signal,
        onOutput(text) {
          output.push(text)
          if (output.slice(1).join('').includes('PARENT_GONE')) controller.abort(reason)
        },
      })
      await expect(pending, output.join('')).rejects.toBe(reason)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('preserves a managed batch file path and arguments containing spaces', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'dsh command fixture '))
    try {
      const fixture = path.join(root, 'managed test.cmd')
      await writeFile(fixture, '@echo off\r\necho first=[%~1]\r\necho second=[%2]\r\nexit /b 7\r\n')
      const result = await runCommand(fixture, ['argument with spaces', 'left&right'], {
        cwd: root, env: process.env, timeoutMs: 6_000,
      })
      expect(result).toMatchObject({ exitCode: 7 })
      expect(result.output).toContain('first=[argument with spaces]')
      expect(result.output).toContain('second=["left&right"]')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
