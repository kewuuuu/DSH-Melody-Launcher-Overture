import type { AppSettings, PackApiGrantState } from '../src/types'
import { listApiLibrary, readApiLibrary, type StoredApiEntry } from './api-library'
import { readCredential, removeCredential } from './credentials'
import { credentialNameForRoute, removeCustomApiProvider, saveCustomApiProvider } from './custom-api'
import { readPackApiGrants, writePackApiGrants, type PackApiGrantStore } from './pack-api-grants'
import { readPackRegistry, type PackRecord } from './pack-registry'

const MISSING_PROVIDER = '没有找到该自定义 API。'

export interface PackApisOptions {
  userData: string
  registryPath: string
  readSettings: () => Promise<AppSettings>
  isPackRunning: (packId: string) => boolean
}

export interface PackApis {
  getState(packId: string): Promise<PackApiGrantState>
  setGrant(packId: string, route: string, enabled: boolean): Promise<PackApiGrantState>
}

interface ResolvedPack {
  record: PackRecord
  /** 该包的 DSH 家目录：包自己的 homePath，缺省回落 settings 里的默认家目录。 */
  home: string
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

function isMissingProvider(error: unknown): boolean {
  return error instanceof Error && error.message === MISSING_PROVIDER
}

function cloneStore(store: PackApiGrantStore): PackApiGrantStore {
  const grants: Record<string, string[]> = {}
  for (const [packId, routes] of Object.entries(store.grants)) grants[packId] = [...routes]
  return { version: 1, grants, errors: { ...store.errors } }
}

/**
 * 整合包 API 授予：把启动器 API 库里的条目按包勾选启用。
 *
 * 记录在 <userData>/pack-api-grants.json；勾选后立刻同步到该包自己家目录的
 * settings.yaml（provider）与 .credentials.yaml（密钥），停用则反向移除。
 * 同步失败会回滚记录并把原因写进 error，不留半同步状态。
 */
export function createPackApis(options: PackApisOptions): PackApis {
  const { userData } = options
  let queue: Promise<unknown> = Promise.resolve()

  /** 串行化：同一时刻只允许一个写操作，避免两次勾选互相覆盖。 */
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const next = queue.then(action, action)
    queue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  async function resolvePack(packId: string): Promise<ResolvedPack> {
    const id = typeof packId === 'string' ? packId.trim() : ''
    if (!id) throw new Error('缺少整合包 ID。')
    const records = await readPackRegistry(options.registryPath)
    const record = records.find(item => item.id === id)
    if (!record) throw new Error('Unknown pack: ' + id)
    if (record.homePath) return { record, home: record.homePath }
    const settings = await options.readSettings()
    return { record, home: settings.dshHome }
  }

  /** 启用前先确认库里有这条路由：校验失败不该留下任何记录。 */
  async function requireLibraryEntry(route: string): Promise<StoredApiEntry> {
    const entry = (await readApiLibrary(userData)).find(item => item.route === route)
    if (!entry) throw new Error('启动器 API 库里没有该路由：' + route)
    return entry
  }

  async function syncEnable(pack: ResolvedPack, entry: StoredApiEntry): Promise<void> {
    const credentialName = credentialNameForRoute(entry.route)
    const secret = await readCredential(userData, credentialName)
    await saveCustomApiProvider(pack.home, {
      route: entry.route,
      displayName: entry.displayName,
      baseUrl: entry.baseUrl,
      protocol: entry.protocol,
      modelIds: entry.modelIds,
      ...(secret ? { apiKey: secret } : {}),
    })
    // 库里没有存密钥时，顺手清掉包里可能残留的同名旧密钥，避免包内状态与库不一致。
    if (!secret) await removeCredential(pack.home, credentialName)
  }

  async function syncDisable(pack: ResolvedPack, route: string): Promise<void> {
    try {
      await removeCustomApiProvider(pack.home, route)
    } catch (error) {
      // 包里本来就没有这条 provider：仍然算停用成功，继续清密钥。
      if (!isMissingProvider(error)) throw error
    }
    await removeCredential(pack.home, credentialNameForRoute(route))
  }

  async function getState(packId: string): Promise<PackApiGrantState> {
    await resolvePack(packId)
    return stateOf(packId)
  }

  async function stateOf(packId: string): Promise<PackApiGrantState> {
    const store = await readPackApiGrants(userData)
    return {
      packId,
      enabled: [...(store.grants[packId] ?? [])],
      available: await listApiLibrary(userData),
      restartRequired: options.isPackRunning(packId),
      error: store.errors[packId] ?? null,
    }
  }

  async function setGrant(packId: string, route: string, enabled: boolean): Promise<PackApiGrantState> {
    const normalizedRoute = typeof route === 'string' ? route.trim() : ''
    if (!normalizedRoute) throw new Error('缺少 API 路由。')
    if (typeof enabled !== 'boolean') throw new Error('启用状态必须是布尔值。')
    const pack = await resolvePack(packId)
    return serial(async () => {
      const entry = enabled ? await requireLibraryEntry(normalizedRoute) : null
      const current = await readPackApiGrants(userData)
      const previous = cloneStore(current)
      const routes = [...(current.grants[packId] ?? [])]
      const next = enabled
        ? (routes.includes(normalizedRoute) ? routes : [...routes, normalizedRoute])
        : routes.filter(item => item !== normalizedRoute)
      const store: PackApiGrantStore = {
        version: 1,
        grants: { ...current.grants, [packId]: next },
        errors: { ...current.errors },
      }
      delete store.errors[packId]
      await writePackApiGrants(userData, store)
      try {
        if (entry) await syncEnable(pack, entry)
        else await syncDisable(pack, normalizedRoute)
      } catch (error) {
        const repaired: PackApiGrantStore = {
          version: 1,
          grants: previous.grants,
          errors: { ...previous.errors, [packId]: messageOf(error) },
        }
        await writePackApiGrants(userData, repaired)
      }
      return stateOf(packId)
    })
  }

  return { getState, setGrant }
}
