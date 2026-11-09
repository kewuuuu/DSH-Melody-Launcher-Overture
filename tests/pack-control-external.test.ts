import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings, ExternalRuntime } from '../src/types'
import { createPackControl } from '../electron/pack-control'
import { writePackRegistry, type PackRecord } from '../electron/pack-registry'
import { setDefaultBackupEngine, type BackupEngine } from '../electron/backups'

const backupStub = {
  create: async (input: { label: string; op?: string; paths: string[] }) => ({
    id: 'stub-backup', op: input.op ?? 'manual', label: input.label, createdAt: 0, sizeBytes: 0, fileCount: 0, locked: false, origin: input.paths, archivePath: 'stub.zip',
  }),
} as unknown as BackupEngine

const roots: string[] = []
afterEach(async () => {
  setDefaultBackupEngine(null)
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** 一个包的外部遗留实例：命令行里带 bin.js 的 node 本体。 */
function externalFor(id: string): ExternalRuntime {
  return { pid: 4000, port: 3080, startedAt: null, url: 'http://127.0.0.1:3080/', profileName: 'profile-' + id, requiresElevation: true, elevatedSession: null }
}

async function fixture(options?: { external?: Record<string, ExternalRuntime>; settings?: Partial<AppSettings> }) {
  setDefaultBackupEngine(backupStub)
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-control-external-')); roots.push(root)
  const records = ['a', 'b'].map(id => ({ id, name: id, description: '', version: '1', homePath: path.join(root, id), source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] }) as PackRecord)
  for (const record of records) await mkdir(record.homePath!, { recursive: true })
  const registryPath = path.join(root, 'packs.json'); await writePackRegistry(registryPath, records)
  const state: AppSettings = {
    dshHome: path.join(root, 'default'), dshInstallPath: root, profileName: 'web', launchExecutable: 'dsh', launchArgs: ['web'], webPort: 45321,
    workspace: root, openAfterLaunch: false, activePackId: 'a', ...options?.settings,
  }
  const scanned: Array<{ packs: Array<{ id: string; profileName?: string }>; excludePids?: number[] }> = []
  const stopped: Array<{ pid: number; allowElevation: boolean; dataDir: string }> = []
  const control = createPackControl({
    userData: root, registryPath, readSettings: async () => state,
    resolveSettings: async (r, c) => ({ ...state, dshHome: r.homePath!, webPort: c.port, profileName: 'profile-' + r.id }),
    runtimeOptions: () => ({
      prepareNodeRuntime: async () => ({ node: process.execPath, npm: 'npm', npx: 'npx', root, managed: false }),
      fallbackWorkspace: () => root, emitOutput: () => undefined, emitState: () => undefined, openExternal: () => undefined,
      spawnProcess: () => { throw new Error('这个用例不该真的启动进程') },
      stopProcess: async () => undefined,
    }),
    openExternal: async () => undefined,
    externalRuntime: {
      scan: async input => { scanned.push({ packs: input.packs, excludePids: input.excludePids }); const found = new Map<string, ExternalRuntime>(); for (const pack of input.packs) { const hit = options?.external?.[pack.id]; if (hit) found.set(pack.id, hit) } return found },
      stop: async (target, stopOptions) => { stopped.push({ pid: target.pid, allowElevation: stopOptions.allowElevation, dataDir: stopOptions.dataDir }); return 'taskkill' },
    },
  })
  return { root, control, state, scanned, stopped }
}

describe('pack control with an unmanaged external DSH', () => {
  it('reports externalRuntime in pack.list and leaves the clean pack null', async () => {
    const { control } = await fixture({ external: { a: externalFor('a') } })
    const listed = (await control.execute({ command: 'pack.list' })) as { packs: Array<{ id: string; externalRuntime: ExternalRuntime | null }> }
    const a = listed.packs.find(pack => pack.id === 'a')!
    const b = listed.packs.find(pack => pack.id === 'b')!
    expect(a.externalRuntime).toMatchObject({ pid: 4000, port: 3080, url: 'http://127.0.0.1:3080/', requiresElevation: true })
    expect(b.externalRuntime).toBeNull()
    await control.shutdown()
  })

  it('stops the external instance instead of reporting a fake success', async () => {
    const { control, root, stopped } = await fixture({ external: { a: externalFor('a') } })
    const result = (await control.execute({ command: 'pack.stop', packId: 'a' })) as Record<string, unknown>
    expect(result).toMatchObject({ running: false, externalStopped: true, stoppedBy: 'taskkill' })
    // 默认允许弹一次 UAC：设置里没写 elevatedStopPrompt 就是这个意思。
    expect(stopped).toEqual([{ pid: 4000, allowElevation: true, dataDir: root }])
    await control.shutdown()
  })

  it('honours --no-elevated and elevatedStopPrompt:false by never allowing UAC', async () => {
    const noFlag = await fixture({ external: { a: externalFor('a') } })
    await noFlag.control.execute({ command: 'pack.stop', packId: 'a', args: { noElevated: true } })
    expect(noFlag.stopped[0].allowElevation).toBe(false)
    await noFlag.control.shutdown()

    const promptOff = await fixture({ external: { a: externalFor('a') }, settings: { elevatedStopPrompt: false } })
    await promptOff.control.execute({ command: 'pack.stop', packId: 'a' })
    expect(promptOff.stopped[0].allowElevation).toBe(false)
    await promptOff.control.shutdown()
  })

  it('still reports running:false when genuinely nothing runs, without claiming an external stop', async () => {
    const { control, stopped } = await fixture()
    const result = (await control.execute({ command: 'pack.stop', packId: 'a' })) as Record<string, unknown>
    expect(result).toMatchObject({ running: false, pid: null })
    expect(result.externalStopped).toBeUndefined()
    expect(stopped).toHaveLength(0)
    await control.shutdown()
  })

  it('refuses to start or restart while an external instance holds the port', async () => {
    const { control } = await fixture({ external: { a: externalFor('a') } })
    await expect(control.execute({ command: 'pack.start', packId: 'a' })).rejects.toThrow('这个整合包已经有一份没被启动器托管的 DSH 在运行（PID 4000，端口 3080）。先停止它再启动。')
    await expect(control.execute({ command: 'pack.restart', packId: 'a' })).rejects.toThrow('这个整合包已经有一份没被启动器托管的 DSH 在运行')
    await control.shutdown()
  })
})
