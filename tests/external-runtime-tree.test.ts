import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AppSettings, ExternalRuntime } from '../src/types'
import { __setExternalRuntimeDeps, expandExcludedPids, scanExternalRuntimes, type ProcessSnapshot } from '../electron/external-runtime'
import { createPackControl } from '../electron/pack-control'
import { writePackRegistry, type PackRecord } from '../electron/pack-registry'

/**
 * 现场：启动器托管的是 cmd 包装进程 24416，它拉起的 node 25960 才是真正的 DSH。
 * 只排掉 24416 会把 25960 当成外部实例，于是同一页同时显示「运行中」和「外部运行中」。
 */
const NODE_BIN = 'C:/launcher-data/dsh-runtime/versions/0.2.1-rc.3/node_modules/.pnpm/@deepseek-ai+dsh-harness/lib/bin.js'
const CMD_SHELL = 24416
const DSH_NODE = 25960
const GRANDCHILD = 30010
const OUTSIDER = 5555

function dshLine(port: number): string {
  return '"C:\\Program Files\\nodejs\\node.exe" "' + NODE_BIN + '" --profile pack-test --no-open --port ' + port
}

const roots: string[] = []
afterEach(async () => {
  __setExternalRuntimeDeps(null)
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('expandExcludedPids', () => {
  const tree: ProcessSnapshot[] = [
    { pid: CMD_SHELL, parentPid: 3600 },
    { pid: DSH_NODE, parentPid: CMD_SHELL },
    { pid: GRANDCHILD, parentPid: DSH_NODE },
    { pid: OUTSIDER, parentPid: 1 },
    { pid: 900, parentPid: null },
    { pid: 901 },
  ]

  it('adds the whole descendant tree of the seed and leaves unrelated pids alone', () => {
    expect([...expandExcludedPids(tree, [CMD_SHELL])].sort((a, b) => a - b)).toEqual([CMD_SHELL, DSH_NODE, GRANDCHILD])
  })

  it('tolerates a missing or unusable parentPid and survives a parent cycle', () => {
    expect([...expandExcludedPids(tree, [901])]).toEqual([901])
    const cyclic: ProcessSnapshot[] = [{ pid: 11, parentPid: 12 }, { pid: 12, parentPid: 11 }, { pid: 13, parentPid: 0 }]
    expect([...expandExcludedPids(cyclic, [11])].sort((a, b) => a - b)).toEqual([11, 12])
  })
})

describe('scanExternalRuntimes over a hosted process tree', () => {
  it('never reports the node child of a hosted cmd shell as external', async () => {
    __setExternalRuntimeDeps({ runPowerShell: async () => JSON.stringify([
      { pid: CMD_SHELL, parentPid: 3600, name: 'cmd.exe', commandLine: 'C:\\Windows\\system32\\cmd.exe /d /s /c "node ' + NODE_BIN + ' --profile pack-test --no-open --port 3080"', elevated: false },
      { pid: DSH_NODE, parentPid: CMD_SHELL, name: 'node.exe', commandLine: dshLine(3080), elevated: false },
    ]) })
    const found = await scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }], excludePids: [CMD_SHELL] })
    expect(found.size).toBe(0)
  })

  it('never reports a grandchild two levels below the hosted pid', async () => {
    __setExternalRuntimeDeps({ runPowerShell: async () => JSON.stringify([
      { pid: CMD_SHELL, parentPid: 3600, name: 'cmd.exe', commandLine: 'C:\\Windows\\system32\\cmd.exe /d /s /c "node ' + NODE_BIN + ' --profile pack-test --no-open --port 3080"', elevated: false },
      { pid: DSH_NODE, parentPid: CMD_SHELL, name: 'node.exe', commandLine: dshLine(3080), elevated: false },
      { pid: GRANDCHILD, parentPid: DSH_NODE, name: 'node.exe', commandLine: dshLine(3080), elevated: false },
    ]) })
    const input = { packs: [{ id: 'pack-test', profileName: 'pack-test' }] }
    // 不排任何 pid 时同一份快照本来会命中，说明空白结果确实是排除规则起作用。
    expect((await scanExternalRuntimes(input)).get('pack-test')?.pid).toBe(DSH_NODE)
    expect((await scanExternalRuntimes({ ...input, excludePids: [CMD_SHELL] })).size).toBe(0)
  })

  it('still reports a same-profile DSH that is not inside the hosted tree', async () => {
    __setExternalRuntimeDeps({ runPowerShell: async () => JSON.stringify([
      { pid: CMD_SHELL, parentPid: 3600, name: 'cmd.exe', commandLine: 'C:\\Windows\\system32\\cmd.exe /d /s /c "node ' + NODE_BIN + ' --profile pack-test --no-open --port 3080"', elevated: false },
      { pid: DSH_NODE, parentPid: CMD_SHELL, name: 'node.exe', commandLine: dshLine(3080), elevated: false },
      { pid: OUTSIDER, parentPid: 1, name: 'node.exe', commandLine: dshLine(3081), elevated: false },
    ]) })
    const found = await scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }], excludePids: [CMD_SHELL] })
    expect(found.get('pack-test')).toMatchObject({ pid: OUTSIDER, port: 3081 })
  })
})

describe('pack control gates the external scan behind the hosted runtime', () => {
  function externalFor(id: string): ExternalRuntime {
    return { pid: 4000, port: 3080, startedAt: null, url: 'http://127.0.0.1:3080/', profileName: 'profile-' + id, requiresElevation: true, elevatedSession: null }
  }

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'external-runtime-tree-')); roots.push(root)
    const records = ['a', 'b'].map(id => ({ id, name: id, description: '', version: '1', homePath: path.join(root, id), source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] }) as PackRecord)
    for (const record of records) await mkdir(record.homePath!, { recursive: true })
    const registryPath = path.join(root, 'packs.json'); await writePackRegistry(registryPath, records)
    const settings: AppSettings = {
      dshHome: path.join(root, 'default'), dshInstallPath: root, profileName: 'web', launchExecutable: 'dsh', launchArgs: ['web'], webPort: 45321,
      workspace: root, openAfterLaunch: false, activePackId: 'a',
    }
    // reportExternal 关掉才能在 pack.start 时先干净启动一次，之后再模拟「扫描把托管树也命中」的误判。
    let reportExternal = false
    const excludes: Array<number[] | undefined> = []
    const stopped: number[] = []
    let pid = 1000
    const control = createPackControl({
      userData: root, registryPath, readSettings: async () => settings,
      resolveSettings: async (r, c) => ({ ...settings, dshHome: r.homePath!, webPort: c.port, profileName: 'profile-' + r.id }),
      runtimeOptions: () => ({
        prepareNodeRuntime: async () => ({ node: process.execPath, npm: 'npm', npx: 'npx', root, managed: false }),
        fallbackWorkspace: () => root, emitOutput: () => undefined, emitState: () => undefined, openExternal: () => undefined,
        spawnProcess: () => {
          const child = new EventEmitter() as ChildProcessWithoutNullStreams
          Object.assign(child, { pid: pid++, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() })
          return child
        },
        stopProcess: async child => { child.emit('exit', 0) },
      }),
      openExternal: async () => undefined,
      externalRuntime: {
        scan: async input => {
          excludes.push(input.excludePids)
          const found = new Map<string, ExternalRuntime>()
          for (const pack of input.packs) if (reportExternal) found.set(pack.id, externalFor(pack.id))
          return found
        },
        stop: async target => { stopped.push(target.pid); return 'taskkill' },
      },
    })
    return { control, excludes, stopped, report: (value: boolean) => { reportExternal = value } }
  }

  it('reports externalRuntime for an idle pack but never for a running one', async () => {
    const { control, excludes, report } = await fixture()
    const started = await control.execute({ command: 'pack.start', packId: 'a' }) as { running: boolean; pid: number | null }
    expect(started.running).toBe(true)
    report(true)
    const listed = await control.execute({ command: 'pack.list' }) as {
      packs: Array<{ id: string; runtime: { running: boolean; pid: number | null }; externalRuntime: ExternalRuntime | null }>
    }
    const a = listed.packs.find(pack => pack.id === 'a')!
    const b = listed.packs.find(pack => pack.id === 'b')!
    expect(a.runtime).toMatchObject({ running: true, pid: started.pid })
    expect(a.externalRuntime).toBeNull()
    expect(b.runtime.running).toBe(false)
    expect(b.externalRuntime).toMatchObject({ pid: 4000, port: 3080 })
    // 托管的 pid 仍然交给扫描去排除，两道闸各管一层。
    expect(excludes[excludes.length - 1]).toContain(started.pid)
    await control.shutdown()
  })

  it('does not let a misreported external instance block start or redirect stop', async () => {
    const { control, stopped, report } = await fixture()
    const started = await control.execute({ command: 'pack.start', packId: 'a' }) as { pid: number | null }
    report(true)
    await expect(control.execute({ command: 'pack.start', packId: 'a' })).resolves.toMatchObject({ running: true, pid: started.pid })
    const result = await control.execute({ command: 'pack.stop', packId: 'a' }) as Record<string, unknown>
    expect(result).toMatchObject({ running: false, pid: null })
    expect(result.externalStopped).toBeUndefined()
    expect(stopped).toEqual([])
    await control.shutdown()
  })
})
