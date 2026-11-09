import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ExternalRuntime } from '../src/types'
import { __setExternalRuntimeDeps, scanExternalRuntimes, stopExternalRuntime } from '../electron/external-runtime'

const roots: string[] = []
afterEach(async () => {
  __setExternalRuntimeDeps(null)
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'external-runtime-test-'))
  roots.push(dir)
  return dir
}

const CMD_SHELL = 18100
const DSH_NODE = 3420
const NODE_BIN = 'C:/launcher-data/dsh-runtime/versions/0.2.1-rc.3/node_modules/.pnpm/@deepseek-ai+dsh-harness/lib/bin.js'
function snapshot(): string {
  return JSON.stringify([
    { pid: CMD_SHELL, name: 'cmd.exe', commandLine: 'C:\\Windows\\system32\\cmd.exe /d /s /c "node ' + NODE_BIN + ' --profile pack-test --no-open --port 3080"', startedAt: '2024-05-01T10:00:00.0000000Z', elevated: true },
    { pid: DSH_NODE, name: 'node.exe', commandLine: '"C:\\Program Files\\nodejs\\node.exe" "' + NODE_BIN + '" --profile pack-test --no-open --port 3080', startedAt: '2024-05-01T10:00:01.0000000Z', elevated: true },
  ])
}

describe('scanExternalRuntimes', () => {
  it('parses one snapshot, prefers the bin.js node process over the cmd shell and reports port/elevation', async () => {
    const scripts: string[] = []
    __setExternalRuntimeDeps({ runPowerShell: async script => { scripts.push(script); return snapshot() } })
    const found = await scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }, { id: 'other', profileName: 'other' }] })
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('Win32_Process')
    expect(scripts[0]).toContain('OpenProcess')
    expect(found.has('other')).toBe(false)
    const target = found.get('pack-test') as ExternalRuntime
    expect(target.pid).toBe(DSH_NODE)
    expect(target.port).toBe(3080)
    expect(target.url).toBe('http://127.0.0.1:3080/')
    expect(target.profileName).toBe('pack-test')
    expect(target.requiresElevation).toBe(true)
    expect(target.startedAt).toBe('2024-05-01T10:00:01.0000000Z')
    expect(target.elevatedSession).toBeNull()
  })

  // 用户报障现场PID 3420 的真实命令行：开关与值各自带引号，bin.js 走 .bin\..\.pnpm 转发路径。
  const REAL_ELEVATED_LINE = String.raw`node   "D:\engine\DSH\launcher-data\dsh-runtime\versions\0.2.1-rc.3\node_modules\.bin\\..\.pnpm\@deepseek-ai+dsh@0.2.1-rc.3_69264b859931b00ba724a30ed3ade154\node_modules\@deepseek-ai\dsh\lib\bin.js" "--profile" "pack-test" "--no-open" "--port" "3080"`

  it('matches the quoted switch form the launcher itself spawns (real pid 3420 command line)', async () => {
    __setExternalRuntimeDeps({ runPowerShell: async () => JSON.stringify([
      { pid: CMD_SHELL, name: 'cmd.exe', commandLine: 'C:\\Windows\\system32\\cmd.exe /d /s /c ' + REAL_ELEVATED_LINE, elevated: true },
      { pid: DSH_NODE, name: 'node.exe', commandLine: REAL_ELEVATED_LINE, startedAt: '2026-02-11T09:12:44.0000000Z', elevated: true },
    ]) })
    const found = await scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }, { id: 'web', profileName: 'web' }] })
    expect(found.has('web')).toBe(false)
    const target = found.get('pack-test') as ExternalRuntime
    expect(target.pid).toBe(DSH_NODE)
    expect(target.profileName).toBe('pack-test')
    expect(target.port).toBe(3080)
    expect(target.url).toBe('http://127.0.0.1:3080/')
    expect(target.requiresElevation).toBe(true)
  })

  it('never reports the cmd wrapper even when its pid sorts first', async () => {
    __setExternalRuntimeDeps({ runPowerShell: async () => JSON.stringify([
      { pid: 3000, name: 'cmd.exe', commandLine: 'C:\\Windows\\system32\\cmd.exe /d /s /c ' + REAL_ELEVATED_LINE, elevated: true },
      { pid: DSH_NODE, name: 'node.exe', commandLine: REAL_ELEVATED_LINE, elevated: true },
    ]) })
    const found = await scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }] })
    expect(found.size).toBe(1)
    expect((found.get('pack-test') as ExternalRuntime).pid).toBe(DSH_NODE)
  })

  it('accepts every --profile / --port spelling, including quoted switch and value', async () => {
    const forms = [
      ' --profile pack-test --port 3080',
      ' --profile=pack-test --port=3080',
      ' --profile "pack-test" --port "3080"',
      ' "--profile" "pack-test" "--port" "3080"',
      ' "--profile"="pack-test" "--port"="3080"',
      ' --Profile=PACK-TEST --Port=3080',
    ]
    for (const form of forms) {
      __setExternalRuntimeDeps({ runPowerShell: async () => JSON.stringify([
        { pid: DSH_NODE, name: 'node.exe', commandLine: NODE_BIN + form, elevated: false },
      ]) })
      const found = await scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }] })
      expect(found.get('pack-test')?.pid, form).toBe(DSH_NODE)
      expect(found.get('pack-test')?.port, form).toBe(3080)
      expect(found.get('pack-test')?.profileName, form).toBe('pack-test')
    }
  })

  it('ignores excluded pids and non dsh processes', async () => {
    __setExternalRuntimeDeps({ runPowerShell: async () => JSON.stringify([
      { pid: DSH_NODE, name: 'node.exe', commandLine: NODE_BIN + ' --profile pack-test --port 3080', elevated: false },
      { pid: 777, name: 'node.exe', commandLine: 'node C:\\other\\server.js --profile pack-test --port 3080', elevated: false },
    ]) })
    expect((await scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }] })).size).toBe(1)
    __setExternalRuntimeDeps({ runPowerShell: async () => JSON.stringify([
      { pid: DSH_NODE, name: 'node.exe', commandLine: NODE_BIN + ' --profile pack-test --port 3080', elevated: false },
    ]) })
    expect((await scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }], excludePids: [DSH_NODE] })).size).toBe(0)
    expect((await scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }], excludePids: [DSH_NODE] })).size).toBe(0)
  })

  it('returns an empty map when PowerShell fails or hangs', async () => {
    __setExternalRuntimeDeps({ runPowerShell: async () => { throw new Error('命令执行超时：powershell.exe') } })
    await expect(scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }], timeoutMs: 50 })).resolves.toEqual(new Map())
    __setExternalRuntimeDeps({ runPowerShell: async () => 'not json at all' })
    await expect(scanExternalRuntimes({ packs: [{ id: 'pack-test', profileName: 'pack-test' }] })).resolves.toEqual(new Map())
  })

  it('caches a scan for 2000ms so a chatty pack.list does not respawn PowerShell', async () => {
    let clock = 1_000
    const runPowerShell = vi.fn(async () => snapshot())
    __setExternalRuntimeDeps({ runPowerShell, now: () => clock })
    const input = { packs: [{ id: 'pack-test', profileName: 'pack-test' }] }
    await scanExternalRuntimes(input)
    await scanExternalRuntimes(input)
    expect(runPowerShell).toHaveBeenCalledTimes(1)
    clock += 2_500
    await scanExternalRuntimes(input)
    expect(runPowerShell).toHaveBeenCalledTimes(2)
  })
})

describe('stopExternalRuntime', () => {
  function baseTarget(overrides?: Partial<ExternalRuntime>): ExternalRuntime {
    return { pid: DSH_NODE, port: 3080, startedAt: null, url: 'http://127.0.0.1:3080/', profileName: 'pack-test', requiresElevation: true, elevatedSession: null, ...overrides }
  }

  it('stops through the elevated session stop file when one was stashed', async () => {
    const dataDir = await tempRoot()
    const stopFile = path.join(dataDir, 'stop-flag')
    await mkdir(path.join(dataDir, 'elevated'), { recursive: true })
    await writeFile(path.join(dataDir, 'elevated', 'pack-test.json'), JSON.stringify({ version: 1, packId: 'pack-test', outerPid: 900, elevatedRoot: dataDir, stopFile }))
    let alive = true
    const written: string[] = []
    __setExternalRuntimeDeps({
      platform: 'win32',
      isAlive: () => alive,
      writeTextFile: async (file, text) => { written.push(file); await writeFile(file, text); alive = false },
    })
    await expect(stopExternalRuntime(baseTarget(), { dataDir, allowElevation: true })).resolves.toBe('session')
    expect(written).toEqual([stopFile])
    expect(await readFile(stopFile, 'utf8')).toBe('stop')
  })

  it('uses the session path the scan already resolved, not the profile name', async () => {
    const dataDir = await tempRoot()
    const stashDir = await tempRoot()
    const stopFile = path.join(stashDir, 'stop-flag')
    await writeFile(path.join(stashDir, 'pack-uuid.json'), JSON.stringify({ version: 1, packId: 'pack-uuid', outerPid: 900, stopFile }))
    let alive = true
    __setExternalRuntimeDeps({
      platform: 'win32',
      isAlive: () => alive,
      writeTextFile: async (file, text) => { await writeFile(file, text); alive = false },
    })
    const target = baseTarget({ elevatedSession: path.join(stashDir, 'pack-uuid.json') })
    await expect(stopExternalRuntime(target, { dataDir, allowElevation: false })).resolves.toBe('session')
    expect(await readFile(stopFile, 'utf8')).toBe('stop')
  })

  it('falls back to taskkill when no session was stashed', async () => {
    const dataDir = await tempRoot()
    let alive = true
    const commands: string[][] = []
    __setExternalRuntimeDeps({
      platform: 'win32',
      isAlive: () => alive,
      runCommand: async (command, args) => { commands.push([command, ...args]); alive = false; return { code: 0, stdout: '', stderr: '' } },
    })
    await expect(stopExternalRuntime(baseTarget(), { dataDir, allowElevation: true })).resolves.toBe('taskkill')
    expect(commands).toEqual([['taskkill', '/pid', String(DSH_NODE), '/t', '/f']])
  })

  it('raises one UAC prompt only when the silent paths failed and elevation is allowed', async () => {
    const dataDir = await tempRoot()
    let alive = true
    const scripts: string[] = []
    __setExternalRuntimeDeps({
      platform: 'win32',
      isAlive: () => alive,
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      runPowerShell: async script => { scripts.push(script); alive = false; return '' },
      now: (() => { let clock = 0; return () => (clock += 5_000) })(),
      sleep: async () => undefined,
    })
    await expect(stopExternalRuntime(baseTarget(), { dataDir, allowElevation: true })).resolves.toBe('elevated')
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('-Verb RunAs')
    expect(scripts[0]).toContain('taskkill.exe /pid ' + DSH_NODE + ' /t /f')
  })

  it('throws the Chinese admin message instead of reporting a fake success', async () => {
    const dataDir = await tempRoot()
    let alive = true
    __setExternalRuntimeDeps({
      platform: 'win32',
      isAlive: () => alive,
      runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
      now: (() => { let clock = 0; return () => (clock += 5_000) })(),
      sleep: async () => undefined,
    })
    const failing = stopExternalRuntime(baseTarget(), { dataDir, allowElevation: false })
    await expect(failing).rejects.toThrow('结束整合包的 DSH 进程需要管理员权限（PID ' + DSH_NODE + '）。请在管理员 PowerShell 里执行：taskkill /pid ' + DSH_NODE + ' /t /f')
  })
})
