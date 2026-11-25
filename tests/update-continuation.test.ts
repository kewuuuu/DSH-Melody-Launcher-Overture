import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LauncherUpdateStatus } from '../src/types'
import type { LauncherApplyOptions } from '../electron/launcher-update'
import { buildApplyCommand } from '../electron/launcher-update-helper'
import { readRunningSessions, sendExactResume, verifyExactResumeSession } from '../electron/pending-resume'
import { defaultSettings } from '../electron/settings'
import { armUpdateContinuation, clearUpdateContinuation, consumeUpdateContinuation, saveUpdateContinuation, UPDATE_CONTINUATION_FLAG } from '../electron/update-continuation'
import { createUpdateFlow } from '../electron/update-flow'

const NOW = 1_800_000_000_000
const ID = '2ff065d2-1c98-4b56-bccc-4a6e351ec279'
const resume = { packId: 'pack-a', sessionId: 'original', prompt: 'Continue the turn' }
const identity = { pid: 1234, port: 3080, creationFileTime: '134446176000000000' }
const url = 'http://127.0.0.1:3080/web?token=test-a'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'update-continuation-'))
  directories.push(dir)
  return dir
}

function gateway(sessions: () => unknown, promptResponse = () => Promise.resolve({ accepted: true })) {
  const calls: { method: string; args: Record<string, unknown> }[] = []
  const fetch: typeof globalThis.fetch = async (target, request) => {
    const endpoint = new URL(String(target))
    if (endpoint.pathname === '/connect') {
      expect(request?.redirect).toBe('manual')
      expect(endpoint.searchParams.get('token')).toBe('test-a')
      return new Response('', { status: 302, headers: { 'set-cookie': 'auth=secret; Path=/; HttpOnly' } })
    }
    const args = JSON.parse(String(request?.body)).payload.args
    expect(request?.headers).toMatchObject({ cookie: 'auth=secret' })
    expect(request?.redirect).toBe('error')
    expect(args._request).toEqual({})
    calls.push({ method: endpoint.pathname, args })
    const value = endpoint.pathname.endsWith('/list') ? sessions() : await promptResponse()
    return Response.json({ result: { ok: true, value } })
  }
  return { fetch, calls, prompts: () => calls.filter(call => call.method.endsWith('/prompt')).map(call => call.args) }
}

function releaseStatus(state: LauncherUpdateStatus['state']): LauncherUpdateStatus {
  return { state, localVersion: '1.3.4', remoteVersion: '1.3.5', releaseUrl: null, assetName: null, assetSize: null, message: '', checkedAt: null }
}

async function fixture(options: { noUpdate?: boolean; failHelper?: boolean; saveFails?: boolean } = {}) {
  const userData = await tempDir()
  let clock = NOW
  let active = true
  let unknown = false
  let worker = identity
  let sessions = [resume.sessionId]
  let afterPoll: (() => Promise<void>) | undefined
  const running = gateway(() => unknown ? { invalid: true } : sessions.map(id => ({ id, running: active })))
  const apply = vi.fn(async (applyOptions?: LauncherApplyOptions) => {
    await applyOptions?.beforeCommit?.()
    applyOptions?.onCommit?.()
    if (options.failHelper) throw new Error('helper launch failed')
  })
  const services = createUpdateFlow({
    preserveRunningPacks: true,
    settings: { read: async () => defaultSettings({ homeDirectory: userData, documentsDirectory: userData, platform: 'win32' }) },
    updater: { check: async () => releaseStatus(options.noUpdate ? 'up-to-date' : 'update-available'), download: async () => releaseStatus('downloaded'), apply },
    listRunningPacks: async () => [{ id: resume.packId, url, identity: worker }],
    countRunningSessions: async (baseUrl, signal) => (await readRunningSessions({ baseUrl, signal, fetch: running.fetch })).length,
    saveResume: async () => { throw new Error('legacy stop/restart must not be used') },
    clearResume: async () => { throw new Error('legacy stop/restart must not be used') },
    continuation: {
      verifySession: (pack, sessionId, signal) => verifyExactResumeSession({ baseUrl: pack.url, sessionId, signal, fetch: running.fetch }),
      save: entry => options.saveFails ? Promise.reject(new Error('staging failed')) : saveUpdateContinuation(userData, entry),
      clear: () => clearUpdateContinuation(userData),
    },
    now: () => clock,
    wait: async ms => { clock += ms; await afterPoll?.() },
  })
  const findRuntime = vi.fn(async () => ({ url, identity: worker }))
  const boot = (operationId: string, overrides?: Partial<Parameters<typeof consumeUpdateContinuation>[0]>) => consumeUpdateContinuation({
    argv: ['--adopt-running-packs', UPDATE_CONTINUATION_FLAG + operationId], version: '1.3.5', reconciled: true, userData, findRuntime,
    deliver: input => sendExactResume({ ...input, signal: new AbortController().signal, fetch: running.fetch }), now: () => clock,
    ...overrides,
  })
  return {
    services, apply, boot, findRuntime, running, userData,
    idle: () => { active = false },
    malformed: () => { unknown = true },
    sessions: (ids: string[]) => { sessions = ids },
    runtime: (value: typeof identity) => { worker = value },
    afterPoll: (callback: () => Promise<void>) => { afterPoll = callback },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(finish => { resolve = finish })
  return { resolve, promise }
}

describe('update-only continuation', () => {
  it('acknowledges first, waits even with force and sends once to the original adopted session on matching startup', async () => {
    const f = await fixture()
    const waiting = deferred()
    const finishTurn = deferred()
    f.afterPoll(async () => { waiting.resolve(); await finishTurn.promise; f.idle() })
    expect(f.services.status()).toMatchObject({ supportsResume: true })
    const ack = await f.services.start({ resume, force: true })
    expect(ack).toMatchObject({ accepted: true, operationId: expect.any(String) })
    await waiting.promise
    expect(f.services.status()).toMatchObject({ phase: 'waiting', busy: [{ packId: 'pack-a' }] })
    expect(f.apply).not.toHaveBeenCalled()
    expect(f.running.prompts()).toHaveLength(0)
    finishTurn.resolve()
    await f.services.settled()
    expect(f.apply).toHaveBeenCalledWith(expect.objectContaining({ continuation: { operationId: ack.operationId, toVersion: '1.3.5' } }))
    expect(await f.boot(ID)).toBe(false)
    expect(await f.boot(ack.operationId!, { argv: ['--adopt-running-packs'] })).toBe(false)
    const startup = await Promise.all([f.boot(ack.operationId!), f.boot(ack.operationId!)])
    expect(startup.sort()).toEqual([false, true])
    expect(f.findRuntime).toHaveBeenCalledExactlyOnceWith('pack-a')
    expect(await f.boot(ack.operationId!)).toBe(false)
    expect(f.running.prompts()).toEqual([expect.objectContaining({ requestId: ack.operationId, sessionId: 'original', mode: 'queue', content: [{ type: 'text', text: resume.prompt }] })])
  })

  it.each(['cancelled', 'timeout', 'unknown', 'no update', 'helper failed', 'replaced before commit'])('does not deliver after %s', async scenario => {
    const f = await fixture({ noUpdate: scenario === 'no update', failHelper: scenario === 'helper failed' })
    const waiting = deferred()
    const proceed = deferred()
    if (scenario === 'helper failed') f.idle()
    f.afterPoll(async () => {
      if (scenario === 'unknown') f.malformed()
      if (scenario === 'replaced before commit') { f.runtime({ ...identity, pid: identity.pid + 1 }); f.idle() }
      if (scenario === 'cancelled') { waiting.resolve(); await proceed.promise }
    })
    const ack = await f.services.start({ resume, waitMinutes: 1 })
    if (scenario === 'cancelled') { await waiting.promise; await f.services.cancel(); proceed.resolve() }
    await f.services.settled()
    expect(await f.boot(ack.operationId!)).toBe(false)
    expect(f.running.prompts()).toHaveLength(0)
    expect(f.findRuntime).not.toHaveBeenCalled()
    expect(f.services.status().phase).toBe(['cancelled', 'no update'].includes(scenario) ? 'idle' : 'failed')
  })

  it('requires a known exact pair and durable registration before acknowledging', async () => {
    const f = await fixture()
    await expect(f.services.start({ resume: { ...resume, packId: 'other' } })).rejects.toThrow('目标整合包')
    await f.services.settled()
    await expect(f.services.start({ resume: { ...resume, sessionId: 'missing' } })).rejects.toThrow('指定会话')
    await f.services.settled()
    expect(f.apply).not.toHaveBeenCalled()
    const storageFailure = await fixture({ saveFails: true })
    await expect(storageFailure.services.start({ resume })).rejects.toThrow('staging failed')
    await storageFailure.services.settled()
    expect(storageFailure.apply).not.toHaveBeenCalled()
  })

  it.each(['unarmed', 'wrong version', 'expired', 'not reconciled', 'not ready', 'different PID', 'reused PID', 'different port', 'stale session'])('does not deliver on %s startup', async scenario => {
    const f = await fixture()
    const staged = { operationId: ID, resume, runtime: identity, handoff: null }
    await saveUpdateContinuation(f.userData, scenario === 'unarmed' ? staged : armUpdateContinuation(staged, '1.3.5', NOW))
    if (scenario === 'different PID') f.runtime({ ...identity, pid: identity.pid + 1 })
    if (scenario === 'reused PID') f.runtime({ ...identity, creationFileTime: '134446176000000001' })
    if (scenario === 'different port') f.runtime({ ...identity, port: identity.port + 1 })
    if (scenario === 'stale session') f.sessions(['different'])
    const completion = f.boot(ID, {
      version: scenario === 'wrong version' ? '1.3.4' : '1.3.5',
      reconciled: scenario !== 'not reconciled',
      ...(scenario === 'not ready' ? { findRuntime: async () => null } : {}),
      now: () => scenario === 'expired' ? NOW + 31 * 60_000 : NOW,
    })
    if (scenario === 'stale session') await expect(completion).rejects.toThrow('指定会话')
    else await expect(completion).resolves.toBe(false)
    expect(f.running.prompts()).toHaveLength(0)
    expect(await f.boot(ID)).toBe(false)
  })

  it('consumes the receipt before a prompt with an uncertain result and does not resend', async () => {
    const f = await fixture()
    await saveUpdateContinuation(f.userData, armUpdateContinuation({ operationId: ID, resume, runtime: identity, handoff: null }, '1.3.5', NOW))
    const gatewayError = gateway(() => [{ id: resume.sessionId, running: false }], () => Promise.reject(new Error('connection lost')))
    const deliver = (input: Parameters<Parameters<typeof consumeUpdateContinuation>[0]['deliver']>[0]) => sendExactResume({ ...input, signal: new AbortController().signal, fetch: gatewayError.fetch })
    await expect(f.boot(ID, { deliver })).rejects.toThrow('connection lost')
    expect(await f.boot(ID, { deliver })).toBe(false)
    expect(gatewayError.prompts()).toHaveLength(1)
  })

  it('only passes the operation ID on the successful installer branch', () => {
    const command = buildApplyCommand({ pid: 12, setupPath: 'C:/update/setup.exe', installDir: 'C:/install', exePath: 'C:/install/launcher.exe', logPath: 'C:/update/log', adoptRunningPacks: true, operationId: ID })
    expect(command).toContain('if not "%CODE%"=="0" goto setup_failed')
    expect(command.match(new RegExp(ID, 'g'))).toHaveLength(1)
    expect(command.indexOf(ID)).toBeGreaterThan(command.indexOf('goto setup_failed'))
    expect(command.indexOf(ID)).toBeLessThan(command.indexOf(':setup_failed\r\n'))
  })

  it.each([{}, { sessions: [{}] }, { items: ['bad entry'] }, [{ id: 's', state: ['idle'] }]])('requires a known gateway status for the idle check (%j)', async response => {
    const fake = gateway(() => response)
    await expect(readRunningSessions({ baseUrl: url, fetch: fake.fetch })).rejects.toThrow('无法确认')
  })
})
