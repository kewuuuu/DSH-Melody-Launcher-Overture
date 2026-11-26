import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { compareDshMarketVersions, createDshMarketService, dshMarketInstallTarget, findDshMarketInstalledAlias, parseDshMarketSourceUrl } from '../electron/dsh-market'
import { selectCompatiblePluginVersion } from '../electron/dsh-market-compatibility'
import { createInstallOperations } from '../electron/install-operations'
import type { AppSettings, DshMarketProgress } from '../src/types'

const marketSettings: AppSettings = {
  dshInstallPath: 'C:/dsh-runtime',
  dshHome: 'C:/dsh-home-that-does-not-exist',
  profileName: 'web',
  workspace: 'C:/workspace',
  launchExecutable: 'dsh.cmd',
  launchArgs: ['web'],
  webPort: 3090,
  openAfterLaunch: false,
}

describe('dsh-market source rules', () => {
  it('uses npm before GitHub and preserves monorepo subpaths', () => {
    expect(dshMarketInstallTarget({ url: 'https://github.com/a/b', npm: 'dsh-demo' })).toBe('dsh-demo')
    expect(dshMarketInstallTarget({ url: 'https://github.com/a/b/tree/main/packages/demo', npm: null })).toBe('github:a/b#path:/packages/demo')
    expect(parseDshMarketSourceUrl('https://github.com/a/b/tree/main/../secret')).toBeNull()
  })

  it('matches the same curated entry but keeps different GitHub sources apart', () => {
    const entry = { name: 'dsh-demo', owner: 'a', url: 'https://github.com/a/b', npm: null }
    expect(findDshMarketInstalledAlias(entry, { 'dsh-demo': 'github:a/b' })).toBe('dsh-demo')
    expect(findDshMarketInstalledAlias(entry, { 'dsh-demo': 'github:x/y' })).toBeNull()
    expect(findDshMarketInstalledAlias({ ...entry, npm: 'dsh-demo' }, { 'dsh-demo': 'dsh-demo' })).toBe('dsh-demo')
  })

  it('only treats a newer npm version as an update', () => {
    expect(compareDshMarketVersions('1.0.0', '1.1.0')).toBeLessThan(0)
    expect(compareDshMarketVersions('1.1.0', '1.0.0')).toBeGreaterThan(0)
    expect(compareDshMarketVersions('git', '1.0.0')).toBeNull()
  })

  it('does not run remote update checks while reading the catalog', async () => {
    const requests: string[] = []
    const progress: string[] = []
    const service = createDshMarketService({
      readSettings: async () => marketSettings,
      prepareNodeRuntime: async () => { throw new Error('not used while reading') },
      preparePnpmRuntime: async () => { throw new Error('not used while reading') },
      fetchImpl: async input => {
        requests.push(String(input))
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            updated: '2026-08-22',
            count: 1,
            categories: {},
            plugins: [{ name: 'demo', owner: 'owner', url: 'https://github.com/owner/demo', category: 'plugin', npm: 'demo' }],
          }),
        } as unknown as Response
      },
      emitProgress: event => progress.push(event.phase),
      emitOutput: () => undefined,
    })

    const [first, second] = await Promise.all([service.load(), service.load()])
    expect(first.plugins[0]?.name).toBe('demo')
    expect(second.plugins[0]?.name).toBe('demo')
    expect(requests).toEqual(['https://awesome-dsh-plugin.com/plugins.json'])
    expect(progress.at(-1)).toBe('complete')
  })

  it('migrates an old Profile store before retrying a plugin operation', async () => {
    const calls: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = []
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => marketSettings,
      prepareNodeRuntime: async () => ({ root: 'C:/node', node: 'C:/node/node.exe', npm: 'C:/node/npm.cmd', npx: 'C:/node/npx.cmd', managed: true }),
      preparePnpmRuntime: async () => ({ root: 'C:/pnpm', executable: 'C:/pnpm/pnpm.cmd' }),
      packageStoreRoot: 'C:/launcher/plugin-store',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ plugins: [{ name: 'demo', owner: 'owner', url: 'https://github.com/owner/demo', category: 'plugin' }] }),
      } as unknown as Response),
      runCommand: async (_executable, args, options) => {
        calls.push({ args, cwd: options.cwd, env: options.env })
        if (args.includes('add')) {
          addRuns += 1
          return addRuns === 1
            ? { exitCode: 1, output: '[ERR_PNPM_UNEXPECTED_STORE] linked from the system store' }
            : { exitCode: 0, output: 'done' }
        }
        return { exitCode: 0, output: 'Done in 1s' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    // The fake command does not create a real package, so the post-install
    // verification is expected to fail after the migration/retry sequence.
    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    const migration = calls.find(call => call.args[0] === 'install')
    expect(migration?.cwd).toBe(path.join(marketSettings.dshHome, 'profiles', 'web'))
    expect(migration?.env.PNPM_CONFIG_STORE_DIR).toBe('C:/launcher/plugin-store')
  })
})

// ---------------------------------------------------------------------------
// 网络镜像 / 构建审批 / workspace→npm 回退
// ---------------------------------------------------------------------------

async function tempProfile(): Promise<{ root: string; profileDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-market-recovery-'))
  const profileDir = path.join(root, 'profiles', 'web')
  await mkdir(profileDir, { recursive: true })
  await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'web', private: true, dependencies: {} }))
  return { root, profileDir }
}

function registryResponse(plugins: Array<{ name: string; owner: string; url: string; category: string; npm?: string | null }>) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ updated: '2026-08-25', count: plugins.length, categories: {}, plugins }),
  } as unknown as Response
}

function packument(name: string, latest: string, versions: Record<string, Record<string, unknown>>) {
  return {
    name,
    'dist-tags': { latest },
    versions: Object.fromEntries(Object.entries(versions).map(([version, meta]) => [version, { name, version, ...meta }])),
  }
}

it('uses native DSH ranges, stable preference and prerelease fallback', () => {
  const name = 'test-plugin'
  const data = packument(name, '2.1.0-alpha.1', {
    '1.0.0': { engines: { dsh: '>=0.2.1-rc.1 <0.3.0' }, peerDependencies: { '@deepseek-ai/dsh-other': '^99' } },
    '1.1.0': { peerDependencies: { '@deepseek-ai/dsh': 'workspace:^', '@deepseek-ai/dsh-base': '^99' } },
    '2.0.0-alpha.3': { peerDependencies: { '@deepseek-ai/dsh': 'workspace:*', '@deepseek-ai/dsh-base': '~0.2.1' } },
    '2.1.0-alpha.1': { peerDependencies: { '@deepseek-ai/dsh': 'workspace:~', '@deepseek-ai/dsh-base': '^0.3.0' } },
  })
  expect(selectCompatiblePluginVersion(data, name, '0.2.1-rc.3')).toEqual({ status: 'compatible', version: '1.0.0', latestVersion: '2.1.0-alpha.1' })
  expect(selectCompatiblePluginVersion(data, name, '0.3.1')).toMatchObject({ status: 'compatible', version: '2.1.0-alpha.1' })
  expect(selectCompatiblePluginVersion(data, name, '0.1.0')).toMatchObject({ status: 'incompatible', version: null })
  expect(selectCompatiblePluginVersion(data, name, null)).toMatchObject({ status: 'unknown', version: null })
  const malformed = packument(name, '1.0.0', { '1.0.0': { engines: { dsh: 'workspace:unsupported' } } })
  expect(selectCompatiblePluginVersion(malformed, name, '0.2.1-rc.3').status).toBe('unknown')
})

it('resolves the SSH monorepo package and pins install under the locked runtime', async () => {
  const { root, profileDir } = await tempProfile()
  const entry = { name: 'dsh-web#packages/dsh-ssh', owner: 'zhu1090093659', url: 'https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-ssh', category: 'plugin' }
  const gitOnly = { name: 'git-only', owner: 'zhu1090093659', url: 'https://github.com/linxin666/git-only', category: 'plugin' }
  const unsupported = { name: 'missing', owner: 'zhu1090093659', url: 'https://github.com/zhu1090093659/dsh-web/tree/main/packages/missing', category: 'plugin' }
  const npm = '@linxin666/dsh-ssh'
  const raw = 'https://raw.githubusercontent.com/zhu1090093659/dsh-web/main/packages/dsh-ssh/package.json'
  const official = 'https://registry.npmjs.org/' + encodeURIComponent(npm)
  const versions = {
    '0.4.14': { peerDependencies: { '@deepseek-ai/dsh': '>=0.2.1-rc.3' } },
    '0.4.22': { peerDependencies: { '@deepseek-ai/dsh': '>=0.2.3-alpha.2' } },
  }
  const mirror = 'https://registry.npmmirror.com/' + encodeURIComponent(npm)
  const requests: Array<{ url: string; cache?: RequestCache }> = []
  const calls: string[][] = []
  let runtime: string | undefined = '0.2.1-rc.3'
  let fail = false
  let officialUnavailable = false
  let explicitCatalogAlias = false
  const installs = createInstallOperations()
  const events: DshMarketProgress[] = []
  let onPrepare: (() => Promise<void>) | undefined
  let releaseWrite: (() => void) | undefined
  let reportWrite: (() => void) | undefined
  const createService = () => createDshMarketService({
    targeted: true,
    packId: 'pack-target',
    installOperations: installs,
    readSettings: async () => ({ ...marketSettings, dshHome: root, workspace: root, launchExecutable: 'npx.cmd', dshVersion: runtime }),
    prepareNodeRuntime: async () => {
      await onPrepare?.()
      return { root, node: 'node', npm: 'npm', npx: 'npx', managed: false }
    },
    preparePnpmRuntime: async () => ({ root, executable: 'pnpm' }),
    fetchImpl: async (input, init) => {
      const url = String(input)
      requests.push({ url, cache: init?.cache })
      if (url === 'https://awesome-dsh-plugin.com/plugins.json') return registryResponse([{ ...entry, ...(explicitCatalogAlias ? { npm } : {}) }, gitOnly, unsupported])
      if (url === raw) return Response.json({ name: npm, version: '0.4.22' })
      if (url === official && officialUnavailable) return new Response(null, { status: 503 })
      if (url === official || url === mirror) return Response.json(packument(npm, '0.4.22', versions))
      return new Response(null, { status: 404 })
    },
    runCommand: async (_executable, args, options) => {
      calls.push(args)
      if (reportWrite) await new Promise<void>(resolve => { releaseWrite = resolve; reportWrite?.() })
      expect(options.env.DSH_HOME).toBe(root)
      if (fail) return { exitCode: 1, output: 'fixture failure' }
      const pkg = path.join(profileDir, 'node_modules', npm, 'package.json')
      await mkdir(path.dirname(pkg), { recursive: true })
      await writeFile(pkg, JSON.stringify({
        name: npm, version: '0.4.14', dsh: { bundle: { patch: 'bundle.yml' } },
        repository: { type: 'git', url: 'https://github.com/zhu1090093659/dsh-web.git' },
      }))
      await writeFile(path.join(path.dirname(pkg), 'bundle.yml'), '')
      await writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { [npm]: '0.4.14' } }))
      return { exitCode: 0, output: '' }
    },
    emitProgress: progress => events.push(progress),
    emitOutput: () => undefined,
  })
  try {
    const wrongUrl = { ...entry, url: unsupported.url }
    const wrongName = { ...entry, name: npm }
    const identity = { url: entry.url, expectedVersion: '0.4.14' }
    const requestKeys = [entry, gitOnly, unsupported, wrongUrl, wrongName].map(({ name, url }) => ({ name, url }))
    const service = createService()
    const compatibility = await service.compatibility(requestKeys)
    expect(compatibility).toEqual({ dshVersion: runtime, entries: [
      { ...requestKeys[0], status: 'compatible', version: '0.4.14', latestVersion: '0.4.22' },
      ...requestKeys.slice(1).map(key => ({ ...key, status: 'unknown', version: null, latestVersion: null })),
    ] })
    await expect(service.install(entry.name, { ...identity, url: unsupported.url })).rejects.toThrow('不在')
    runtime = '0.3.1'
    await expect(service.install(entry.name, identity)).rejects.toThrow('兼容插件版本已变更')
    runtime = '0.1.0'
    await expect(service.install(entry.name, identity)).rejects.toThrow('无法确定')
    runtime = undefined
    await expect(service.install(entry.name, identity)).rejects.toThrow('无法确定')
    expect(calls).toEqual([])
    expect(requests.filter(({ url, cache }) => url === official && cache === 'no-store')).toHaveLength(2)
    expect(requests.filter(({ url, cache }) => url === raw && cache === 'no-store')).toHaveLength(2)
    runtime = '0.2.1-rc.3'
    onPrepare = async () => {
      const progress = events.at(-1)!
      expect(progress).toMatchObject({ packId: 'pack-target', cancellable: true })
      await installs.cancel('wrong-operation')
      expect(installs.isBusy()).toBe(true)
      void installs.cancel(progress.operationId!)
    }
    await expect(service.install(entry.name, identity)).rejects.toThrow('已取消')
    expect(calls).toHaveLength(0)
    expect(events.at(-1)).toMatchObject({ packId: 'pack-target', phase: 'error', cancellable: false })
    onPrepare = undefined
    fail = true
    await expect(service.install(entry.name, identity)).rejects.toThrow('fixture failure')
    fail = false
    officialUnavailable = true
    const writing = new Promise<void>(resolve => { reportWrite = resolve })
    const pending = service.install(entry.name)
    await writing
    const committing = events.at(-1)!
    expect(committing).toMatchObject({ packId: 'pack-target', phase: 'building', cancellable: false })
    const cancelled = installs.cancel(committing.operationId!)
    const drained = installs.drain()
    expect(() => installs.start('new install')).toThrow('退出')
    expect(installs.isBusy()).toBe(true)
    releaseWrite!()
    await expect(pending).resolves.toMatchObject([{ packageName: npm, version: '0.4.14' }])
    await Promise.all([cancelled, drained])
    expect(events.at(-1)).toMatchObject({ packId: 'pack-target', phase: 'complete', cancellable: false })
    expect(calls).toEqual(Array.from({ length: 2 }, () => ['--yes', '@deepseek-ai/dsh@0.2.1-rc.3', 'plugin', '--profile', 'web', 'add', npm + '@0.4.14']))
    expect(requests.filter(({ url }) => url === mirror)).toEqual([{ url: mirror, cache: 'no-store' }])
    expect((await createService().load()).plugins[0]).toMatchObject({ packageName: npm, installed: true, version: '0.4.14' })
    explicitCatalogAlias = true
    expect((await createService().load()).plugins[0]).toMatchObject({ packageName: npm, installed: true, version: '0.4.14' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('checks and updates the exact npm dependency using only the target profile', async () => {
  const { root, profileDir } = await tempProfile()
  const targetName = 'pack-b'
  const targetDir = path.join(root, 'profiles', targetName)
  const packageName = '@owner/demo'
  const entry = { name: 'demo', owner: 'owner', url: 'https://github.com/owner/demo', category: 'plugin', npm: packageName }
  const manifest = { dependencies: { [packageName]: '^1.0.0-rc.2', '@unrelated/demo': '0.0.1' }, dsh: { profile: { bundles: [] as string[] } } }
  const pluginManifest = (dir: string, name = packageName) => path.join(dir, 'node_modules', name, 'package.json')
  async function writePlugin(dir: string, version: string, name = packageName, declaredName = name) {
    const file = pluginManifest(dir, name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ name: declaredName, version, dsh: { bundle: 'dist/index.js' } }))
  }
  const requests: string[] = []
  const calls: Array<{ args: string[]; home?: string }> = []
  let registryName = packageName
  let reportSuccessWithoutUpdate = false
  const service = createDshMarketService({
    targeted: true,
    readSettings: async () => ({ ...marketSettings, dshHome: root, profileName: targetName, dshVersion: '0.2.1-rc.3' }),
    prepareNodeRuntime: async () => ({ root, node: 'node', npm: 'npm', npx: 'npx', managed: false }),
    preparePnpmRuntime: async () => ({ root, executable: 'pnpm' }),
    fetchImpl: async input => {
      requests.push(String(input))
      return String(input).endsWith('/' + encodeURIComponent(packageName))
        ? Response.json(packument(registryName, '1.0.0-rc.10', { '1.0.0-rc.10': {} }))
        : registryResponse([entry])
    },
    runCommand: async (_executable, args, options) => {
      calls.push({ args, home: options.env.DSH_HOME })
      if (!reportSuccessWithoutUpdate && args.includes('add')) {
        await writePlugin(targetDir, '1.0.0-rc.10')
        await writeFile(path.join(targetDir, 'package.json'), JSON.stringify({ ...manifest, dsh: { profile: { bundles: [packageName] } } }))
      }
      return { exitCode: 0, output: '' }
    },
    emitProgress: () => undefined,
    emitOutput: () => undefined,
  })
  try {
    await writePlugin(profileDir, '1.0.0-rc.10')
    const activeManifest = await readFile(path.join(profileDir, 'package.json'), 'utf8')
    const activePlugin = await readFile(pluginManifest(profileDir), 'utf8')
    await writePlugin(targetDir, '0.0.1', '@unrelated/demo')
    const targetManifest = path.join(targetDir, 'package.json')
    await writeFile(targetManifest, JSON.stringify({ dependencies: { '@unrelated/demo': '0.0.1' } }))
    expect((await service.load(true)).plugins[0]).toMatchObject({ installed: false, updateAvailable: false })
    expect(requests).toEqual(['https://awesome-dsh-plugin.com/plugins.json'])
    await writeFile(targetManifest, JSON.stringify(manifest))
    await writePlugin(targetDir, '1.0.0-rc.2', packageName, '@wrong/demo')
    expect((await service.load(true)).plugins[0]).toMatchObject({ installed: false, version: null, updateAvailable: false })
    await writePlugin(targetDir, '1.0.0-rc.2')
    await writeFile(targetManifest, JSON.stringify({ ...manifest, dependencies: { [packageName]: 'file:../../source' } }))
    expect((await service.load(true)).plugins[0]).toMatchObject({ installed: true, version: '1.0.0-rc.2', updateAvailable: false })
    await writeFile(targetManifest, JSON.stringify(manifest))
    registryName = '@unrelated/demo'
    expect((await service.load(true)).plugins[0]).toMatchObject({ updateAvailable: false, updateVersion: null })
    registryName = packageName
    expect((await service.load(true)).plugins[0]).toMatchObject({ packageName, enabled: false, version: '1.0.0-rc.2', updateAvailable: true, updateVersion: '1.0.0-rc.10' })
    await expect(service.update(entry.name, { url: entry.url, packageName: '@unrelated/demo' })).rejects.toThrow('插件身份已变更')
    await expect(service.update(entry.name, { url: 'https://github.com/other/demo', packageName })).rejects.toThrow('不在')
    expect(calls).toHaveLength(0)
    await expect(service.update(entry.name, { url: entry.url, packageName, expectedVersion: '1.0.0-rc.9' })).rejects.toThrow('兼容插件版本已变更')
    expect(calls).toHaveLength(0)
    reportSuccessWithoutUpdate = true
    await expect(service.update(entry.name, { url: entry.url, packageName })).rejects.toThrow('未在目标整合包中检测到指定的插件版本')
    reportSuccessWithoutUpdate = false
    await service.update(entry.name, { url: entry.url, packageName })
    expect(calls).toEqual(Array.from({ length: 2 }, () => ({ home: root, args: ['plugin', '--profile', targetName, 'add', packageName + '@1.0.0-rc.10'] })))
    expect((await service.load(true)).plugins[0]).toMatchObject({ enabled: false, version: '1.0.0-rc.10', updateAvailable: false })
    expect(await readFile(path.join(profileDir, 'package.json'), 'utf8')).toBe(activeManifest)
    expect(await readFile(pluginManifest(profileDir), 'utf8')).toBe(activePlugin)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('requires the exact monorepo directory to recognize a Git-only entry installed from npm', async () => {
  const { root, profileDir } = await tempProfile()
  const entry = { name: 'demo#bundle', owner: 'owner', url: 'https://github.com/owner/demo/tree/main/packages/bundle', category: 'plugin' }
  const name = '@published/bundle'
  const installed = path.join(profileDir, 'node_modules', name)
  const service = createDshMarketService({
    targeted: true,
    readSettings: async () => ({ ...marketSettings, dshHome: root, dshVersion: '0.2.1-rc.3' }),
    prepareNodeRuntime: async () => { throw new Error('not used while reading') },
    preparePnpmRuntime: async () => { throw new Error('not used while reading') },
    fetchImpl: async input => {
      const url = String(input)
      if (url.startsWith('https://raw.githubusercontent.com/')) return Response.json({ name })
      if (url.endsWith('/' + encodeURIComponent(name))) return Response.json(packument(name, '2.0.0', { '2.0.0': {} }))
      return registryResponse([entry])
    },
    emitProgress: () => undefined,
    emitOutput: () => undefined,
  })
  const dependency = async (spec: string) => writeFile(path.join(profileDir, 'package.json'), JSON.stringify({ dependencies: { [name]: spec } }))
  const packageFile = async (directory: string) => writeFile(path.join(installed, 'package.json'), JSON.stringify({ name, version: '1.0.0', repository: { url: 'git+https://github.com/owner/demo.git', directory } }))
  try {
    await mkdir(installed, { recursive: true })
    await dependency('^1.0.0')
    await packageFile('packages/other')
    expect((await service.load(true)).plugins[0]).toMatchObject({ installed: false })
    await packageFile('packages/bundle')
    expect((await service.load(true)).plugins[0]).toMatchObject({ installed: true, npm: name, packageName: name, updateAvailable: true })
    await dependency('github:owner/demo#path:/packages/other')
    expect((await service.load(true)).plugins[0]).toMatchObject({ installed: false })
    await dependency('github:owner/demo#path:/packages/bundle')
    expect((await service.load(true)).plugins[0]).toMatchObject({ installed: true, packageName: name, updateAvailable: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

describe('dsh-market network & recovery paths', () => {
  const node = async () => ({ root: 'C:/node', node: 'C:/node/node.exe', npm: 'C:/node/npm.cmd', npx: 'C:/node/npx.cmd', managed: true })
  const pnpm = async () => ({ root: 'C:/pnpm', executable: 'C:/pnpm/pnpm.cmd' })

  it('parses the monorepo branch from a GitHub tree URL', () => {
    expect(parseDshMarketSourceUrl('https://github.com/a/b/tree/main/packages/demo')).toEqual({ repo: 'a/b', subpath: 'packages/demo', branch: 'main' })
    expect(parseDshMarketSourceUrl('https://github.com/a/b')).toEqual({ repo: 'a/b', subpath: null, branch: null })
  })

  it('matches an installed npm alias back to its curated entry', () => {
    const entry = { name: 'dsh-web-ui#dsh-web-ui-all', owner: 'a', url: 'https://github.com/a/dsh-web-ui/tree/main/packages/dsh-web-ui-all', npm: null }
    expect(findDshMarketInstalledAlias(entry, { '@linxin/dsh-web-ui-all': '0.1.0' })).toBeNull()
    expect(findDshMarketInstalledAlias(entry, { '@linxin/dsh-web-ui-all': '0.1.0' }, '@linxin/dsh-web-ui-all')).toBe('@linxin/dsh-web-ui-all')
  })

  it('auto-approves pnpm-11 git build scripts before retrying the add', async () => {
    const { root, profileDir } = await tempProfile()
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async () => registryResponse([{ name: 'demo', owner: 'a', url: 'https://github.com/a/b/tree/main/packages/demo', category: 'plugin' }]),
      runCommand: async (_executable, args) => {
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        return addRuns === 1
          ? {
              exitCode: 1,
              output: 'The git-hosted package "@demo/demo@0.1.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.\n' +
                'Hint: Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:\n' +
                'allowBuilds:\n' +
                '  @demo/demo@https://codeload.github.com/a/b/tar.gz/abc#path:/packages/demo: true\n',
            }
          : { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    const workspace = parse(await readFile(path.join(profileDir, 'pnpm-workspace.yaml'), 'utf8'))
    expect(Object.keys((workspace as { allowBuilds: Record<string, unknown> }).allowBuilds)).toContain('@demo/demo@https://codeload.github.com/a/b/tar.gz/abc#path:/packages/demo')
    await rm(root, { recursive: true, force: true })
  })

  it('defaults to the npmmirror registry and switches to the official registry on network failure', async () => {
    const { root } = await tempProfile()
    const envs: Array<Record<string, string | undefined>> = []
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async () => registryResponse([{ name: 'demo', owner: 'a', url: 'https://github.com/a/b', npm: 'demo', category: 'plugin' }]),
      runCommand: async (_executable, args, options) => {
        envs.push(options.env)
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        return addRuns === 1 ? { exitCode: 1, output: 'ERR_PNPM_FETCH_500 ECONNRESET socket hang up' } : { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    expect(envs[0].npm_config_registry).toBe('https://registry.npmmirror.com')
    expect(envs[1].npm_config_registry).toBe('https://registry.npmjs.org')
    await rm(root, { recursive: true, force: true })
  })

  it('falls back to the npm package when the git subpackage uses workspace deps', async () => {
    const { root } = await tempProfile()
    const calls: string[] = []
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async input => {
        const url = String(input)
        if (url.includes('raw.githubusercontent.com')) {
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ name: '@linxin/demo', version: '0.2.0' }) } as unknown as Response
        }
        return registryResponse([{ name: 'demo', owner: 'a', url: 'https://github.com/a/b/tree/main/packages/demo', category: 'plugin' }])
      },
      runCommand: async (_executable, args) => {
        calls.push(args.join(' '))
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        return addRuns === 1
          ? { exitCode: 1, output: 'In C:\dsh: "@linxin/demo@workspace:*" is in the dependencies but no package named "@linxin/demo" is present in the workspace (WORKSPACE_PKG_NOT_FOUND)' }
          : { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    expect(calls).toEqual([
      'plugin --profile web add github:a/b#path:/packages/demo',
      'plugin --profile web add @linxin/demo@0.2.0 --ignore-scripts',
    ])
    await rm(root, { recursive: true, force: true })
  })
})

describe('dsh-market npm fallback search & activation', () => {
  const node = async () => ({ root: 'C:/node', node: 'C:/node/node.exe', npm: 'C:/node/npm.cmd', npx: 'C:/node/npx.cmd', managed: true })
  const pnpm = async () => ({ root: 'C:/pnpm', executable: 'C:/pnpm/pnpm.cmd' })

  it('falls back via the npm mirror search when the GitHub raw fetch is unreachable', async () => {
    const { root } = await tempProfile()
    const calls: string[] = []
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async input => {
        const url = String(input)
        if (url.includes('/-/v1/search')) {
          return {
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ objects: [{ package: { name: '@linxin/demo' } }, { package: { name: 'unrelated-tool' } }] }),
          } as unknown as Response
        }
        if (url.includes('raw.githubusercontent.com')) {
          return { ok: false, status: 404, headers: { get: () => null } } as unknown as Response
        }
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ updated: 'x', count: 1, categories: {}, plugins: [{ name: 'demo', owner: 'a', url: 'https://github.com/a/b/tree/main/packages/demo', category: 'plugin' }] }),
        } as unknown as Response
      },
      runCommand: async (_executable, args) => {
        calls.push(args.join(' '))
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        return addRuns === 1 ? { exitCode: 1, output: 'ECONNRESET socket hang up' } : { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    await expect(service.install('demo')).rejects.toThrow('未检测到安装结果')
    expect(addRuns).toBe(2)
    expect(calls).toEqual([
      'plugin --profile web add github:a/b#path:/packages/demo',
      'plugin --profile web add @linxin/demo --ignore-scripts',
    ])
    await rm(root, { recursive: true, force: true })
  })

  it('activates the installed npm fallback package into the profile bundles', async () => {
    const { root, profileDir } = await tempProfile()
    let addRuns = 0
    const service = createDshMarketService({
      readSettings: async () => ({ ...marketSettings, dshHome: root }),
      prepareNodeRuntime: node,
      preparePnpmRuntime: pnpm,
      fetchImpl: async input => {
        const url = String(input)
        if (url.includes('raw.githubusercontent.com')) {
          return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ name: '@linxin/demo', version: '0.2.0' }) } as unknown as Response
        }
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({ updated: 'x', count: 1, categories: {}, plugins: [{ name: 'demo', owner: 'a', url: 'https://github.com/a/b/tree/main/packages/demo', category: 'plugin' }] }),
        } as unknown as Response
      },
      runCommand: async (_executable, args) => {
        if (!args.includes('add')) return { exitCode: 0, output: 'Done in 1s' }
        addRuns += 1
        if (addRuns === 1) return { exitCode: 1, output: 'WORKSPACE_PKG_NOT_FOUND workspace:*' }
        // 模拟 pnpm add 成功：写入依赖与可加载的 bundle 包。
        const manifestPath = path.join(profileDir, 'package.json')
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        manifest.dependencies = { '@linxin/demo': '0.2.0' }
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
        await mkdir(path.join(profileDir, 'node_modules', '@linxin', 'demo'), { recursive: true })
        await writeFile(
          path.join(profileDir, 'node_modules', '@linxin', 'demo', 'package.json'),
          JSON.stringify({ name: '@linxin/demo', version: '0.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
          'utf8',
        )
        return { exitCode: 0, output: 'done' }
      },
      emitProgress: () => undefined,
      emitOutput: () => undefined,
    })

    const installed = await service.install('demo')
    const manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    expect(manifest.dsh.profile.bundles).toContain('@linxin/demo')
    expect(installed.some(item => item.name === 'demo' && item.installed)).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
})
