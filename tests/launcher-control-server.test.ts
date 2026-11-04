import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createLauncherControlServer, MAX_CONTROL_PAYLOAD } from '../electron/launcher-control-server'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(execute: Parameters<typeof createLauncherControlServer>[0]['execute'] = async request => request) {
  const userData = await mkdtemp(path.join(os.tmpdir(), 'launcher-control-server-'))
  cleanups.push(() => rm(userData, { recursive: true, force: true }))
  const server = await createLauncherControlServer({ userData, execute })
  cleanups.push(() => server.close())
  const metadata = JSON.parse(await readFile(path.join(userData, 'launcher-control.json'), 'utf8'))
  const post = (body: string, headers: Record<string, string> = {}) => fetch(metadata.url, { method: 'POST', headers: { Authorization: 'Bearer ' + metadata.token, ...headers }, body })
  return { userData, server, metadata, post }
}
describe('launcher control server', () => {
  it('authenticates and returns JSON results with no token disclosure', async () => {
    const f = await fixture()
    const rejected = await f.post('{}', { Authorization: 'Bearer wrong' })
    expect(rejected.status).toBe(401)
    expect(await rejected.text()).not.toContain(f.metadata.token)
    const accepted = await f.post(JSON.stringify({ command: 'pack.list' }))
    expect(await accepted.json()).toEqual({ ok: true, result: { command: 'pack.list' } })
    const origin = await f.post('{}', { Origin: 'https://example.com' })
    expect(origin.status).toBe(403)
  })
  it('rejects malformed, oversized and untargeted requests before execution', async () => {
    let calls = 0
    const f = await fixture(async () => { calls++; return null })
    expect((await f.post('{')).status).toBe(400)
    expect((await f.post(JSON.stringify({ command: 'pack.stop' }))).status).toBe(400)
    expect((await f.post(JSON.stringify({ command: 'pack.list', args: [] }))).status).toBe(400)
    expect((await f.post('x'.repeat(MAX_CONTROL_PAYLOAD + 1))).status).toBe(413)
    expect(calls).toBe(0)
  })
  it('propagates backend errors and redacts tokens', async () => {
    let token = ''
    const f = await fixture(async () => { throw Object.assign(new Error('Unknown pack ' + token), { code: 'PACK_NOT_FOUND' }) })
    token = f.metadata.token
    const response = await f.post(JSON.stringify({ command: 'pack.start', packId: 'missing' }))
    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({ ok: false, error: { code: 'PACK_NOT_FOUND', message: 'Unknown pack [redacted]' } })
  })
  it('cleans its own metadata and does not remove a replacement endpoint', async () => {
    const f = await fixture()
    await writeFile(path.join(f.userData, 'launcher-control.json'), JSON.stringify({ token: 'replacement' }))
    await f.server.close()
    expect(JSON.parse(await readFile(path.join(f.userData, 'launcher-control.json'), 'utf8')).token).toBe('replacement')
    const g = await fixture()
    await g.server.close()
    await expect(readFile(path.join(g.userData, 'launcher-control.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
