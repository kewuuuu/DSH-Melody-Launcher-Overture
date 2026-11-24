import { compare, prerelease, satisfies, valid, validRange } from 'semver'
import { requestNpmMetadata } from './proxy'

export type VersionSelection = {
  status: 'compatible' | 'incompatible' | 'unknown'
  version: string | null
  latestVersion: string | null
}

const unknown: VersionSelection = { status: 'unknown', version: null, latestVersion: null }
const workspacePeers = new Set(['workspace:^', 'workspace:~', 'workspace:*'])
const npmPackumentHeaders = { Accept: 'application/json' }

export function isExactPluginVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9][0-9A-Za-z.+-]{0,127}$/.test(value) && valid(value) !== null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function knownRuntimeVersion(value: unknown): string | null {
  return typeof value === 'string' && valid(value) !== null ? value : null
}

function acceptsRuntime(manifest: Record<string, unknown>, runtime: string): boolean {
  const semverOptions = { includePrerelease: true }
  const accepts = (range: string) => {
    if (!range.trim() || validRange(range, semverOptions) === null) throw new Error('Invalid DSH version range')
    return satisfies(runtime, range, semverOptions)
  }
  // Keep precedence and peer matching aligned with dsh-app-boot's evaluatePluginCompatibility.
  if (Object.hasOwn(manifest, 'engines')) {
    if (!isObject(manifest.engines)) throw new Error('Invalid engines')
    if (Object.hasOwn(manifest.engines, 'dsh')) {
      if (typeof manifest.engines.dsh !== 'string') throw new Error('Invalid engines.dsh')
      return accepts(manifest.engines.dsh)
    }
  }
  if (!Object.hasOwn(manifest, 'peerDependencies')) return true
  if (!isObject(manifest.peerDependencies)) throw new Error('Invalid peerDependencies')
  let compatible = true
  for (const [name, range] of Object.entries(manifest.peerDependencies)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof range !== 'string') throw new Error('Invalid DSH peer dependency')
    if (!accepts(workspacePeers.has(range) ? runtime : range)) compatible = false
  }
  return compatible
}

export function selectCompatiblePluginVersion(packument: unknown, name: string, runtime: string | null): VersionSelection {
  if (!runtime || !isObject(packument) || packument.name !== name || !isObject(packument.versions) || !isObject(packument['dist-tags'])) return unknown
  const latest = packument['dist-tags'].latest
  if (!isExactPluginVersion(latest) || !Object.hasOwn(packument.versions, latest)) return unknown
  let stable: string | null = null
  let preview: string | null = null
  for (const [version, manifest] of Object.entries(packument.versions)) {
    if (!isExactPluginVersion(version) || !isObject(manifest) || manifest.name !== name || manifest.version !== version) return unknown
    try {
      if (!acceptsRuntime(manifest, runtime)) continue
    } catch { return unknown }
    if (prerelease(version)) {
      if (preview === null || compare(version, preview) > 0) preview = version
    } else if (stable === null || compare(version, stable) > 0) {
      stable = version
    }
  }
  const version = stable ?? preview
  return { status: version === null ? 'incompatible' : 'compatible', version, latestVersion: latest }
}

export function createMarketMetadataLookup(fetchImpl: typeof fetch) {
  const cache = new Map<string, { at: number; result: unknown }>()
  const pending = new Map<string, Promise<unknown>>()
  const waiting: Array<() => void> = []
  let running = 0
  async function bounded<T>(work: () => Promise<T>): Promise<T> {
    if (running >= 4) await new Promise<void>(resolve => waiting.push(resolve))
    else running += 1
    try { return await work() }
    finally {
      const next = waiting.shift()
      if (next) next()
      else running -= 1
    }
  }

  async function read(name: string, fresh: boolean): Promise<unknown> {
    const route = '/' + encodeURIComponent(name)
    try {
      const response = await requestNpmMetadata(route, fetchImpl, {
        headers: npmPackumentHeaders,
        ...(fresh ? { cache: 'no-store' } : {}),
      })
      const result: unknown = response.ok ? await response.json() : null
      return isObject(result) && result.name === name ? result : null
    } catch { return null }
  }

  function peek(key: string): unknown {
    const entry = cache.get(key)
    return entry && Date.now() - entry.at < 60_000 ? entry.result : null
  }

  function lookup(key: string, fresh: boolean, load: () => Promise<unknown>): Promise<unknown> {
    if (!fresh) {
      const existing = peek(key)
      if (existing !== null) return Promise.resolve(existing)
      const inFlight = pending.get(key)
      if (inFlight) return inFlight
    } else {
      cache.delete(key)
    }
    const request = bounded(load).then(result => {
      if (pending.get(key) === request && result !== null) {
        cache.set(key, { at: Date.now(), result })
        if (cache.size > 128) cache.delete(cache.keys().next().value!)
      }
      return result
    }).finally(() => { if (pending.get(key) === request) pending.delete(key) })
    pending.set(key, request)
    return request
  }

  return {
    get: (name: string, fresh: boolean) => lookup('npm:' + name, fresh, () => read(name, fresh)),
    gitName: async (url: string, fresh: boolean, load: () => Promise<string | null>): Promise<string | null> => {
      const result = await lookup('git:' + url, fresh, load)
      return typeof result === 'string' ? result : null
    },
    cachedGitName: (url: string) => {
      const result = peek('git:' + url)
      return typeof result === 'string' ? result : null
    },
  }
}
