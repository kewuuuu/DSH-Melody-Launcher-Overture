import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  PENDING_RESUME_MAX_ATTEMPTS,
  PENDING_RESUME_PROMPT_LIMIT,
  createPendingResumeQueue,
  enqueueBeforeRestart,
  type PendingResumeInput,
} from '../electron/pending-resume'
import type { PendingResumeEntry } from '../src/types'

const BASE_URL = 'http://127.0.0.1:3080/web?token=tok-1'
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function temporary(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pending-resume-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Hop {
  url: string
  method: string
  body: any
  cookie: string
}

function fakeResponse(body: unknown, cookies: string[] = []): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null, getSetCookie: () => cookies },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

type PromptResult = { ok: boolean; value?: unknown; error?: { code?: string; message?: string } }

function createFakeFetch(state: { sessions?: unknown; prompt?: (args: any) => PromptResult }) {
  const hops: Hop[] = []
  const fetchImpl = async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    const parsed = rawBody ? JSON.parse(rawBody) : null
    const headers = (init?.headers ?? {}) as Record<string, string>
    hops.push({ url, method, body: parsed, cookie: headers.cookie ?? '' })
    if (method === 'GET' && url === 'http://127.0.0.1:3080/connect?token=tok-1') {
      return fakeResponse('', ['dsh_session=token-1; Path=/'])
    }
    if (method === 'POST' && url === 'http://127.0.0.1:3080/api/session/list') {
      return fakeResponse({ type: 'server-response', rpcId: parsed.rpcId, result: { ok: true, value: state.sessions ?? [] } })
    }
    if (method === 'POST' && url === 'http://127.0.0.1:3080/api/session/prompt') {
      const result = state.prompt ? state.prompt(parsed.payload.args) : { ok: true, value: { accepted: true } }
      return fakeResponse({ type: 'server-response', rpcId: parsed.rpcId, result })
    }
    throw new Error('unexpected request: ' + method + ' ' + url)
  }
  return { fetchImpl: fetchImpl as unknown as typeof fetch, hops }
}

function queueAt(file: string, fetchImpl?: typeof fetch, now?: () => number) {
  return createPendingResumeQueue({ file, ...(fetchImpl ? { fetch: fetchImpl } : {}), ...(now ? { now } : {}) })
}

function stubEntry(input: PendingResumeInput): PendingResumeEntry {
  return {
    id: 'entry-1',
    packId: input.packId,
    prompt: input.prompt,
    requestId: 'request-1',
    createdAt: 0,
    attempts: 0,
    status: 'pending',
    error: null,
  }
}

describe('pending resume queue persistence', () => {
  it('enqueue 落盘后新实例可重读，信封带 version 与条目字段', async () => {
    const dir = await temporary()
    const file = path.join(dir, 'pending-resumes.json')
    const queue = queueAt(file, undefined, () => 1000)
    const entry = await queue.enqueue({ packId: 'pack-a', prompt: '继续刚才的分析' })
    expect(entry.status).toBe('pending')
    expect(entry.createdAt).toBe(1000)
    expect(entry.attempts).toBe(0)
    expect(entry.error).toBeNull()
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.entries).toHaveLength(1)
    expect(raw.entries[0]).toMatchObject({ id: entry.id, packId: 'pack-a', requestId: entry.requestId, prompt: '继续刚才的分析' })
    const reread = await queueAt(file).list()
    expect(reread).toHaveLength(1)
    expect(reread[0].id).toBe(entry.id)
    expect(await queueAt(file).list('pack-a')).toHaveLength(1)
    expect(await queueAt(file).list('other')).toHaveLength(0)
  })

  it('并发 enqueue 不丢条目', async () => {
    const dir = await temporary()
    const file = path.join(dir, 'pending-resumes.json')
    const queue = queueAt(file)
    const created = await Promise.all(Array.from({ length: 10 }, (_item, index) => queue.enqueue({ packId: 'pack-a', prompt: '请求 ' + index })))
    expect(new Set(created.map(item => item.id)).size).toBe(10)
    const entries = await queue.list()
    expect(entries).toHaveLength(10)
    expect(new Set(entries.map(item => item.requestId)).size).toBe(10)
    expect(JSON.parse(await readFile(file, 'utf8')).entries).toHaveLength(10)
  })

  it('缺失或损坏的队列文件按空处理，之后仍能写入', async () => {
    const dir = await temporary()
    const file = path.join(dir, 'pending-resumes.json')
    expect(await queueAt(file).list()).toEqual([])
    await writeFile(file, '{ this is not json', 'utf8')
    expect(await queueAt(file).list()).toEqual([])
    await queueAt(file).enqueue({ packId: 'pack-a', prompt: '写回来' })
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw.entries).toHaveLength(1)
  })

  it('拒绝空内容、超长内容和缺少包 ID', async () => {
    const dir = await temporary()
    const queue = queueAt(path.join(dir, 'pending-resumes.json'))
    await expect(queue.enqueue({ packId: 'pack-a', prompt: '   ' })).rejects.toThrow('续接内容不能为空')
    await expect(queue.enqueue({ packId: 'pack-a', prompt: 'x'.repeat(PENDING_RESUME_PROMPT_LIMIT + 1) })).rejects.toThrow('续接内容过长')
    await expect(queue.enqueue({ packId: ' ', prompt: '继续' })).rejects.toThrow('缺少整合包 ID')
  })
})

describe('pending resume delivery', () => {
  it('走 /connect → session/list → session/prompt 三跳并复用条目里的 requestId', async () => {
    const dir = await temporary()
    const fake = createFakeFetch({ sessions: [{ id: 's-1', title: '默认会话', status: 'running' }] })
    const queue = queueAt(path.join(dir, 'pending-resumes.json'), fake.fetchImpl)
    const entry = await queue.enqueue({ packId: 'pack-a', prompt: '继续' })
    const delivered = await queue.deliver('pack-a', BASE_URL)
    expect(delivered).toHaveLength(1)
    expect(delivered[0].status).toBe('sent')
    expect(delivered[0].sessionId).toBe('s-1')
    expect(fake.hops.map(hop => hop.method + ' ' + hop.url)).toEqual([
      'GET http://127.0.0.1:3080/connect?token=tok-1',
      'POST http://127.0.0.1:3080/api/session/list',
      'POST http://127.0.0.1:3080/api/session/prompt',
    ])
    expect(fake.hops[1].body).toMatchObject({ type: 'client-request', method: 'session/list', payload: { args: {} } })
    expect(fake.hops[1].cookie).toBe('dsh_session=token-1')
    expect(fake.hops[2].body).toMatchObject({
      type: 'client-request',
      method: 'session/prompt',
      payload: { args: { requestId: entry.requestId, sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: '继续' }] } },
    })
    expect(fake.hops[2].cookie).toBe('dsh_session=token-1')
    const stored = await queue.list()
    expect(stored[0].status).toBe('sent')
    const again = await queue.deliver('pack-a', BASE_URL)
    expect(again).toEqual([])
    expect(fake.hops).toHaveLength(3)
  })

  it('显式 sessionId 时跳过 session/list', async () => {
    const dir = await temporary()
    const fake = createFakeFetch({ sessions: [] })
    const queue = queueAt(path.join(dir, 'pending-resumes.json'), fake.fetchImpl)
    await queue.enqueue({ packId: 'pack-a', prompt: '继续', sessionId: 's-9' })
    const delivered = await queue.deliver('pack-a', BASE_URL)
    expect(delivered[0].status).toBe('sent')
    expect(fake.hops.map(hop => hop.url)).toEqual([
      'http://127.0.0.1:3080/connect?token=tok-1',
      'http://127.0.0.1:3080/api/session/prompt',
    ])
    expect(fake.hops[1].body.payload.args.sessionId).toBe('s-9')
  })

  it('没有 running 会话与多个 running 会话都给出中文错误', async () => {
    const dir = await temporary()
    const file = path.join(dir, 'pending-resumes.json')
    const empty = createFakeFetch({ sessions: [{ id: 's-1', title: '空闲', status: 'idle' }] })
    const queue = queueAt(file, empty.fetchImpl)
    await queue.enqueue({ packId: 'pack-a', prompt: '继续' })
    const none = await queue.deliver('pack-a', BASE_URL)
    expect(none[0].status).toBe('failed')
    expect(none[0].error).toContain('当前没有正在运行的会话')

    const many = createFakeFetch({ sessions: [
      { id: 's-1', title: '甲', status: 'running' },
      { id: 's-2', title: '乙', status: 'running' },
    ] })
    const second = queueAt(path.join(dir, 'second.json'), many.fetchImpl)
    await second.enqueue({ packId: 'pack-a', prompt: '继续' })
    const ambiguous = await second.deliver('pack-a', BASE_URL)
    expect(ambiguous[0].status).toBe('failed')
    expect(ambiguous[0].error).toContain('有 2 个正在运行的会话')
    expect(ambiguous[0].error).toContain('s-1（甲）')
    expect(ambiguous[0].error).toContain('--session')
  })

  it('失败累计 attempts，到上限后不再自动发送，retry 重置计数并重发同一个 requestId', async () => {
    const dir = await temporary()
    const state: { sessions?: unknown; prompt?: (args: any) => PromptResult } = {
      sessions: [{ id: 's-1', title: '默认会话', status: 'running' }],
      prompt: () => ({ ok: false, error: { code: 'CLOSED', message: '会话已关闭' } }),
    }
    const fake = createFakeFetch(state)
    const queue = queueAt(path.join(dir, 'pending-resumes.json'), fake.fetchImpl)
    const entry = await queue.enqueue({ packId: 'pack-a', prompt: '继续' })
    for (let round = 0; round < PENDING_RESUME_MAX_ATTEMPTS; round += 1) {
      const [attempt] = await queue.deliver('pack-a', BASE_URL)
      expect(attempt.status).toBe('failed')
      expect(attempt.error).toContain('发送续接消息失败：会话已关闭')
    }
    expect((await queue.list())[0].attempts).toBe(PENDING_RESUME_MAX_ATTEMPTS)
    const promptHops = fake.hops.filter(hop => hop.url.endsWith('/api/session/prompt'))
    expect(promptHops).toHaveLength(PENDING_RESUME_MAX_ATTEMPTS)
    expect(await queue.deliver('pack-a', BASE_URL)).toEqual([])
    expect(fake.hops.filter(hop => hop.url.endsWith('/api/session/prompt'))).toHaveLength(PENDING_RESUME_MAX_ATTEMPTS)

    const reset = await queue.retry(entry.id)
    expect(reset[0].attempts).toBe(0)
    expect(reset[0].status).toBe('pending')
    expect(reset[0].error).toBeNull()
    state.prompt = () => ({ ok: true, value: { accepted: true } })
    await expect(queue.retry(entry.id, BASE_URL)).resolves.toMatchObject([{ status: 'sent' }])
    const lastPrompt = fake.hops.filter(hop => hop.url.endsWith('/api/session/prompt')).at(-1)
    expect(lastPrompt?.body.payload.args.requestId).toBe(entry.requestId)
  })

  it('缺少 token 时报中文错误', async () => {
    const dir = await temporary()
    const fake = createFakeFetch({ sessions: [] })
    const queue = queueAt(path.join(dir, 'pending-resumes.json'), fake.fetchImpl)
    await queue.enqueue({ packId: 'pack-a', prompt: '继续' })
    const [failed] = await queue.deliver('pack-a', 'http://127.0.0.1:3080/web')
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('缺少 token 参数')
    expect(fake.hops).toHaveLength(0)
  })

  it('discard 删除条目且幂等，未找到的 retry 报中文错误', async () => {
    const dir = await temporary()
    const file = path.join(dir, 'pending-resumes.json')
    const queue = queueAt(file)
    const entry = await queue.enqueue({ packId: 'pack-a', prompt: '继续' })
    await queue.enqueue({ packId: 'pack-b', prompt: '另一条' })
    const remaining = await queue.discard(entry.id)
    expect(remaining).toHaveLength(1)
    expect(remaining[0].packId).toBe('pack-b')
    expect(await queue.discard(entry.id)).toHaveLength(1)
    await expect(queue.retry('missing')).rejects.toThrow('未找到续接请求：missing')
    expect(JSON.parse(await readFile(file, 'utf8')).entries).toHaveLength(1)
  })
})

describe('pending resume ordering helper', () => {
  it('先入队再重启，入队失败就不重启', async () => {
    const order: string[] = []
    const { entry, result } = await enqueueBeforeRestart(
      {
        enqueue: async (input: PendingResumeInput) => { order.push('enqueue'); return stubEntry(input) },
        restart: async () => { order.push('restart'); return { phase: 'running' } },
      },
      { packId: 'pack-a', prompt: '继续' },
    )
    expect(order).toEqual(['enqueue', 'restart'])
    expect(entry.packId).toBe('pack-a')
    expect(result).toEqual({ phase: 'running' })

    const failedOrder: string[] = []
    await expect(enqueueBeforeRestart(
      {
        enqueue: async () => { failedOrder.push('enqueue'); throw new Error('磁盘已满') },
        restart: async () => { failedOrder.push('restart'); return null },
      },
      { packId: 'pack-a', prompt: '继续' },
    )).rejects.toThrow('磁盘已满')
    expect(failedOrder).toEqual(['enqueue'])
  })
})
