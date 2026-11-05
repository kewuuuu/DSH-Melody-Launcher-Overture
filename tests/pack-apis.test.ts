import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppSettings } from '../src/types'
import { saveApiLibraryEntry } from '../electron/api-library'
import { readCredential } from '../electron/credentials'
import { credentialNameForRoute, listCustomApiProviders } from '../electron/custom-api'
import { packApiGrantsPath, readPackApiGrants } from '../electron/pack-api-grants'
import { createPackApis } from '../electron/pack-apis'
import { writePackRegistry, type PackRecord } from '../electron/pack-registry'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pack-apis-test-'))
  roots.push(root)
  return root
}

async function fixture() {
  const root = await temporary()
  const registryPath = path.join(root, 'packs.json')
  const homeA = path.join(root, 'pack-a')
  await mkdir(homeA, { recursive: true })
  const records: PackRecord[] = [
    { id: 'a', name: 'a', description: '', version: '1', homePath: homeA, source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] },
  ]
  await writePackRegistry(registryPath, records)
  const running = new Set<string>()
  const settings = { dshHome: path.join(root, 'default-home') } as AppSettings
  const packApis = createPackApis({ userData: root, registryPath, readSettings: async () => settings, isPackRunning: id => running.has(id) })
  return { root, homeA, packApis, running }
}

async function addLibraryEntry(root: string): Promise<void> {
  await saveApiLibraryEntry(root, { route: 'acme', displayName: 'Acme', baseUrl: 'https://api.acme.test/v1', protocol: 'openai-completions', modelIds: ['acme-1'], apiKey: 'sk-acme' })
}

describe('pack api grants', () => {
  it('rejects an unknown pack without writing anything', async () => {
    const f = await fixture()
    await expect(f.packApis.getState('ghost')).rejects.toThrow('Unknown pack: ghost')
    await expect(f.packApis.setGrant('ghost', 'acme', true)).rejects.toThrow('Unknown pack: ghost')
    await expect(readFile(packApiGrantsPath(f.root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a route that is not in the library before touching the grant record', async () => {
    const f = await fixture()
    await expect(f.packApis.setGrant('a', 'ghost-api', true)).rejects.toThrow('启动器 API 库里没有该路由：ghost-api')
    await expect(readFile(packApiGrantsPath(f.root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listCustomApiProviders(f.homeA)).toEqual([])
  })

  it('enables a library API by writing the provider and secret into the pack home', async () => {
    const f = await fixture()
    await addLibraryEntry(f.root)
    const state = await f.packApis.setGrant('a', 'acme', true)
    expect(state).toEqual({
      packId: 'a',
      enabled: ['acme'],
      available: [{ route: 'acme', displayName: 'Acme', baseUrl: 'https://api.acme.test/v1', protocol: 'openai-completions', modelIds: ['acme-1'], hasApiKey: true }],
      restartRequired: false,
      error: null,
    })
    const providers = await listCustomApiProviders(f.homeA)
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({ route: 'acme', displayName: 'Acme', baseUrl: 'https://api.acme.test/v1', protocol: 'openai-completions', modelIds: ['acme-1'], hasApiKey: true })
    expect(await readCredential(f.homeA, credentialNameForRoute('acme'))).toBe('sk-acme')
    expect((await readPackApiGrants(f.root)).grants).toEqual({ a: ['acme'] })
  })

  it('disables a grant by removing the provider and the secret from the pack home', async () => {
    const f = await fixture()
    await addLibraryEntry(f.root)
    await f.packApis.setGrant('a', 'acme', true)
    const state = await f.packApis.setGrant('a', 'acme', false)
    expect(state.enabled).toEqual([])
    expect(state.error).toBeNull()
    expect(await listCustomApiProviders(f.homeA)).toEqual([])
    expect(await readCredential(f.homeA, credentialNameForRoute('acme'))).toBeNull()
    expect((await readPackApiGrants(f.root)).grants).toEqual({ a: [] })
  })

  it('tolerates disabling a grant whose provider is already gone', async () => {
    const f = await fixture()
    await addLibraryEntry(f.root)
    await f.packApis.setGrant('a', 'acme', true)
    await rm(path.join(f.homeA, 'settings.yaml'))
    const state = await f.packApis.setGrant('a', 'acme', false)
    expect(state).toMatchObject({ enabled: [], error: null })
  })

  it('reports restartRequired while the pack is running and still applies the change', async () => {
    const f = await fixture()
    await addLibraryEntry(f.root)
    f.running.add('a')
    const state = await f.packApis.setGrant('a', 'acme', true)
    expect(state.restartRequired).toBe(true)
    expect(state.enabled).toEqual(['acme'])
    expect((await readPackApiGrants(f.root)).grants).toEqual({ a: ['acme'] })
  })

  it('rolls the grant back and records the reason when the sync fails', async () => {
    const f = await fixture()
    await addLibraryEntry(f.root)
    await writeFile(path.join(f.homeA, 'settings.yaml'), 'llm-pi-ai: [unclosed\n', 'utf8')
    const state = await f.packApis.setGrant('a', 'acme', true)
    expect(state.enabled).toEqual([])
    expect(state.error).toContain('DSH settings.yaml 格式无效')
    const store = await readPackApiGrants(f.root)
    expect(store.grants).toEqual({})
    expect(store.errors.a).toContain('DSH settings.yaml 格式无效')
  })

  it('clears a recorded sync error once the sync succeeds', async () => {
    const f = await fixture()
    await addLibraryEntry(f.root)
    await writeFile(path.join(f.homeA, 'settings.yaml'), 'llm-pi-ai: [unclosed\n', 'utf8')
    expect((await f.packApis.setGrant('a', 'acme', true)).error).toContain('DSH settings.yaml 格式无效')
    await writeFile(path.join(f.homeA, 'settings.yaml'), '{}\n', 'utf8')
    const state = await f.packApis.setGrant('a', 'acme', true)
    expect(state).toMatchObject({ enabled: ['acme'], error: null })
    expect((await readPackApiGrants(f.root)).errors).toEqual({})
  })
})
