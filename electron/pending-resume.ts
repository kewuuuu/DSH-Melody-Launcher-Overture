import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { PendingResumeEntry } from '../src/types'
import { writeFileAtomic } from './fs-atomic'

export const PENDING_RESUMES_FILENAME = 'pending-resumes.json'
export const PENDING_RESUME_PROMPT_LIMIT = 8000
export const PENDING_RESUME_MAX_ATTEMPTS = 3
const CONNECT_PATH = '/connect'
const SESSION_LIST_METHOD = 'session/list'
const SESSION_PROMPT_METHOD = 'session/prompt'

export interface ExactResumeInput {
  packId: string
  sessionId: string
  prompt: string
}

export function parseExactResume(value: unknown): ExactResumeInput {
  if (!isRecord(value) || Object.keys(value).some(key => !['packId', 'sessionId', 'prompt'].includes(key))) {
    throw new Error('update.apply 的 resume 必须指定 packId、sessionId 和 prompt。')
  }
  const { packId, sessionId, prompt } = value
  if (typeof packId !== 'string' || !packId || packId !== packId.trim()
    || typeof sessionId !== 'string' || !sessionId || sessionId !== sessionId.trim()
    || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('update.apply 的 resume 必须指定准确的 packId、sessionId 和非空 prompt。')
  }
  if (prompt.length > PENDING_RESUME_PROMPT_LIMIT) {
    throw new Error('续接内容过长（最多 ' + PENDING_RESUME_PROMPT_LIMIT + ' 字符）。')
  }
  return { packId, sessionId, prompt }
}

export interface PendingResumeInput {
  packId: string
  prompt: string
  sessionId?: string
}

export interface PendingResumeQueue {
  list(packId?: string): Promise<PendingResumeEntry[]>
  enqueue(input: PendingResumeInput): Promise<PendingResumeEntry>
  deliver(packId: string, baseUrl: string): Promise<PendingResumeEntry[]>
  retry(id: string, baseUrl?: string): Promise<PendingResumeEntry[]>
  discard(id: string): Promise<PendingResumeEntry[]>
}

export interface PendingResumeQueueDeps {
  file: string
  fetch?: typeof globalThis.fetch
  now?: () => number
}

type Fetcher = typeof globalThis.fetch

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '未知错误'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function toEntry(value: unknown): PendingResumeEntry | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  const packId = readString(value.packId)
  const prompt = typeof value.prompt === 'string' ? value.prompt : ''
  const requestId = readString(value.requestId)
  const status = value.status
  if (!id || !packId || !prompt || !requestId) return null
  if (status !== 'pending' && status !== 'sent' && status !== 'failed') return null
  const entry: PendingResumeEntry = {
    id,
    packId,
    prompt,
    requestId,
    createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0,
    attempts: typeof value.attempts === 'number' && Number.isFinite(value.attempts) && value.attempts > 0 ? Math.floor(value.attempts) : 0,
    status,
    error: typeof value.error === 'string' ? value.error : null,
  }
  const sessionId = readString(value.sessionId)
  if (sessionId) entry.sessionId = sessionId
  return entry
}

async function readEntriesOf(file: string): Promise<PendingResumeEntry[]> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return []
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries
      : []
  const entries: PendingResumeEntry[] = []
  for (const item of list) {
    const entry = toEntry(item)
    if (entry) entries.push(entry)
  }
  return entries
}

async function writeEntriesOf(file: string, entries: PendingResumeEntry[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFileAtomic(file, JSON.stringify({ version: 1, entries }, null, 2) + '\n')
}

export interface RunningSession {
  id: string
  title: string
}

function resolveFetcher(injected?: Fetcher): Fetcher {
  if (injected) return injected
  if (typeof globalThis.fetch !== 'function') throw new Error('当前运行环境没有可用的 fetch，无法发送续接消息。')
  return globalThis.fetch
}

/** 从 <origin>/web?token=… 里拆出 Web 服务根地址与 token；续接与空闲判定共用这一份校验。 */
export function parsePackBaseUrl(baseUrl: string): { origin: string; token: string } {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('整合包 Web 服务地址无效：' + baseUrl)
  }
  const token = url.searchParams.get('token') ?? ''
  if (!token) throw new Error('续接地址缺少 token 参数，无法连接整合包 Web 服务。')
  return { origin: url.origin, token }
}

/** GET /connect?token=… 换出会话 cookie；续接与空闲判定共用。 */
async function connectPackSession(fetcher: Fetcher, origin: string, token: string, signal?: AbortSignal): Promise<string> {
  const target = origin + CONNECT_PATH + '?token=' + encodeURIComponent(token)
  // 新版网关的 /connect 用 302 把浏览器带到 RPC 端点；会话 cookie 就在这一跳里，不能跟过去。
  const init: RequestInit = { method: 'GET', redirect: 'manual' }
  if (signal) init.signal = signal
  let response: Response
  try {
    response = await fetcher(target, init)
  } catch (error) {
    throw new Error('连接整合包 Web 服务失败：' + messageOf(error))
  }
  if (!response.ok && (response.status < 300 || response.status >= 400)) {
    throw new Error('连接整合包 Web 服务失败（HTTP ' + response.status + '）。')
  }
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookies = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : []
  const pairs: string[] = []
  for (const cookie of rawCookies) {
    const pair = cookie.split(';')[0]?.trim() ?? ''
    if (pair) pairs.push(pair)
  }
  if (pairs.length === 0) {
    const fallback = headers.get('set-cookie')?.split(';')[0]?.trim() ?? ''
    if (fallback) pairs.push(fallback)
  }
  if (pairs.length === 0) throw new Error('连接整合包 Web 服务未返回会话 cookie，无法续接。')
  return pairs.join('; ')
}

/** POST /api/<method> 发一条 RPC；错误文案由 action 决定。 */
async function callPackRpc(fetcher: Fetcher, origin: string, method: string, args: unknown, cookie: string, action: string, signal?: AbortSignal): Promise<unknown> {
  // 0.2.1 起网关要求每个端点都带 _request 字段，缺了会报 arguments-invalid。
  const payloadArgs = isRecord(args) ? { _request: {}, ...args } : { _request: {} }
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: randomUUID(),
    method,
    payload: { args: payloadArgs },
  })
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    redirect: 'error',
    body,
  }
  if (signal) init.signal = signal
  let response: Response
  try {
    response = await fetcher(origin + '/api/' + method, init)
  } catch (error) {
    throw new Error(action + '失败：无法连接整合包 Web 服务（' + messageOf(error) + '）')
  }
  if (!response.ok) throw new Error(action + '失败：整合包 Web 服务返回 HTTP ' + response.status + '。')
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw new Error(action + '失败：读取响应内容出错（' + messageOf(error) + '）。')
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(action + '失败：整合包 Web 服务返回了无法解析的响应。')
  }
  if (!isRecord(payload) || !isRecord(payload.result)) {
    throw new Error(action + '失败：整合包 Web 服务返回了无法识别的响应。')
  }
  const result = payload.result
  if (result.ok !== true) {
    const error = isRecord(result.error) ? result.error : null
    const detail = error ? readString(error.message) || readString(error.code) : ''
    throw new Error(action + '失败：' + (detail || '整合包 Web 服务拒绝了请求。'))
  }
  return result.value
}

/** session/list 的返回值里挑出 running 的会话；形状不认识就当没有。 */
function runningSessionsOf(value: unknown): RunningSession[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions)
      ? value.sessions
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : []
  const running: RunningSession[] = []
  for (const item of list) {
    if (!isRecord(item)) continue
    // 新网关用布尔 running，旧形状用 status/state 字符串，两种都认。
    const status = readString(item.status) || readString(item.state)
    if (item.running !== true && status !== 'running') continue
    running.push({
      id: readString(item.id) || readString(item.sessionId) || readString(item.session_id),
      title: readString(item.title) || readString(item.name) || readString(item.summary),
    })
  }
  return running
}

function pickRunningSessionOf(packId: string, value: unknown): string {
  const running = runningSessionsOf(value)
  if (running.length === 0) {
    throw new Error('整合包「' + packId + '」当前没有正在运行的会话。请先在整合包里打开一个会话，或用 --session 指定会话 ID。')
  }
  if (running.length > 1) {
    const candidates = running.map((item) => (item.title ? item.id + '（' + item.title + '）' : item.id)).join('、')
    throw new Error('整合包「' + packId + '」有 ' + running.length + ' 个正在运行的会话：' + candidates + '。请用 --session 指定要续接的会话。')
  }
  const only = running[0]
  if (!only || !only.id) {
    throw new Error('整合包「' + packId + '」正在运行的会话没有会话 ID，无法续接。请用 --session 指定会话 ID。')
  }
  return only.id
}

/**
 * 读某个整合包当前正在运行的会话（复用续接队列的 /connect + session/list 链路）。
 * 失败一律抛错，调用方（空闲自动关机）据此按「忙」处理。
 */
export async function readRunningSessions(options: {
  baseUrl: string
  fetch?: Fetcher
  signal?: AbortSignal
}): Promise<RunningSession[]> {
  const fetcher = resolveFetcher(options.fetch)
  const base = parsePackBaseUrl(options.baseUrl)
  const cookie = await connectPackSession(fetcher, base.origin, base.token, options.signal)
  const value = await callPackRpc(fetcher, base.origin, SESSION_LIST_METHOD, {}, cookie, '读取会话列表', options.signal)
  const sessions = readKnownSessions(value)
  for (const session of sessions) {
    if (!isRecord(session)) throw new Error('无法确认会话运行状态。')
    if (typeof session.running === 'boolean') continue
    const status = session.status ?? session.state
    if (typeof status !== 'string' || !['running', 'idle', 'completed', 'stopped', 'failed', 'cancelled', 'canceled'].includes(status)) {
      throw new Error('无法确认会话运行状态。')
    }
  }
  return runningSessionsOf(sessions)
}

function readKnownSessions(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value) && Array.isArray(value.sessions)) return value.sessions
  if (isRecord(value) && Array.isArray(value.items)) return value.items
  throw new Error('无法确认会话列表。')
}

function requireExactSession(value: unknown, id: string): void {
  const matches = readKnownSessions(value).filter(item => isRecord(item)
    && (item.id ?? item.sessionId ?? item.session_id) === id)
  if (matches.length !== 1) throw new Error('无法确认目标整合包中的指定会话。')
}

async function openExactResumeSession(options: { baseUrl: string; sessionId: string; signal: AbortSignal; fetch?: Fetcher }) {
  const fetcher = resolveFetcher(options.fetch)
  const { origin, token } = parsePackBaseUrl(options.baseUrl)
  const url = new URL(origin)
  if (url.protocol !== 'http:' && url.protocol !== 'https:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('续接要求已验证的本地 Web 服务。')
  }
  const cookie = await connectPackSession(fetcher, origin, token, options.signal)
  requireExactSession(await callPackRpc(fetcher, origin, SESSION_LIST_METHOD, {}, cookie, '读取会话列表', options.signal), options.sessionId)
  options.signal.throwIfAborted()
  return { fetcher, origin, cookie }
}

export async function verifyExactResumeSession(options: Parameters<typeof openExactResumeSession>[0]): Promise<void> {
  await openExactResumeSession(options)
}

export async function sendExactResume(options: Parameters<typeof openExactResumeSession>[0] & {
  requestId: string
  prompt: string
}): Promise<void> {
  const { fetcher, origin, cookie } = await openExactResumeSession(options)
  await callPackRpc(fetcher, origin, SESSION_PROMPT_METHOD, {
    requestId: options.requestId,
    sessionId: options.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: options.prompt }],
  }, cookie, '发送续接消息', options.signal)
}

export function createPendingResumeQueue(deps: PendingResumeQueueDeps): PendingResumeQueue {
  const file = typeof deps?.file === 'string' ? deps.file : ''
  if (!file.trim()) throw new Error('缺少续接队列的存储路径，无法创建续接队列。')
  const injectedFetch = deps.fetch
  const now = deps.now ?? (() => Date.now())
  let chain: Promise<unknown> = Promise.resolve()

  const serial = <T>(action: () => Promise<T>): Promise<T> => {
    const next = chain.then(action, action)
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const fetcher = (): Fetcher => resolveFetcher(injectedFetch)

  const parseBaseUrl = (baseUrl: string): { origin: string; token: string } => parsePackBaseUrl(baseUrl)

  const connect = (origin: string, token: string): Promise<string> => connectPackSession(fetcher(), origin, token)

  const callRpc = (origin: string, method: string, args: unknown, cookie: string, action: string): Promise<unknown> =>
    callPackRpc(fetcher(), origin, method, args, cookie, action)

  const pickRunningSession = (packId: string, value: unknown): string => pickRunningSessionOf(packId, value)

  const deliverOne = async (entry: PendingResumeEntry, baseUrl: string): Promise<PendingResumeEntry> => {
    try {
      const base = parseBaseUrl(baseUrl)
      const cookie = await connect(base.origin, base.token)
      const sessionId = entry.sessionId?.trim()
        ? entry.sessionId
        : pickRunningSession(entry.packId, await callRpc(base.origin, SESSION_LIST_METHOD, {}, cookie, '读取会话列表'))
      await callRpc(
        base.origin,
        SESSION_PROMPT_METHOD,
        {
          requestId: entry.requestId,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: entry.prompt }],
        },
        cookie,
        '发送续接消息',
      )
      return { ...entry, sessionId, status: 'sent', error: null }
    } catch (error) {
      return { ...entry, status: 'failed', attempts: entry.attempts + 1, error: messageOf(error) }
    }
  }

  const list = async (packId?: string): Promise<PendingResumeEntry[]> => {
    const wanted = typeof packId === 'string' ? packId.trim() : ''
    return serial(async () => {
      const entries = await readEntriesOf(file)
      const selected = wanted ? entries.filter((entry) => entry.packId === wanted) : entries
      return selected.map((entry) => ({ ...entry }))
    })
  }

  const enqueue = async (input: PendingResumeInput): Promise<PendingResumeEntry> => {
    const packId = typeof input?.packId === 'string' ? input.packId.trim() : ''
    if (!packId) throw new Error('缺少整合包 ID，无法登记续接请求。')
    const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
    if (!prompt.trim()) throw new Error('续接内容不能为空。')
    if (prompt.length > PENDING_RESUME_PROMPT_LIMIT) {
      throw new Error('续接内容过长（当前 ' + prompt.length + ' 字符，最多 ' + PENDING_RESUME_PROMPT_LIMIT + ' 字符）。')
    }
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
    return serial(async () => {
      const entries = await readEntriesOf(file)
      const entry: PendingResumeEntry = {
        id: randomUUID(),
        packId,
        prompt,
        requestId: randomUUID(),
        createdAt: now(),
        attempts: 0,
        status: 'pending',
        error: null,
      }
      if (sessionId) entry.sessionId = sessionId
      entries.push(entry)
      await writeEntriesOf(file, entries)
      return { ...entry }
    })
  }

  const deliver = async (packId: string, baseUrl: string): Promise<PendingResumeEntry[]> => {
    const wanted = typeof packId === 'string' ? packId.trim() : ''
    if (!wanted) throw new Error('缺少整合包 ID，无法发送续接请求。')
    const base = typeof baseUrl === 'string' ? baseUrl.trim() : ''
    if (!base) throw new Error('缺少整合包 Web 服务地址，无法发送续接请求。')
    return serial(async () => {
      const entries = await readEntriesOf(file)
      const attempted: PendingResumeEntry[] = []
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]
        if (!entry) continue
        if (entry.packId !== wanted) continue
        if (entry.status === 'sent') continue
        if (entry.attempts >= PENDING_RESUME_MAX_ATTEMPTS) continue
        const updated = await deliverOne(entry, base)
        entries[index] = updated
        attempted.push({ ...updated })
        await writeEntriesOf(file, entries)
      }
      return attempted
    })
  }

  const retry = async (id: string, baseUrl?: string): Promise<PendingResumeEntry[]> => {
    const targetId = typeof id === 'string' ? id.trim() : ''
    if (!targetId) throw new Error('缺少续接请求 ID。')
    const base = typeof baseUrl === 'string' ? baseUrl.trim() : ''
    return serial(async () => {
      const entries = await readEntriesOf(file)
      const index = entries.findIndex((entry) => entry.id === targetId)
      const current = index >= 0 ? entries[index] : undefined
      if (!current) throw new Error('未找到续接请求：' + targetId)
      const reset: PendingResumeEntry = { ...current, attempts: 0, status: 'pending', error: null }
      entries[index] = reset
      if (base) {
        const updated = await deliverOne(reset, base)
        entries[index] = updated
      }
      await writeEntriesOf(file, entries)
      return entries.map((entry) => ({ ...entry }))
    })
  }

  const discard = async (id: string): Promise<PendingResumeEntry[]> => {
    const targetId = typeof id === 'string' ? id.trim() : ''
    if (!targetId) throw new Error('缺少续接请求 ID。')
    return serial(async () => {
      const entries = await readEntriesOf(file)
      const remaining = entries.filter((entry) => entry.id !== targetId)
      if (remaining.length !== entries.length) await writeEntriesOf(file, remaining)
      return remaining.map((entry) => ({ ...entry }))
    })
  }

  return { list, enqueue, deliver, retry, discard }
}

export async function enqueueBeforeRestart<T>(
  deps: {
    enqueue: (input: PendingResumeInput) => Promise<PendingResumeEntry>
    restart: () => Promise<T>
  },
  input: PendingResumeInput,
): Promise<{ entry: PendingResumeEntry; result: T }> {
  const entry = await deps.enqueue(input)
  const result = await deps.restart()
  return { entry, result }
}
