import path from 'node:path'
import { readFile, mkdir, symlink, lstat, realpath, rm, readdir, link } from 'node:fs/promises'
import type { AppSettings, LauncherControlRequest, PackControlConfig } from '../src/types'
import { readPackRegistry, toPackStatus, type PackRecord } from './pack-registry'
import { writeFileAtomic } from './fs-atomic'
import { createRuntimeController, findAvailableWebPort, type RuntimeController, type RuntimeControllerOptions } from './runtime'
import { readProfile, togglePlugin, isSafePackageName } from './profile'
import { readInstalledSkills, toggleInstalledSkill, uninstallInstalledSkill, isSkillName } from './skill-format'
import { readInstalledPresets, toggleInstalledPreset, uninstallInstalledPreset } from './preset-install'

export interface PackControlOptions {
  userData: string
  registryPath: string
  readSettings: () => Promise<AppSettings>
  resolveSettings: (record: PackRecord, config: PackControlConfig) => Promise<AppSettings>
  runtimeOptions: (record: PackRecord, settings: AppSettings) => Omit<RuntimeControllerOptions, 'readSettings'>
  createController?: typeof createRuntimeController
  openExternal: (url: string) => Promise<unknown>
  beforeStart?: (record: PackRecord, settings: AppSettings) => Promise<void>
  onAutoStartChange?: (enabled: boolean) => void
  lifecycle?: (command: string, packId: string | undefined, args: Record<string, unknown>) => Promise<unknown>
  market?: (command: string, settings: AppSettings, args: Record<string, unknown>) => Promise<unknown>
}

export function validatePackConfig(patch: Record<string, unknown>): Partial<PackControlConfig> {
  const keys = ['portMode', 'port', 'runAsAdmin', 'autoStart', 'pinnedAt', 'workspace', 'launchArgs']
  for (const key of Object.keys(patch)) if (!keys.includes(key)) throw new Error('Unsupported pack setting: ' + key)
  if ('portMode' in patch && !['auto', 'fixed'].includes(String(patch.portMode))) throw new Error('Invalid port mode')
  if ('port' in patch && (!Number.isInteger(patch.port) || Number(patch.port) < 1 || Number(patch.port) > 65535)) throw new Error('Invalid port')
  for (const key of ['runAsAdmin', 'autoStart']) if (key in patch && typeof patch[key] !== 'boolean') throw new Error('Invalid ' + key)
  if ('pinnedAt' in patch && patch.pinnedAt !== null && (typeof patch.pinnedAt !== 'string' || !Number.isFinite(Date.parse(patch.pinnedAt)))) throw new Error('Invalid pin timestamp')
  if ('workspace' in patch && (typeof patch.workspace !== 'string' || (patch.workspace !== '' && !path.isAbsolute(patch.workspace)))) throw new Error('Workspace must be absolute')
  if ('launchArgs' in patch && (!Array.isArray(patch.launchArgs) || patch.launchArgs.some(a => typeof a !== 'string' || a.includes('\0')))) throw new Error('Invalid launch arguments')
  return patch as Partial<PackControlConfig>
}

export function createPackControl(options: PackControlOptions) {
  const controllers = new Map<string, RuntimeController>()
  const controllerHomes = new Map<string, string>()
  const queues = new Map<string, Promise<unknown>>()
  let writeQueue: Promise<unknown> = Promise.resolve()
  let portQueue: Promise<unknown> = Promise.resolve()
  const reservations = new Set<number>()
  let closing = false
  const configPath = path.join(options.userData, 'pack-control.json')
  const serial = <T>(key: string, action: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action)
    queues.set(key, next)
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key) }).catch(() => undefined)
    return next
  }
  async function configs(): Promise<Record<string, PackControlConfig>> {
    try { return JSON.parse(await readFile(configPath, 'utf8')) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e }
  }
  async function config(id: string): Promise<PackControlConfig> {
    const base = await options.readSettings()
    const saved: Partial<PackControlConfig> | undefined = (await configs())[id]
    return Object.assign({ portMode: 'auto' as const, port: base.webPort, runAsAdmin: false, autoStart: false, pinnedAt: null }, saved)
  }
  async function record(id?: string): Promise<PackRecord> {
    if (typeof id !== 'string' || !id) throw new Error('packId is required')
    const found = (await readPackRegistry(options.registryPath)).find(r => r.id === id)
    if (!found) throw new Error('Unknown pack: ' + id)
    return found
  }
  async function reserve(preferred: number, fixed: boolean): Promise<number | null> {
    const next = portQueue.catch(() => undefined).then(async () => {
      const selected = await findAvailableWebPort(preferred, fixed ? 1 : 100, async p => !reservations.has(p) && (await import('./runtime')).isLoopbackPortAvailable(p))
      if (selected !== null) reservations.add(selected)
      return selected
    })
    portQueue = next
    return next
  }
  async function controller(r: PackRecord): Promise<RuntimeController> {
    const existing = controllers.get(r.id)
    if (existing) return existing
    const c = await config(r.id)
    const settings = await options.resolveSettings(r, c)
    const home = path.resolve(settings.dshHome).toLowerCase()
    if ([...controllerHomes.entries()].some(([id, h]) => id !== r.id && h === home && (controllers.get(id)?.isRunning() || queues.has(id)))) throw new Error('Another pack is already using this home')
    controllerHomes.set(r.id, home)
    await options.beforeStart?.(r, settings)
    const runtime = (options.createController ?? createRuntimeController)({ ...options.runtimeOptions(r, settings), readSettings: async () => settings, portMode: c.portMode, portFallbackAttempts: 100, runAsAdmin: c.runAsAdmin, reservePort: reserve, releasePort: p => reservations.delete(p) })
    controllers.set(r.id, runtime)
    return runtime
  }
  async function resources(r: PackRecord, kind: unknown) {
    const s = await options.resolveSettings(r, await config(r.id))
    if (kind === 'plugins') {
      const items = (await readProfile(s.dshHome, s.profileName)).plugins
      return { items: await Promise.all(items.map(async item => {
        const provenance = await readFile(path.join(s.dshHome, '.launcher-shared-plugins-' + encodeURIComponent(item.packageName) + '.json'), 'utf8').then(text => JSON.parse(text) as { sourcePackId: string }).catch(() => null)
        return provenance ? { ...item, shared: true, sourcePackId: provenance.sourcePackId, sourcePackName: (await readPackRegistry(options.registryPath)).find(p => p.id === provenance.sourcePackId)?.name } : item
      })) }
    }
    if (kind === 'skills' || kind === 'presets') {
      const folder = kind === 'skills' ? 'skills' : 'agent-presets'
      const items = kind === 'skills' ? await readInstalledSkills(s.dshHome) : await readInstalledPresets(s.dshHome)
      return { items: await Promise.all(items.map(async item => {
        const provenance = await readFile(path.join(s.dshHome, '.launcher-shared-' + folder + '-' + item.name + '.json'), 'utf8').then(text => JSON.parse(text) as { sourcePackId: string }).catch(() => null)
        return provenance ? { ...item, shared: true, sourcePackId: provenance.sourcePackId, sourcePackName: (await readPackRegistry(options.registryPath)).find(p => p.id === provenance.sourcePackId)?.name } : item
      })) }
    }
    throw new Error('Invalid resource kind')
  }
  async function assertNotSharedSource(sourceId: string, kind?: unknown, name?: unknown): Promise<void> {
    const base = await options.readSettings()
    for (const target of await readPackRegistry(options.registryPath)) {
      if (target.id === sourceId) continue
      const home = target.homePath ?? base.dshHome
      for (const file of await readdir(home).catch(() => [])) {
        if (!file.startsWith('.launcher-shared-') || !file.endsWith('.json')) continue
        const ref = await readFile(path.join(home, file), 'utf8').then(text => JSON.parse(text) as { sourcePackId: string; kind: string; name: string }).catch(() => null)
        if (ref?.sourcePackId === sourceId && (!kind || ref.kind === kind) && (!name || ref.name === name)) throw new Error('Unlink shared references from pack ' + target.name + ' before removing their source')
      }
    }
  }
  async function execute(request: LauncherControlRequest): Promise<unknown> {
    if (!request || typeof request.command !== 'string' || (request.args !== undefined && (!request.args || typeof request.args !== 'object' || Array.isArray(request.args)))) throw new Error('Invalid control request')
    const { command, packId } = request
    const args = request.args ?? {}
    if (command === 'pack.list') {
      const base = await options.readSettings()
      return { packs: await Promise.all((await readPackRegistry(options.registryPath)).map(async r => ({ ...toPackStatus(r, base.activePackId), homePath: r.homePath, config: await config(r.id), runtime: controllers.get(r.id)?.state() ?? { running: false, pid: null, startedAt: null, url: null, port: null } }))) }
    }
    if (command === 'pack.create') return options.lifecycle?.(command, undefined, args)
    const r = await record(packId)
    if (command === 'pack.config.get') return config(r.id)
    if (command === 'pack.config.set') return serial(r.id, async () => {
      const patch = validatePackConfig(args)
      const next = writeQueue.catch(() => undefined).then(async () => {
        const all = await configs()
        const updated = { ...await config(r.id), ...patch }
        all[r.id] = updated
        await writeFileAtomic(configPath, JSON.stringify(all, null, 2) + '\n')
        options.onAutoStartChange?.((await readPackRegistry(options.registryPath)).some(r => all[r.id]?.autoStart))
        if (!controllers.get(r.id)?.isRunning()) controllers.delete(r.id)
        return updated
      })
      writeQueue = next
      return next
    })
    if (command === 'pack.resources.list') return resources(r, args.kind)
    return serial(r.id, async () => {
      if (command === 'pack.start' || command === 'pack.restart') {
        if (closing) throw new Error('Launcher is shutting down')
        if (command === 'pack.restart') { await controllers.get(r.id)?.stop(); controllers.delete(r.id) }
        return (await controller(r)).start()
      }
      if (command === 'pack.stop') { const runtime = controllers.get(r.id); if (runtime) { const state = await runtime.stop(); controllers.delete(r.id); return state }; return { running: false, pid: null, startedAt: null, url: null, port: null } }
      if (command === 'pack.openWeb') {
        const state = controllers.get(r.id)?.state()
        if (!state?.running || !state.url) throw new Error('Pack Web service is not ready')
        const url = new URL(state.url)
        if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Invalid runtime URL')
        await options.openExternal(url.href)
        return state
      }
      if (controllers.get(r.id)?.isRunning()) throw new Error('Stop this pack before changing its resources')
      const s = await options.resolveSettings(r, await config(r.id))
      if (command.startsWith('pack.market.') || command.startsWith('pack.skillMarket.')) return options.market?.(command, s, args)
      if (command === 'pack.resources.enabled' || command === 'pack.resources.remove') {
        if (command.endsWith('.remove') || args.kind === 'skills' || args.kind === 'presets') await assertNotSharedSource(r.id, args.kind, args.name)
        if (typeof args.name !== 'string') throw new Error('Resource name required')
        const name = args.name
        if (command.endsWith('.enabled') && typeof args.enabled !== 'boolean') throw new Error('enabled must be boolean')
        if (args.kind === 'plugins') {
          if (!isSafePackageName(name)) throw new Error('Invalid package name')
          if (command.endsWith('.remove')) {
            const sidecar = path.join(s.dshHome, '.launcher-shared-plugins-' + encodeURIComponent(name) + '.json')
            const shared = await readFile(sidecar, 'utf8').then(() => true).catch(() => false)
            if (!shared) return options.market?.('pack.market.remove', s, args)
            const manifestPath = path.join(s.dshHome, 'profiles', s.profileName, 'package.json')
            const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
            delete manifest.dependencies?.[name]
            if (manifest.dsh?.profile?.bundles) manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((n: string) => n !== name)
            await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2))
            await rm(path.join(s.dshHome, 'profiles', s.profileName, 'node_modules', name), { force: true })
            await rm(sidecar, { force: true })
            return resources(r, args.kind)
          }
          await togglePlugin(s.dshHome, s.profileName, name, args.enabled as boolean)
        } else if (args.kind === 'skills') {
          if (command.endsWith('.remove')) await uninstallInstalledSkill(s.dshHome, name)
          else await toggleInstalledSkill(s.dshHome, name, args.enabled as boolean)
        } else if (args.kind === 'presets') {
          if (command.endsWith('.remove')) await uninstallInstalledPreset(s.dshHome, name, path.join(s.dshHome, '.launcher-preset-receipts.json'))
          else await toggleInstalledPreset(s.dshHome, name, args.enabled as boolean)
        } else throw new Error('Invalid resource kind')
        if (command.endsWith('.remove')) await rm(path.join(s.dshHome, '.launcher-shared-' + (args.kind === 'presets' ? 'agent-presets' : String(args.kind)) + '-' + encodeURIComponent(name) + '.json'), { force: true })
        return resources(r, args.kind)
      }
      if (command === 'pack.resources.link') {
        if (!['plugins', 'skills', 'presets'].includes(String(args.kind)) || typeof args.name !== 'string' || !(args.kind === 'plugins' ? isSafePackageName(args.name) : isSkillName(args.name))) throw new Error('Invalid shared resource')
        if (args.sourcePackId === r.id) throw new Error('A pack cannot share a resource with itself')
        const source = await record(String(args.sourcePackId ?? ''))
        const sourceSettings = await options.resolveSettings(source, await config(source.id))
        const folder = args.kind === 'plugins' ? 'profiles/' + s.profileName + '/node_modules' : args.kind === 'skills' ? 'skills' : '.agent-presets'
        const sourceFolder = args.kind === 'plugins' ? 'profiles/' + sourceSettings.profileName + '/node_modules' : folder
        const skill = args.kind === 'skills' ? (await readInstalledSkills(sourceSettings.dshHome)).find(item => item.name === args.name) : null
        const sourcePath = skill?.path ?? path.join(sourceSettings.dshHome, sourceFolder, args.name)
        const dest = path.join(s.dshHome, folder, skill?.format === 'flat' ? path.basename(sourcePath) : args.name)
        const body = await realpath(sourcePath)
        const directory = (await lstat(body)).isDirectory()
        if (!directory && skill?.format !== 'flat') throw new Error('Shared resource must be a directory')
        await mkdir(path.dirname(dest), { recursive: true })
        const manifestPath = path.join(s.dshHome, 'profiles', s.profileName, 'package.json')
        const previousManifest = args.kind === 'plugins' ? await readFile(manifestPath, 'utf8').catch(e => { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }) : null
        const sidecar = path.join(s.dshHome, '.launcher-shared-' + (args.kind === 'plugins' ? 'plugins' : folder.replace('.', '')) + '-' + encodeURIComponent(args.name) + '.json')
        if (directory) await symlink(body, dest, process.platform === 'win32' ? 'junction' : 'dir')
        else await link(body, dest)
        try {
        if (args.kind === 'plugins') {
          type Manifest = { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } } }
          const manifest: Manifest = previousManifest === null ? {} : JSON.parse(previousManifest)
          manifest.dependencies = { ...manifest.dependencies, [args.name]: 'file:' + body }
          manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...new Set([...(manifest.dsh?.profile?.bundles ?? []), args.name])] } }
          await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2))
        }
        await writeFileAtomic(sidecar, JSON.stringify({ sourcePackId: source.id, name: args.name, kind: args.kind, sourcePath: body }))
        } catch (error) {
          await rm(dest, { force: true })
          if (args.kind === 'plugins') {
            if (previousManifest === null) await rm(manifestPath, { force: true })
            else await writeFileAtomic(manifestPath, previousManifest)
          }
          throw error
        }
        return resources(r, args.kind)
      }
      if (command === 'pack.delete') await assertNotSharedSource(r.id)
      if (command === 'pack.rename' || command === 'pack.delete') return options.lifecycle?.(command, r.id, args)
      throw new Error('Unsupported control command: ' + command)
    })
  }
  return {
    execute,
    async autoStart() {
      const all = await readPackRegistry(options.registryPath)
      const saved = await configs()
      options.onAutoStartChange?.(all.some(r => saved[r.id]?.autoStart))
      return Promise.allSettled(all.map(async r => { if ((await config(r.id)).autoStart) await execute({ command: 'pack.start', packId: r.id }) }))
    },
    async shutdown() { closing = true; await Promise.allSettled([...queues.values()]); await Promise.allSettled([...controllers.values()].map(c => c.stop())) },
    isRunning: () => [...controllers.values()].some(c => c.isRunning()),
    isPackRunning: (id: string) => controllers.get(id)?.isRunning() ?? false,
    assertPackRemovable: (id: string) => assertNotSharedSource(id),
    async forgetPack(id: string) {
      const next = writeQueue.catch(() => undefined).then(async () => {
        const saved = await configs(); delete saved[id]
        await writeFileAtomic(configPath, JSON.stringify(saved, null, 2))
        controllers.delete(id); controllerHomes.delete(id)
        options.onAutoStartChange?.((await readPackRegistry(options.registryPath)).some(r => saved[r.id]?.autoStart))
      })
      writeQueue = next; await next
    },
    hasRunningHome: (home: string) => [...controllerHomes.entries()].some(([id, h]) => h === path.resolve(home).toLowerCase() && controllers.get(id)?.isRunning()),
  }
}
