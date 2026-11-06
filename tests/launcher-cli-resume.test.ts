import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createLauncherControlServer } from '../electron/launcher-control-server'
import { createStorageController } from '../electron/storage-root'
import { createLauncherControl } from '../electron/launcher-control'

const exec = promisify(execFile)
const cliPath = path.resolve('bin/launcher-control.cjs')
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'launcher-cli-resume-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

async function fixture(respond: (request: any) => unknown) {
  const userData = await temporary()
  const requests: any[] = []
  const server = await createLauncherControlServer({ userData, execute: async (request: any) => {
    requests.push(request)
    return respond(request)
  } })
  cleanups.push(() => server.close())
  const run = (...args: string[]) => exec(process.execPath, [cliPath, '--user-data', userData, ...args], { timeout: 15000 })
  return { userData, requests, run }
}

const entries = [
  { id: 'r-1', packId: 'pack-a', prompt: '继续一', requestId: 'q-1', createdAt: 1, attempts: 0, status: 'pending', error: null },
  { id: 'r-2', packId: 'pack-b', prompt: '继续二', requestId: 'q-2', createdAt: 2, attempts: 0, status: 'pending', error: null },
  { id: 'r-3', packId: 'pack-a', prompt: '继续三', requestId: 'q-3', createdAt: 3, attempts: 1, status: 'failed', error: '会话已关闭' },
]

describe('launcher control pending and path CLI', () => {
  it('pending list 按 --pack 在 CLI 侧过滤，retry 与 discard 发送条目 ID', async () => {
    const f = await fixture(request => {
      if (request.command === 'pending.list') return entries
      if (request.command === 'pending.discard') return []
      return { ok: false, error: '整合包 pack-b 未在运行，续接请求已保留，待该包启动后再发送。', entries: [entries[1]] }
    })
    const listed = JSON.parse((await f.run('pending', 'list', '--pack', 'pack-a', '--json')).stdout)
    expect(listed.map((item: any) => item.id)).toEqual(['r-1', 'r-3'])
    expect(f.requests[0]).toEqual({ command: 'pending.list', args: { packId: 'pack-a' } })

    const all = JSON.parse((await f.run('pending', 'list', '--json')).stdout)
    expect(all).toHaveLength(3)
    expect(f.requests[1]).toEqual({ command: 'pending.list' })

    const retried = JSON.parse((await f.run('pending', 'retry', 'r-2', '--json')).stdout)
    expect(retried.ok).toBe(false)
    expect(retried.error).toContain('未在运行')
    expect(f.requests[2]).toEqual({ command: 'pending.retry', args: { id: 'r-2' } })

    expect(JSON.parse((await f.run('pending', 'discard', 'r-3', '--json')).stdout)).toEqual([])
    expect(f.requests[3]).toEqual({ command: 'pending.discard', args: { id: 'r-3' } })

    await expect(f.run('pending', 'retry', '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('需要一个续接请求 ID') })
    await expect(f.run('pending', 'nope', '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('用法：pending list') })
  })

  it('path migrate 校验 kind 与绝对路径并把解析后的目录发给后端', async () => {
    const target = await temporary()
    const f = await fixture(request => ({ kind: request.args.kind, current: request.args.target, backupId: 'b1', removedOld: true, warning: null }))
    const moved = JSON.parse((await f.run('path', 'migrate', 'dshHome', target, '--json')).stdout)
    expect(moved).toEqual({ kind: 'dshHome', current: path.resolve(target), backupId: 'b1', removedOld: true, warning: null })
    expect(f.requests[0]).toEqual({ command: 'path.migrate', args: { kind: 'dshHome', target: path.resolve(target) } })

    await expect(f.run('path', 'migrate', 'dshHome', 'relative/dir', '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('绝对路径') })
    await expect(f.run('path', 'migrate', 'dshInstallPath', '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('需要一个目标目录') })
    await expect(f.run('path', 'migrate', 'workspace', target, '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('只能是 dshHome 或 dshInstallPath') })
    await expect(f.run('path', 'nope', target, '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('用法：path migrate') })
  })

  it('pack restart --resume 把续接内容随重启一起发出，参数组合有校验', async () => {
    const f = await fixture(request => ({ resume: { id: 'r-9', packId: 'pack-a', prompt: request.args.resume.prompt }, runtime: { phase: 'running' } }))
    const restarted = JSON.parse((await f.run('pack', 'restart', 'pack-a', '--resume', '继续刚才的分析', '--session', 's-1', '--json')).stdout)
    expect(restarted.resume).toMatchObject({ packId: 'pack-a', prompt: '继续刚才的分析' })
    expect(f.requests[0]).toEqual({ command: 'pack.restart', packId: 'pack-a', args: { resume: { prompt: '继续刚才的分析', sessionId: 's-1' } } })

    await f.run('pack', 'restart', 'pack-a', '--resume', '只带内容', '--json')
    expect(f.requests[1]).toEqual({ command: 'pack.restart', packId: 'pack-a', args: { resume: { prompt: '只带内容' } } })

    await expect(f.run('pack', 'start', 'pack-a', '--resume', 'x', '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--resume 只用于 pack restart') })
    await expect(f.run('pack', 'restart', 'pack-a', '--session', 's-1', '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('--session 必须与 --resume') })
    await expect(f.run('pack', 'restart', 'pack-a', '--resume', '  ', '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('需要一段续接内容') })
    expect((await f.run('--help')).stdout).toContain('path migrate dshHome|dshInstallPath <absolute-directory>')
  })
})

describe('launcher control facade restart with resume', () => {
  it('pack.restart 先入队再重启，重启失败也留下待续接条目', async () => {
    const root = await temporary()
    const pointerFile = path.join(root, 'launcher-storage.json')
    const controller = createStorageController({
      resolution: { dataDir: path.join(root, 'launcher-data'), source: 'install', portableDir: root, pointerFile, warning: null },
      appDataPath: root,
    })
    const control = createLauncherControl({
      userData: root, cliPath: path.join(root, 'cli.cjs'), settings: { readStored: async () => ({}), read: async () => ({}), save: vi.fn() } as never,
      packManager: {} as never, prepareNodeRuntime: vi.fn(), preparePnpmRuntime: vi.fn(), openExternal: vi.fn(), fallbackWorkspace: () => root,
      fetchImpl: fetch, emitOutput: () => undefined, loginRegistration: vi.fn(), legacyRuntimeRunning: () => false, storage: controller,
    })
    await expect(control.execute({ command: 'pack.restart', packId: 'pack-x', args: { resume: { prompt: '继续' } } })).rejects.toThrow()
    const raw = JSON.parse(await readFile(path.join(root, 'pending-resumes.json'), 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.entries).toHaveLength(1)
    expect(raw.entries[0]).toMatchObject({ packId: 'pack-x', prompt: '继续', status: 'pending', attempts: 0 })
    expect(await control.execute({ command: 'pending.list' })).toHaveLength(1)
    const retried = await control.execute({ command: 'pending.retry', args: { id: raw.entries[0].id } }) as any
    expect(retried.ok).toBe(false)
    expect(retried.error).toContain('未在运行')
    expect(retried.entries[0].status).toBe('pending')
    expect(await control.execute({ command: 'pending.discard', args: { id: raw.entries[0].id } })).toEqual([])
  })
})
