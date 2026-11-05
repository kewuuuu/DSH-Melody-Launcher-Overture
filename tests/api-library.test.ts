import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LauncherApiEntryInput } from '../src/types'
import { apiLibraryPath, listApiLibrary, removeApiLibraryEntry, saveApiLibraryEntry } from '../electron/api-library'
import { readCredential } from '../electron/credentials'
import { credentialNameForRoute, listCustomApiProviders, saveCustomApiProvider } from '../electron/custom-api'
import { packApiGrantsPath, readPackApiGrants, writePackApiGrants } from '../electron/pack-api-grants'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporary(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'api-library-test-'))
  roots.push(root)
  return root
}

function input(route: string, overrides: Partial<LauncherApiEntryInput> = {}): LauncherApiEntryInput {
  return { route, displayName: 'Acme', baseUrl: 'https://api.acme.test/v1', protocol: 'openai-completions', modelIds: ['acme-1'], ...overrides }
}

describe('launcher api library', () => {
  it('persists entries without the secret and reports hasApiKey', async () => {
    const root = await temporary()
    const saved = await saveApiLibraryEntry(root, input('acme', { apiKey: 'sk-acme' }))
    expect(saved).toEqual([{ route: 'acme', displayName: 'Acme', baseUrl: 'https://api.acme.test/v1', protocol: 'openai-completions', modelIds: ['acme-1'], hasApiKey: true }])
    const raw = await readFile(apiLibraryPath(root), 'utf8')
    expect(raw).not.toContain('sk-acme')
    expect(JSON.parse(raw)).toMatchObject({ version: 1, entries: [{ route: 'acme' }] })
    expect(await readCredential(root, credentialNameForRoute('acme'))).toBe('sk-acme')
    expect(await listApiLibrary(root)).toHaveLength(1)
  })

  it('updates in place and keeps the stored secret when the update omits apiKey', async () => {
    const root = await temporary()
    await saveApiLibraryEntry(root, input('acme', { apiKey: 'sk-acme' }))
    const updated = await saveApiLibraryEntry(root, input('acme', { displayName: 'Acme Two', modelIds: ['acme-2'] }))
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ displayName: 'Acme Two', modelIds: ['acme-2'], hasApiKey: true })
    expect(await readCredential(root, credentialNameForRoute('acme'))).toBe('sk-acme')
  })

  it('rejects invalid routes and invalid payloads without writing the library file', async () => {
    const root = await temporary()
    await expect(saveApiLibraryEntry(root, input('Acme'))).rejects.toThrow('路由只能使用小写字母、数字和横线，并且必须以字母开头。')
    await expect(saveApiLibraryEntry(root, input('9acme'))).rejects.toThrow('路由只能使用小写字母、数字和横线，并且必须以字母开头。')
    await expect(saveApiLibraryEntry(root, input('acme--two'))).rejects.toThrow('路由只能使用小写字母、数字和横线，并且必须以字母开头。')
    await expect(saveApiLibraryEntry(root, input('acme', { baseUrl: 'ftp://api.acme.test' }))).rejects.toThrow('Base URL 必须是 HTTP(S) 地址，且不能包含账号或密码。')
    await expect(saveApiLibraryEntry(root, input('acme', { modelIds: [] }))).rejects.toThrow('至少需要填写一个模型 ID。')
    await expect(readFile(apiLibraryPath(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('renames a route, migrates the secret and rewrites every pack grant', async () => {
    const root = await temporary()
    await saveApiLibraryEntry(root, input('acme', { apiKey: 'sk-acme' }))
    await writePackApiGrants(root, { version: 1, grants: { 'pack-a': ['acme', 'other'], 'pack-b': [] }, errors: {} })
    const renamed = await saveApiLibraryEntry(root, input('acme-two', { originalRoute: 'acme' }))
    expect(renamed.map(entry => entry.route)).toEqual(['acme-two'])
    expect(renamed[0]).toMatchObject({ hasApiKey: true })
    expect(await readCredential(root, credentialNameForRoute('acme-two'))).toBe('sk-acme')
    expect(await readCredential(root, credentialNameForRoute('acme'))).toBeNull()
    expect((await readPackApiGrants(root)).grants).toEqual({ 'pack-a': ['acme-two', 'other'], 'pack-b': [] })
  })

  it('refuses to rename onto an existing route or from a route that does not exist', async () => {
    const root = await temporary()
    await saveApiLibraryEntry(root, input('acme'))
    await saveApiLibraryEntry(root, input('other'))
    await expect(saveApiLibraryEntry(root, input('acme', { originalRoute: 'other' }))).rejects.toThrow('目标路由已存在，请换一个路由名称。')
    await expect(saveApiLibraryEntry(root, input('ghost-two', { originalRoute: 'ghost' }))).rejects.toThrow()
    expect((await listApiLibrary(root)).map(entry => entry.route)).toEqual(['acme', 'other'])
  })

  it('removes the entry, its secret and its grants but leaves pack settings untouched', async () => {
    const root = await temporary()
    const packHome = path.join(root, 'pack-a-home')
    await mkdir(packHome, { recursive: true })
    await saveCustomApiProvider(packHome, { route: 'acme', displayName: 'Acme', baseUrl: 'https://api.acme.test/v1', protocol: 'openai-completions', modelIds: ['acme-1'], apiKey: 'pack-secret' })
    await saveApiLibraryEntry(root, input('acme', { apiKey: 'sk-acme' }))
    await writePackApiGrants(root, { version: 1, grants: { 'pack-a': ['acme'] }, errors: {} })
    expect(await removeApiLibraryEntry(root, 'acme')).toEqual([])
    expect(await readCredential(root, credentialNameForRoute('acme'))).toBeNull()
    expect((await readPackApiGrants(root)).grants).toEqual({ 'pack-a': [] })
    // 取舍：库里删条目只清授予记录，已经同步进包 settings.yaml 的 provider 原样保留。
    expect((await listCustomApiProviders(packHome)).map(provider => provider.route)).toEqual(['acme'])
    expect(await readCredential(packHome, credentialNameForRoute('acme'))).toBe('pack-secret')
  })

  it('reports a missing route when removing', async () => {
    const root = await temporary()
    await expect(removeApiLibraryEntry(root, 'ghost')).rejects.toThrow('没有找到该 API：ghost')
    await expect(readFile(packApiGrantsPath(root), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
