import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings } from '../src/types'
import { readCredential } from '../electron/credentials'
import { credentialNameForRoute, listCustomApiProviders } from '../electron/custom-api'
import { createLauncherControl } from '../electron/launcher-control'
import { createLauncherControlServer } from '../electron/launcher-control-server'
import { readPackApiGrants } from '../electron/pack-api-grants'
import { writePackRegistry, type PackRecord } from '../electron/pack-registry'
import { defaultSettings } from '../electron/settings'

const exec = promisify(execFile)
const cliPath = path.resolve('bin/launcher-control.cjs')
const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'launcher-api-cli-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const homeA = path.join(root, 'home-alpha')
  const homeB = path.join(root, 'home-beta')
  await mkdir(homeA, { recursive: true })
  await mkdir(homeB, { recursive: true })
  const records: PackRecord[] = [
    { id: 'alpha', name: 'alpha', description: '', version: '1', homePath: homeA, source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] },
    { id: 'beta', name: 'beta', description: '', version: '1', homePath: homeB, source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] },
  ]
  await writePackRegistry(path.join(root, 'packs.json'), records)
  let stored: AppSettings = { ...defaultSettings({ homeDirectory: path.join(root, 'user'), documentsDirectory: path.join(root, 'docs') }), dshHome: homeA }
  const settings = {
    read: async () => stored,
    readStored: async () => stored,
    save: async (next: AppSettings) => {
      stored = { ...next }
      return stored
    },
  }
  const loginRegistration = vi.fn()
  const control = createLauncherControl({
    userData: root,
    cliPath,
    settings: settings as never,
    packManager: {} as never,
    prepareNodeRuntime: vi.fn(),
    preparePnpmRuntime: vi.fn(),
    openExternal: vi.fn(),
    fallbackWorkspace: () => root,
    fetchImpl: fetch,
    emitOutput: () => undefined,
    loginRegistration,
    storage: {} as never,
    legacyRuntimeRunning: () => false,
  })
  const server = await createLauncherControlServer({ userData: root, execute: request => control.execute(request) })
  cleanups.push(() => server.close())
  const run = (...args: string[]) => exec(process.execPath, [cliPath, '--user-data', root, ...args], { timeout: 20000 })
  return { root, homeA, homeB, run, loginRegistration, settings }
}

async function addAcme(f: Awaited<ReturnType<typeof fixture>>) {
  return f.run('api', 'add', 'acme', '--name', 'Acme', '--base-url', 'https://api.acme.test/v1', '--protocol', 'openai-completions', '--models', 'acme-1,acme-2', '--api-key', 'sk-acme')
}

describe('launcher control cli: api library and launch at login', () => {
  it('enables launcher launch at login from the CLI', async () => {
    const f = await fixture()
    const current = await f.run('settings', 'launch-at-login')
    console.log('[cli] settings launch-at-login\n' + current.stdout.trim())
    expect(JSON.parse(current.stdout)).toEqual({ launchAtLogin: false })
    const enabled = await f.run('settings', 'launch-at-login', 'on')
    console.log('[cli] settings launch-at-login on\n' + enabled.stdout.trim())
    expect(JSON.parse(enabled.stdout)).toEqual({ launchAtLogin: true })
    expect(f.loginRegistration).toHaveBeenLastCalledWith(true)
    expect((await f.settings.readStored()).launchAtLogin).toBe(true)
    const off = await f.run('settings', 'launch-at-login', 'off')
    expect(JSON.parse(off.stdout)).toEqual({ launchAtLogin: false })
    expect(f.loginRegistration).toHaveBeenLastCalledWith(false)
  })

  it('adds, lists and removes a launcher API from the CLI', async () => {
    const f = await fixture()
    const added = await addAcme(f)
    console.log('[cli] api add acme\n' + added.stdout.trim())
    expect(JSON.parse(added.stdout)).toEqual([
      { route: 'acme', displayName: 'Acme', baseUrl: 'https://api.acme.test/v1', protocol: 'openai-completions', modelIds: ['acme-1', 'acme-2'], hasApiKey: true },
    ])
    const list = await f.run('api', 'list', '--json')
    expect(JSON.parse(list.stdout)).toHaveLength(1)
    const removed = await f.run('api', 'remove', 'acme', '--json')
    expect(JSON.parse(removed.stdout)).toEqual([])
    expect(JSON.parse((await f.run('api', 'list', '--json')).stdout)).toEqual([])
  })

  it('grants a library API to one pack from the CLI', async () => {
    const f = await fixture()
    await addAcme(f)
    const initial = await f.run('pack', 'api', 'list', 'alpha')
    console.log('[cli] pack api list alpha\n' + initial.stdout.trim())
    expect(JSON.parse(initial.stdout)).toMatchObject({ packId: 'alpha', enabled: [], restartRequired: false, error: null })
    const enabled = await f.run('pack', 'api', 'enable', 'alpha', 'acme')
    console.log('[cli] pack api enable alpha acme\n' + enabled.stdout.trim())
    expect(JSON.parse(enabled.stdout)).toMatchObject({ packId: 'alpha', enabled: ['acme'], restartRequired: false, error: null })
    expect((await listCustomApiProviders(f.homeA)).map(provider => provider.route)).toEqual(['acme'])
    expect(await readCredential(f.homeA, credentialNameForRoute('acme'))).toBe('sk-acme')
    const disabled = await f.run('pack', 'api', 'disable', 'alpha', 'acme')
    expect(JSON.parse(disabled.stdout)).toMatchObject({ packId: 'alpha', enabled: [] })
    expect(await listCustomApiProviders(f.homeA)).toEqual([])
    expect(await readCredential(f.homeA, credentialNameForRoute('acme'))).toBeNull()
  })

  it('D2 re-syncs updated library values into a pack that already has the grant', async () => {
    const f = await fixture()
    await addAcme(f)
    await f.run('pack', 'api', 'enable', 'alpha', 'acme', '--json')
    const updated = await f.run('api', 'add', 'acme', '--name', 'Acme Pro', '--base-url', 'https://api2.acme.test/v2', '--protocol', 'openai-responses', '--models', 'acme-3', '--json')
    expect(JSON.parse(updated.stdout)).toMatchObject([{ route: 'acme', displayName: 'Acme Pro', baseUrl: 'https://api2.acme.test/v2', protocol: 'openai-responses', modelIds: ['acme-3'], hasApiKey: true }])
    expect(await listCustomApiProviders(f.homeA)).toMatchObject([{ route: 'acme', displayName: 'Acme Pro', baseUrl: 'https://api2.acme.test/v2', protocol: 'openai-responses', modelIds: ['acme-3'], hasApiKey: true }])
    expect(await readCredential(f.homeA, credentialNameForRoute('acme'))).toBe('sk-acme')
    expect(await listCustomApiProviders(f.homeB)).toEqual([])
  })

  it('D2 moves a granted provider to the new route when the library entry is renamed', async () => {
    const f = await fixture()
    await addAcme(f)
    await f.run('pack', 'api', 'enable', 'alpha', 'acme', '--json')
    const args = { originalRoute: 'acme', route: 'acme-two', displayName: 'Acme Two', baseUrl: 'https://api.acme.test/v1', protocol: 'openai-completions', modelIds: ['acme-1'] }
    const renamed = await f.run('request', 'api.save', '--args', JSON.stringify(args), '--json')
    console.log('[cli] request api.save (rename acme -> acme-two)\n' + renamed.stdout.trim())
    expect(JSON.parse(renamed.stdout)).toMatchObject([{ route: 'acme-two', displayName: 'Acme Two', hasApiKey: true }])
    const providers = await listCustomApiProviders(f.homeA)
    expect(providers.map(provider => provider.route)).toEqual(['acme-two'])
    expect(providers[0]).toMatchObject({ displayName: 'Acme Two', hasApiKey: true })
    expect(await readCredential(f.homeA, credentialNameForRoute('acme-two'))).toBe('sk-acme')
    expect(await readCredential(f.homeA, credentialNameForRoute('acme'))).toBeNull()
    expect((await readPackApiGrants(f.root)).grants).toEqual({ alpha: ['acme-two'] })
    expect(JSON.parse((await f.run('pack', 'api', 'list', 'alpha', '--json')).stdout)).toMatchObject({ enabled: ['acme-two'], error: null })
    expect(await listCustomApiProviders(f.homeB)).toEqual([])
  })

  it('D2 cascades a library removal to every pack that had the grant', async () => {
    const f = await fixture()
    await addAcme(f)
    await f.run('pack', 'api', 'enable', 'alpha', 'acme', '--json')
    const removed = await f.run('api', 'remove', 'acme')
    console.log('[cli] api remove acme\n' + removed.stdout.trim())
    const state = await f.run('pack', 'api', 'list', 'alpha')
    console.log('[cli] pack api list alpha (after api remove)\n' + state.stdout.trim())
    expect(JSON.parse(removed.stdout)).toEqual([])
    expect(JSON.parse(state.stdout)).toMatchObject({ enabled: [], restartRequired: false, error: null })
    expect(await listCustomApiProviders(f.homeA)).toEqual([])
    expect(await readCredential(f.homeA, credentialNameForRoute('acme'))).toBeNull()
    expect((await readPackApiGrants(f.root)).grants).toEqual({ alpha: [] })
    await expect(readFile(path.join(f.homeB, 'settings.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(path.join(f.homeB, '.credentials.yaml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports bad arguments and unknown routes with exit code 1', async () => {
    const f = await fixture()
    await expect(f.run('pack', 'api', 'enable', 'alpha', 'ghost-api')).rejects.toMatchObject({ code: 1, stdout: '', stderr: expect.stringContaining('启动器 API 库里没有该路由') })
    await expect(f.run('settings', 'launch-at-login', 'maybe')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('settings launch-at-login') })
    await expect(f.run('api', 'add', 'Acme', '--name', 'Acme', '--base-url', 'https://api.acme.test/v1', '--protocol', 'openai-completions', '--models', 'acme-1')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('路由只能使用小写字母、数字和横线') })
    await expect(f.run('api', 'remove')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('用法：api remove <route>') })
  })
})
