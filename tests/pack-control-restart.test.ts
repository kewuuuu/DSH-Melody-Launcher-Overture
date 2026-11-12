import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPackControl } from '../electron/pack-control'
import { writePackRegistry, type PackRecord } from '../electron/pack-registry'
import type { createRuntimeController, RuntimeController } from '../electron/runtime'
import type { AppSettings, RuntimeState } from '../src/types'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true }))) })

type Hooks = {
  stop?: () => Promise<void>
  start?: (attempt: number) => Promise<void>
}

async function fixture(hooks: Hooks = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-restart-test-')); roots.push(root)
  const records = ['a'].map(id => ({ id, name: id, description: '', version: '1', homePath: path.join(root, id), source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] }) as PackRecord)
  for (const r of records) await mkdir(r.homePath!, { recursive: true })
  const registryPath = path.join(root, 'packs.json'); await writePackRegistry(registryPath, records)
  const settings: AppSettings = { dshHome: path.join(root, 'default'), dshInstallPath: root, profileName: 'web', launchExecutable: 'dsh', launchArgs: ['web'], webPort: 45321, workspace: root, openAfterLaunch: false, activePackId: 'a' }
  const events: string[] = []
  let starts = 0
  const fakeController = (): RuntimeController => {
    let running = false
    const snapshot = (): RuntimeState => ({ running, pid: running ? 4242 : null, startedAt: null, url: running ? 'http://127.0.0.1:45321' : null, port: running ? 45321 : null })
    return {
      state: snapshot,
      failure: () => null,
      isRunning: () => running,
      async start() {
        starts += 1
        events.push('start')
        await hooks.start?.(starts)
        running = true
        return snapshot()
      },
      async stop(options?: { force?: boolean }) {
        events.push(options?.force === true ? 'stop:force' : 'stop')
        await hooks.stop?.()
        running = false
        return snapshot()
      },
    }
  }
  const control = createPackControl({
    userData: root,
    registryPath,
    readSettings: async () => settings,
    resolveSettings: async (r, c) => ({ ...settings, dshHome: r.homePath!, webPort: c.port }),
    runtimeOptions: () => ({ prepareNodeRuntime: async () => ({ node: process.execPath, npm: 'npm', npx: 'npx', root, managed: false }), fallbackWorkspace: () => root, emitOutput: () => undefined, emitState: () => undefined, openExternal: () => undefined }),
    createController: fakeController as unknown as typeof createRuntimeController,
    openExternal: async () => undefined,
    externalRuntime: { scan: async () => new Map(), stop: async () => 'taskkill' },
  })
  return { control, root, events }
}

describe('后台重启与强制停止', () => {
  it('pack.restart 先回 accepted，再在后台串行执行 stop→start', async () => {
    const { control, events } = await fixture()
    try {
      await control.execute({ command: 'pack.start', packId: 'a' })
      events.length = 0
      const result = await control.execute({ command: 'pack.restart', packId: 'a' }) as { accepted?: boolean; restarting?: boolean }
      expect(result).toMatchObject({ accepted: true, restarting: true })
      // 回话这一刻后台还没动手：调用方不会再被 stop/start 的几秒钟挂着。
      expect(events).toEqual([])
      await vi.waitFor(() => expect(events).toEqual(['stop', 'start']))
      const list = await control.execute({ command: 'pack.list' }) as { packs: Array<{ id: string; runtime: RuntimeState }> }
      expect(list.packs[0].runtime).toMatchObject({ running: true, restarting: false })
    } finally { await control.shutdown() }
  }, 15_000)

  it('后台重启失败时把中文原因留在 runtime.lastError，不再抛给调用方', async () => {
    const { control } = await fixture({ start: async attempt => { if (attempt >= 2) throw new Error('端口 45321 被占用') } })
    try {
      await control.execute({ command: 'pack.start', packId: 'a' })
      await expect(control.execute({ command: 'pack.restart', packId: 'a' })).resolves.toMatchObject({ accepted: true })
      await vi.waitFor(async () => {
        const list = await control.execute({ command: 'pack.list' }) as { packs: Array<{ runtime: RuntimeState }> }
        expect(list.packs[0].runtime.lastError).toContain('重启整合包失败：端口 45321 被占用')
      }, { timeout: 5_000 })
      const list = await control.execute({ command: 'pack.list' }) as { packs: Array<{ runtime: RuntimeState }> }
      expect(list.packs[0].runtime).toMatchObject({ restarting: false, running: false })
    } finally { await control.shutdown() }
  }, 15_000)

  it('pack.stop 的 force 直达强制停止，不带 force 仍然走优雅停止', async () => {
    const { control, events } = await fixture()
    try {
      await control.execute({ command: 'pack.start', packId: 'a' })
      await control.execute({ command: 'pack.stop', packId: 'a', args: { force: true } })
      expect(events).toEqual(['start', 'stop:force'])
      await control.execute({ command: 'pack.start', packId: 'a' })
      await control.execute({ command: 'pack.stop', packId: 'a' })
      expect(events).toEqual(['start', 'stop:force', 'start', 'stop'])
    } finally { await control.shutdown() }
  }, 15_000)
})
