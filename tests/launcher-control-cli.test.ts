import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createLauncherControlServer } from '../electron/launcher-control-server'
import { ensureLauncherControlSkill } from '../electron/launcher-control-skill'

const exec = promisify(execFile)
const cliPath = path.resolve('bin/launcher-control.cjs')
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function temporary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'launcher-control-cli-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}
async function fixture() {
  const userData = await temporary()
  const requests: unknown[] = []
  const server = await createLauncherControlServer({ userData, execute: async request => {
    requests.push(request)
    if (request.packId === 'missing') throw new Error('Unknown pack: missing')
    if (request.command === 'pack.list') return { packs: [{ id: 'pack-a', runtime: { phase: 'running' } }] }
    return request
  } })
  cleanups.push(() => server.close())
  const run = (...args: string[]) => exec(process.execPath, [cliPath, '--user-data', userData, ...args], { timeout: 10000 })
  return { userData, run, requests }
}
describe('launcher control CLI real Node processes', () => {
  it('lists packs and explicitly targets runtime commands', async () => {
    const f = await fixture()
    expect(JSON.parse((await f.run('pack', 'list', '--json')).stdout).packs[0].id).toBe('pack-a')
    for (const operation of ['start', 'stop', 'restart']) {
      expect(JSON.parse((await f.run('pack', operation, 'pack-a', '--json')).stdout)).toEqual({ command: 'pack.' + operation, packId: 'pack-a' })
    }
  })
  it('sends config patches, settings and resource passthrough without changing values', async () => {
    const f = await fixture()
    const result = await f.run('pack', 'config', 'set', 'pack-a', '--port', '3081', '--port-mode', 'fixed', '--auto-start', 'false', '--run-as-admin', 'false', '--launch-args', '["web","--foo"]', '--pinned-at', 'null', '--json')
    expect(JSON.parse(result.stdout)).toEqual({ command: 'pack.config.set', packId: 'pack-a', args: { port: 3081, portMode: 'fixed', autoStart: false, runAsAdmin: false, launchArgs: ['web', '--foo'], pinnedAt: null } })
    expect(JSON.parse((await f.run('pack', 'config', 'get', 'pack-a', '--json')).stdout).command).toBe('pack.config.get')
    expect(JSON.parse((await f.run('settings', 'set', '--args', '{"openAfterLaunch":false}', '--json')).stdout).args).toEqual({ openAfterLaunch: false })
    expect(JSON.parse((await f.run('request', 'pack.resources.list', 'pack-a', '--args', '{"kind":"skills"}', '--json')).stdout)).toEqual({ command: 'pack.resources.list', packId: 'pack-a', args: { kind: 'skills' } })
  })
  it('maps resource aliases to targeted backend resource commands', async () => {
    const f = await fixture()
    for (const [operation, args] of [
      ['list', { kind: 'skills' }],
      ['enabled', { kind: 'skills', name: 'example', enabled: false }],
      ['remove', { kind: 'skills', name: 'example' }],
    ] as const) {
      const result = await f.run('resource', operation, 'pack-a', '--args', JSON.stringify(args), '--json')
      expect(JSON.parse(result.stdout)).toEqual({ command: 'pack.resources.' + operation, packId: 'pack-a', args })
    }
    await expect(f.run('resource', 'list', '--json')).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('explicit pack ID') })
  })
  it('exits nonzero on missing IDs, invalid flags, unavailable launcher and backend errors', async () => {
    const f = await fixture()
    for (const args of [['pack','stop'], ['pack','config','set','pack-a','--port','bad'], ['pack','stop','missing'], ['pack','stop','pack-a','--unknown']]) {
      await expect(f.run(...args, '--json')).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('"ok":false') })
    }
    await expect(f.run('pack', 'stop', 'missing')).rejects.toMatchObject({ stderr: expect.stringContaining('Unknown pack: missing') })
    const empty = await temporary()
    await expect(exec(process.execPath, [cliPath, '--user-data', empty, 'pack', 'list'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('unavailable') })
  })
  it('uses environment discovery and rejects invalid authentication metadata', async () => {
    const f = await fixture()
    const result = await exec(process.execPath, [cliPath, 'pack', 'list', '--json'], { env: { ...process.env, DSH_LAUNCHER_USER_DATA: f.userData } })
    expect(JSON.parse(result.stdout).packs).toHaveLength(1)
    const filename = path.join(f.userData, 'launcher-control.json')
    const original = JSON.parse(await readFile(filename, 'utf8'))
    await writeFile(filename, JSON.stringify({ ...original, token: '0'.repeat(64) }))
    await expect(f.run('pack', 'list', '--json')).rejects.toMatchObject({ stderr: expect.stringContaining('UNAUTHORIZED') })
    await writeFile(filename, JSON.stringify({ ...original, url: 'http://example.com/control' }))
    await expect(f.run('pack', 'list')).rejects.toMatchObject({ stderr: expect.stringContaining('Invalid launcher endpoint') })
    await writeFile(filename, JSON.stringify(original))
  })
})
describe('managed launcher skill', () => {
  it('installs an executable absolute CLI copy and exact targeted command examples', async () => {
    const root = await temporary()
    const options = { packHome: path.join(root, 'pack home'), userData: path.join(root, 'launcher data'), cliPath, packId: 'pack-a', nodePath: process.execPath }
    const installed = await ensureLauncherControlSkill(options)
    expect(installed.status).toBe('installed')
    const content = await readFile(installed.path, 'utf8')
    for (const phrase of ['name: launcher-control', 'pack', 'list', 'stop', 'restart', 'pack-a', 'DSH_LAUNCHER_USER_DATA', 'disconnect', 'settings', 'config']) expect(content).toContain(phrase)
    const argv = content.split('\n').filter(line => line.startsWith('[')).map(line => JSON.parse(line) as string[])
    expect(argv.some(args => args.includes('restart') && args.includes('pack-a'))).toBe(true)
    expect(path.isAbsolute(argv[0][1])).toBe(true)
    expect(await readFile(argv[0][1], 'utf8')).toBe(await readFile(cliPath, 'utf8'))
    expect((await exec(argv[0][0], [argv[0][1], '--help'])).stdout).toContain('pack start|stop|restart')
    expect((await ensureLauncherControlSkill(options)).status).toBe('preserved')
    expect((await ensureLauncherControlSkill({ ...options, packId: 'pack-b' })).status).toBe('updated')
  })
  it('preserves a custom skill without creating launcher tools', async () => {
    const root = await temporary()
    const packHome = path.join(root, 'pack')
    const target = path.join(packHome, 'skills', 'launcher-control', 'SKILL.md')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'my custom skill')
    expect((await ensureLauncherControlSkill({ packHome, userData: path.join(root, 'data'), cliPath })).status).toBe('preserved')
    expect(await readFile(target, 'utf8')).toBe('my custom skill')
  })
})
