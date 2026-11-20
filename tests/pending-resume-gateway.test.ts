import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPendingResumeQueue } from '../electron/pending-resume'

const BASE_URL = 'http://127.0.0.1:3080/?token=tok-1'

type Hop = { url: string; method: string; body: any; cookie: string }

function createGatewayFetch(sessions: unknown) {
  const hops: Hop[] = []
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const parsed = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    const headers = (init?.headers ?? {}) as Record<string, string>
    hops.push({ url, method, body: parsed, cookie: headers.cookie ?? '' })
    if (method === 'GET' && url === 'http://127.0.0.1:3080/connect?token=tok-1') {
      // 新版网关用 302 带 cookie 指向 RPC 端点，跟过去只会拿到 404。
      return new Response('', {
        status: 302,
        headers: { location: './api/remote.mux', 'set-cookie': 'dsh-auth-x=v2.cookie; Path=/; HttpOnly' },
      })
    }
    if (method === 'POST' && url === 'http://127.0.0.1:3080/api/session/list') {
      return new Response(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: true, value: sessions } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (method === 'POST' && url === 'http://127.0.0.1:3080/api/session/prompt') {
      return new Response(JSON.stringify({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: true, value: { accepted: true } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error('unexpected request: ' + method + ' ' + url)
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, hops }
}

async function queueAt(file: string, fetchImpl: typeof fetch) {
  const dir = path.dirname(file)
  await mkdtemp(path.join(os.tmpdir(), 'pending-gw-')).then(async created => {
    void created
  })
  return createPendingResumeQueue({ file, fetch: fetchImpl })
}

describe('pack gateway compatibility', () => {
  it('接受 /connect 的 302，并给 RPC 参数补上 _request', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pending-gw-'))
    const fake = createGatewayFetch({ items: [{ sessionId: 's-1', running: true }] })
    const queue = await queueAt(path.join(dir, 'pending-resumes.json'), fake.fetchImpl)
    await queue.enqueue({ packId: 'pack-a', prompt: '继续' })
    const delivered = await queue.deliver('pack-a', BASE_URL)
    expect(delivered[0].status).toBe('sent')
    expect(delivered[0].sessionId).toBe('s-1')
    expect(fake.hops[1].cookie).toBe('dsh-auth-x=v2.cookie')
    expect(fake.hops[1].body.payload.args._request).toEqual({})
    expect(fake.hops[2].body.payload.args._request).toEqual({})
    expect(fake.hops[2].body.payload.args.sessionId).toBe('s-1')
  })

  it('布尔 running 与字符串 status 都被认成运行中', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pending-gw-'))
    const fake = createGatewayFetch([
      { sessionId: 's-bool', running: true },
      { id: 's-old', status: 'running' },
      { sessionId: 's-idle', running: false },
    ])
    const queue = createPendingResumeQueue({ file: path.join(dir, 'pending-resumes.json'), fetch: fake.fetchImpl })
    await queue.enqueue({ packId: 'pack-a', prompt: '继续' })
    const delivered = await queue.deliver('pack-a', BASE_URL)
    expect(delivered[0].status).toBe('failed')
    expect(delivered[0].error).toContain('2 个正在运行的会话')
    expect(delivered[0].error).toContain('s-bool')
    expect(delivered[0].error).toContain('s-old')
    expect(delivered[0].error).not.toContain('s-idle')
  })
})
