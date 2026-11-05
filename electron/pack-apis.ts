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
  /** 库条目更新或改名后，把新值重新同步进所有已授予该路由的包（库是唯一来源）。 */
  resyncGranted(route: string, previousRoute?: string): Promise<void>
  /** 库条目删除后，对所有已授予该路由的包做一次真正的撤销（provider + 包侧密钥）。 */
  revokeGranted(route: string): Promise<void>
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
    if (!record) throw new Error('未找到整合包：' + id)
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

  /** 把库里的一条记录写进包自己的配置；renameFrom 时按 originalRoute 语义迁移 provider 与密钥。 */
  async function syncEnable(pack: ResolvedPack, entry: StoredApiEntry, renameFrom?: string): Promise<void> {
    const credentialName = credentialNameForRoute(entry.route)
    const secret = await readCredential(userData, credentialName)
    await saveCustomApiProvider(pack.home, {
      ...(renameFrom && renameFrom !== entry.route ? { originalRoute: renameFrom } : {}),
      route: entry.route,
      displayName: entry.displayName,
      baseUrl: entry.baseUrl,
      protocol: entry.protocol,
      modelIds: entry.modelIds,
      ...(secret ? { apiKey: secret } : {}),
    })
    // 库里没有存密钥时，顺手清掉包里可能残留的同名旧密钥，避免包内状态与库不一致。
    if (!secret) await removeCredential(pack.home, credentialName)
    if (renameFrom) {
      const oldName = credentialNameForRoute(renameFrom)
      if (oldName !== credentialName) await removeCredential(pack.home, oldName)
    }
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

  async function grantedPackIds(route: string): Promise<string[]> {
    const store = await readPackApiGrants(userData)
    return Object.entries(store.grants)
      .filter(([, routes]) => routes.includes(route))
      .map(([packId]) => packId)
  }

  /** 批量同步的结果：失败的包记原因，成功的包清掉旧原因。 */
  async function recordSyncOutcome(failures: Map<string, string>, succeeded: string[]): Promise<void> {
    if (failures.size === 0 && succeeded.length === 0) return
    const store = await readPackApiGrants(userData)
    for (const packId of succeeded) delete store.errors[packId]
    for (const [packId, message] of failures) store.errors[packId] = message
    await writePackApiGrants(userData, store)
  }

  /** 逐个包执行同步；单包失败不影响其它包，原因留在该包的 error 上。 */
  async function syncEach(packIds: string[], action: (pack: ResolvedPack) => Promise<void>): Promise<void> {
    const failures = new Map<string, string>()
    const succeeded: string[] = []
    for (const packId of packIds) {
      try {
        await action(await resolvePack(packId))
        succeeded.push(packId)
      } catch (error) {
        failures.set(packId, messageOf(error))
      }
    }
    await recordSyncOutcome(failures, succeeded)
  }

  async function getState(packId: string): Promise<PackApiGrantState> {
    await resolvePack(packId)
    // 只读视图不代表有未生效变更：待重启标记只在真正的授予变动后由 setGrant 给出。
    return stateOf(packId)
  }

  async function stateOf(packId: string, restartRequired = false): Promise<PackApiGrantState> {
    const store = await readPackApiGrants(userData)
    return {
      packId,
      enabled: [...(store.grants[packId] ?? [])],
      available: await listApiLibrary(userData),
      restartRequired,
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
      const routes = [...(current.grants[packId] ?? [])]
      const granted = routes.includes(normalizedRoute)
      // 停用一条本来就没有授予的 API：包里的 provider 可能来自用户手配，不能碰。
      if (!enabled && !granted) return stateOf(packId)
      const previous = cloneStore(current)
      const next = enabled
        ? (granted ? routes : [...routes, normalizedRoute])
        : routes.filter(item => item !== normalizedRoute)
      const changed = enabled ? !granted : granted
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
        return stateOf(packId)
      }
      return stateOf(packId, changed && options.isPackRunning(packId))
    })
  }

  async function resyncGranted(route: string, previousRoute?: string): Promise<void> {
    const normalizedRoute = typeof route === 'string' ? route.trim() : ''
    if (!normalizedRoute) throw new Error('缺少 API 路由。')
    const from = typeof previousRoute === 'string' ? previousRoute.trim() : ''
    const renameFrom = from && from !== normalizedRoute ? from : undefined
    await serial(async () => {
      const packIds = await grantedPackIds(normalizedRoute)
      if (packIds.length === 0) return
      const entry = await requireLibraryEntry(normalizedRoute)
      await syncEach(packIds, async pack => syncEnable(pack, entry, renameFrom))
    })
  }

  async function revokeGranted(route: string): Promise<void> {
    const normalizedRoute = typeof route === 'string' ? route.trim() : ''
    if (!normalizedRoute) throw new Error('缺少 API 路由。')
    await serial(async () => {
      const packIds = await grantedPackIds(normalizedRoute)
      if (packIds.length === 0) return
      await syncEach(packIds, async pack => syncDisable(pack, normalizedRoute))
    })
  }

  return { getState, setGrant, resyncGranted, revokeGranted }
}
