import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PassThrough } from 'node:stream'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createRuntimeController } from '../electron/runtime'
import type { NodeRuntime } from '../electron/node-runtime'
import type { AppSettings, RuntimeState } from '../src/types'

type WritableChild = ChildProcessWithoutNullStreams & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
}

function fakeChild(pid: number): WritableChild {
  const child = new EventEmitter() as WritableChild
  Object.assign(child, {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
  return child
}

function controllerSettings(): AppSettings {
  return {
    dshInstallPath: path.join(process.cwd(), 'dsh-runtime'),
    dshHome: path.join(process.cwd(), '.dsh'),
    profileName: 'web',
    workspace: process.cwd(),
    launchExecutable: 'dsh.cmd',
    launchArgs: ['web'],
    webPort: 3080,
    openAfterLaunch: false,
  }
}

function managedNode(): NodeRuntime {
  const root = path.join(process.cwd(), 'managed-node')
  return {
    root,
    node: path.join(root, process.platform === 'win32' ? 'node.exe' : 'node'),
    npm: path.join(root, process.platform === 'win32' ? 'npm.cmd' : 'npm'),
    npx: path.join(root, process.platform === 'win32' ? 'npx.cmd' : 'npx'),
    managed: true,
  }
}

describe('提权启动的就绪确认', () => {
  it('监督进程迟迟不确认时按 fail-closed 收尾：清空 child、释放端口、留下中文原因', async () => {
    const settings = controllerSettings()
    const child = fakeChild(4300)
    const states: RuntimeState[] = []
    const releasePort = vi.fn()
    const stopProcess = vi.fn(async (_processToStop: ChildProcessWithoutNullStreams) => { void _processToStop })
    const runtime = createRuntimeController({
      readSettings: async () => settings,
      prepareNodeRuntime: async () => managedNode(),
      fallbackWorkspace: () => process.cwd(),
      emitOutput: () => {},
      emitState: s => states.push(s),
      openExternal: () => {},
      runAsAdmin: true,
      // 启动器自己没提权 → 走 spawnElevatedProcess；这里注入假实现，绝不起真的 UAC。
      isElevated: async () => false,
      spawnElevatedProcess: (async () => child) as unknown as typeof import('../electron/elevated-runtime').spawnElevatedRuntime,
      stopProcess,
      releasePort,
      elevatedReadyTimeoutMs: 200,
    })

    const started = await runtime.start()
    expect(started.running).toBe(true)
    // 外层已经拉起、监督进程还没确认：这段时间界面要能显示「等待管理员授权」。
    expect(started.awaitingAuthorization).toBe(true)

    await vi.waitFor(() => expect(runtime.state().running).toBe(false), { timeout: 5_000 })

    const final = runtime.state()
    expect(final.awaitingAuthorization).toBe(false)
    expect(final.pid).toBeNull()
    expect(final.lastError).toContain('管理员授权')
    expect(stopProcess).toHaveBeenCalledTimes(1)
    expect(releasePort).toHaveBeenCalled()
    expect(states.some(s => s.awaitingAuthorization === true)).toBe(true)
    expect(states.some(s => s.running === false && typeof s.lastError === 'string')).toBe(true)
  }, 15_000)
})
