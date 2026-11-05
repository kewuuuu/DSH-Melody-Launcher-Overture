import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'

/** 整合包 API 授予记录：只记「哪个包被授予了哪些路由」，与库本身分开存放。 */
export const PACK_API_GRANTS_FILENAME = 'pack-api-grants.json'

export interface PackApiGrantStore {
  version: 1
  /** packId → 已授予的 API 路由。 */
  grants: Record<string, string[]>
  /** packId → 上次同步到该包失败的原因；同步成功后清掉。 */
  errors: Record<string, string>
}

export function packApiGrantsPath(userData: string): string {
  return path.join(userData, PACK_API_GRANTS_FILENAME)
}

function emptyStore(): PackApiGrantStore {
  return { version: 1, grants: {}, errors: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读授予记录；文件不存在即空记录，结构不对直接抛错（半个文件比没有更难查）。 */
export async function readPackApiGrants(userData: string): Promise<PackApiGrantStore> {
  let source: string
  try {
    source = await readFile(packApiGrantsPath(userData), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore()
    throw error
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error('整合包 API 授予记录格式无效，请检查 ' + PACK_API_GRANTS_FILENAME + '。')
  }
  if (!isRecord(value)) throw new Error('整合包 API 授予记录格式无效，请检查 ' + PACK_API_GRANTS_FILENAME + '。')
  if (value.version !== 1) throw new Error('不支持的整合包 API 授予记录版本：' + String(value.version) + '。')
  const grants: Record<string, string[]> = {}
  if (isRecord(value.grants)) {
    for (const [packId, routes] of Object.entries(value.grants)) {
      if (!Array.isArray(routes)) continue
      grants[packId] = [...new Set(routes.filter((route): route is string => typeof route === 'string' && route !== ''))]
    }
  }
  const errors: Record<string, string> = {}
  if (isRecord(value.errors)) {
    for (const [packId, message] of Object.entries(value.errors)) {
      if (typeof message === 'string' && message) errors[packId] = message
    }
  }
  return { version: 1, grants, errors }
}

export async function writePackApiGrants(userData: string, store: PackApiGrantStore): Promise<void> {
  const body = JSON.stringify({ version: 1, grants: store.grants, errors: store.errors }, null, 2) + '\n'
  await writeFileAtomic(packApiGrantsPath(userData), body)
}

/** 库里的 API 被删除时，从所有包上摘掉这条授予记录。 */
export async function removeGrantedRoute(userData: string, route: string): Promise<void> {
  const store = await readPackApiGrants(userData)
  let changed = false
  for (const [packId, routes] of Object.entries(store.grants)) {
    if (!routes.includes(route)) continue
    store.grants[packId] = routes.filter(value => value !== route)
    changed = true
  }
  if (changed) await writePackApiGrants(userData, store)
}

/** 库里的 API 改了路由时，把所有包里记录的旧路由换成新路由。 */
export async function renameGrantedRoute(userData: string, from: string, to: string): Promise<void> {
  const store = await readPackApiGrants(userData)
  let changed = false
  for (const [packId, routes] of Object.entries(store.grants)) {
    if (!routes.includes(from)) continue
    store.grants[packId] = [...new Set(routes.map(route => route === from ? to : route))]
    changed = true
  }
  if (changed) await writePackApiGrants(userData, store)
}
