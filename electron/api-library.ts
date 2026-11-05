import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { CustomApiProtocol, LauncherApiEntry, LauncherApiEntryInput } from '../src/types'
import { hasCredential, readCredential, removeCredential, setCredential } from './credentials'
import { credentialNameForRoute } from './custom-api'
import { writeFileAtomic } from './fs-atomic'
import { removeGrantedRoute, renameGrantedRoute } from './pack-api-grants'

/** 启动器级 API 库：与任何整合包无关，一台机器只有一份。 */
export const API_LIBRARY_FILENAME = 'api-library.json'

export const API_LIBRARY_ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

const PROTOCOLS = new Set<CustomApiProtocol>([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

/** 库里保存的条目：密钥不在里面，只在 .credentials.yaml 里。 */
export interface StoredApiEntry {
  route: string
  displayName: string
  baseUrl: string
  protocol: CustomApiProtocol
  modelIds: string[]
}

interface StoredApiLibraryFile {
  version: 1
  entries: StoredApiEntry[]
}

export function apiLibraryPath(userData: string): string {
  return path.join(userData, API_LIBRARY_FILENAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeRoute(route: unknown): string {
  const value = typeof route === 'string' ? route.trim() : ''
  if (!API_LIBRARY_ROUTE_PATTERN.test(value) || value.length > 64) {
    throw new Error('路由只能使用小写字母、数字和横线，并且必须以字母开头。')
  }
  return value
}

function normalizeModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('模型列表格式无效。')
  const modelIds = [...new Set(value.map(id => (typeof id === 'string' ? id.trim() : '')))].filter(Boolean)
  if (modelIds.length === 0) throw new Error('至少需要填写一个模型 ID。')
  if (modelIds.length > 100 || modelIds.some(id => id.length > 200 || /[\r\n\0]/.test(id))) {
    throw new Error('模型 ID 数量或格式无效。')
  }
  return modelIds
}

function normalizeBaseUrl(value: unknown): string {
  const baseUrl = typeof value === 'string' ? value.trim() : ''
  if (!baseUrl || baseUrl.length > 2048) throw new Error('Base URL 不能为空。')
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('Base URL 不是有效的网址。')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Base URL 必须是 HTTP(S) 地址，且不能包含账号或密码。')
  }
  return baseUrl
}

/** 校验并归一化一条库记录；校验消息与自定义 API 面板保持一致。 */
function normalizeEntry(input: LauncherApiEntryInput): StoredApiEntry & { originalRoute: string; apiKey: string } {
  if (!input || typeof input !== 'object') throw new Error('API 配置无效。')
  const route = normalizeRoute(input.route)
  const originalRoute = input.originalRoute === undefined ? route : normalizeRoute(input.originalRoute)
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : ''
  if (!displayName || displayName.length > 80) throw new Error('显示名称不能为空，且不能超过 80 个字符。')
  if (!PROTOCOLS.has(input.protocol)) throw new Error('API 协议不受支持。')
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const modelIds = normalizeModelIds(input.modelIds)
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (apiKey.length > 32_768) throw new Error('API Key 过长。')
  return { route, originalRoute, displayName, baseUrl, protocol: input.protocol, modelIds, apiKey }
}

function entryRecord(entry: StoredApiEntry): StoredApiEntry {
  return {
    route: entry.route,
    displayName: entry.displayName,
    baseUrl: entry.baseUrl,
    protocol: entry.protocol,
    modelIds: [...entry.modelIds],
  }
}

/**
 * 读库文件。文件不存在即空库；顶层结构不对抛错（半坏的文件比空文件更难查）。
 * 单条记录坏了只跳过该条，不让整个库不可用。
 */
export async function readApiLibrary(userData: string): Promise<StoredApiEntry[]> {
  let source: string
  try {
    source = await readFile(apiLibraryPath(userData), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('启动器 API 库格式无效，请检查 ' + API_LIBRARY_FILENAME + '。')
  }
  if (!isRecord(value)) throw new Error('启动器 API 库格式无效，请检查 ' + API_LIBRARY_FILENAME + '。')
  if (value.version !== 1) throw new Error('不支持的启动器 API 库版本：' + String(value.version) + '。')
  if (!Array.isArray(value.entries)) return []
  const entries: StoredApiEntry[] = []
  const seen = new Set<string>()
  for (const raw of value.entries) {
    if (!isRecord(raw)) continue
    const route = typeof raw.route === 'string' ? raw.route.trim() : ''
    const protocol = raw.protocol
    if (!API_LIBRARY_ROUTE_PATTERN.test(route) || seen.has(route)) continue
    if (typeof protocol !== 'string' || !PROTOCOLS.has(protocol as CustomApiProtocol)) continue
    if (typeof raw.baseUrl !== 'string' || !Array.isArray(raw.modelIds)) continue
    const modelIds = raw.modelIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    if (modelIds.length === 0) continue
    seen.add(route)
    entries.push({
      route,
      displayName: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName.trim() : route,
      baseUrl: raw.baseUrl,
      protocol: protocol as CustomApiProtocol,
      modelIds,
    })
  }
  return entries
}

async function writeApiLibrary(userData: string, entries: StoredApiEntry[]): Promise<void> {
  const body: StoredApiLibraryFile = { version: 1, entries: entries.map(entryRecord) }
  await writeFileAtomic(apiLibraryPath(userData), JSON.stringify(body, null, 2) + '\n')
}

/** 对外形态：带 hasApiKey 标志，永不带出密钥本身。 */
async function toPublicEntry(userData: string, entry: StoredApiEntry): Promise<LauncherApiEntry> {
  return {
    route: entry.route,
    displayName: entry.displayName,
    baseUrl: entry.baseUrl,
    protocol: entry.protocol,
    modelIds: [...entry.modelIds],
    hasApiKey: await hasCredential(userData, credentialNameForRoute(entry.route)),
  }
}

/** 列出启动器 API 库（保持写入顺序）。 */
export async function listApiLibrary(userData: string): Promise<LauncherApiEntry[]> {
  const entries = await readApiLibrary(userData)
  return Promise.all(entries.map(entry => toPublicEntry(userData, entry)))
}

/**
 * 新增或更新一条库记录。
 * 改路由时：迁移密钥，并把各包授权记录里的旧路由换成新路由。
 */
export async function saveApiLibraryEntry(userData: string, input: LauncherApiEntryInput): Promise<LauncherApiEntry[]> {
  const normalized = normalizeEntry(input)
  const entries = await readApiLibrary(userData)
  const existingIndex = entries.findIndex(entry => entry.route === normalized.originalRoute)
  const routeChanged = normalized.originalRoute !== normalized.route
  if (routeChanged) {
    if (entries.some(entry => entry.route === normalized.route)) {
      throw new Error('目标路由已存在，请换一个路由名称。')
    }
    if (existingIndex < 0) throw new Error('没有找到该 API：' + normalized.originalRoute)
  }

  const oldCredential = credentialNameForRoute(normalized.originalRoute)
  const nextCredential = credentialNameForRoute(normalized.route)
  if (normalized.apiKey) {
    await setCredential(userData, nextCredential, normalized.apiKey)
  } else if (routeChanged) {
    const secret = await readCredential(userData, oldCredential)
    if (secret) await setCredential(userData, nextCredential, secret)
  }
  if (routeChanged && oldCredential !== nextCredential) await removeCredential(userData, oldCredential)

  const record: StoredApiEntry = {
    route: normalized.route,
    displayName: normalized.displayName,
    baseUrl: normalized.baseUrl,
    protocol: normalized.protocol,
    modelIds: normalized.modelIds,
  }
  if (existingIndex >= 0) entries[existingIndex] = record
  else entries.push(record)
  await writeApiLibrary(userData, entries)
  if (routeChanged) await renameGrantedRoute(userData, normalized.originalRoute, normalized.route)
  return listApiLibrary(userData)
}

/**
 * 删除一条库记录：同时清掉启动器的密钥与所有包的授予记录。
 * 取舍：不从各包 settings.yaml 里删已经写入的 provider——包内配置属于包自己，
 * 用户可能手工改过；库只负责「谁能被授予」，撤销授予后用户可在包内自行重配。
 */
export async function removeApiLibraryEntry(userData: string, route: string): Promise<LauncherApiEntry[]> {
  const normalizedRoute = normalizeRoute(route)
  const entries = await readApiLibrary(userData)
  const index = entries.findIndex(entry => entry.route === normalizedRoute)
  if (index < 0) throw new Error('没有找到该 API：' + normalizedRoute)
  entries.splice(index, 1)
  await writeApiLibrary(userData, entries)
  await removeCredential(userData, credentialNameForRoute(normalizedRoute))
  await removeGrantedRoute(userData, normalizedRoute)
  return listApiLibrary(userData)
}

export interface ApiLibrary {
  list(): Promise<LauncherApiEntry[]>
  save(input: LauncherApiEntryInput): Promise<LauncherApiEntry[]>
  remove(route: string): Promise<LauncherApiEntry[]>
}

/** 把库绑到一个固定的 userData 上，供 IPC / CLI 注入。 */
export function createApiLibrary(userData: string): ApiLibrary {
  return {
    list: () => listApiLibrary(userData),
    save: input => saveApiLibraryEntry(userData, input),
    remove: route => removeApiLibraryEntry(userData, route),
  }
}
