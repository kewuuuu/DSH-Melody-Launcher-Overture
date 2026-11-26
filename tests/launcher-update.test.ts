import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  APPLY_STOP_PACKS_TIMEOUT_MESSAGE,
  checkLauncherUpdate,
  createLauncherUpdater,
  detectInstallMode,
  isPortableRuntime,
  resolveSetupAsset,
  versionFromAssetName,
} from '../electron/launcher-update'
import type { LauncherUpdater } from '../electron/launcher-update'
import { LAUNCHER_RELEASE_REPOSITORY } from '../src/constants'

import { createUpdateFlow } from '../electron/update-flow'
import { defaultSettings } from '../electron/settings'

const SETUP_KEWU = 'DSH-launcher-KEWU-Setup-1.1.0.exe'
const HANDOFF_SETUP = 'DSH-launcher-KEWU-Setup-1.3.7.exe'
const OPERATION_ID = '2ff065d2-1c98-4b56-bccc-4a6e351ec279'
const LEGACY_SETUP = 'DSH-Launcher-1.0.4-setup.exe'
const setupDigest = (bytes: Uint8Array): string => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const ZERO_SETUP_DIGEST = setupDigest(Buffer.alloc(9))
const CHUNKED_SETUP_DIGEST = setupDigest(Buffer.alloc(9, 0x41))
/** 安装版进程的 exe：不在 node_modules 里，名字也不带 portable。 */
const INSTALLED_EXEC = 'C:\\Program Files\\DSH-launcher-KEWU\\DSH-launcher-KEWU.exe'
const INSTALLED_DIR = 'C:\\Program Files\\DSH-launcher-KEWU'
/** 开发态：execPath 落在 node_modules 里。 */
const DEV_EXEC = 'C:\\dev\\dshlauncher\\node_modules\\electron\\dist\\electron.exe'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

type UpdaterOptions = Parameters<typeof createLauncherUpdater>[0]

/** 构造带任意资产的 Release 响应（多资产场景用）。 */
function assetsBody(remoteTag: string, assets: Array<{ name: string; size?: number; digest?: unknown }>): unknown {
  return {
    tag_name: remoteTag,
    html_url: 'https://github.com/' + LAUNCHER_RELEASE_REPOSITORY + '/releases/tag/' + remoteTag,
    assets: assets.map(asset => ({
      name: asset.name,
      browser_download_url: 'https://github.com/' + LAUNCHER_RELEASE_REPOSITORY + '/releases/download/' + remoteTag + '/' + asset.name,
      size: asset.size ?? 9,
      digest: asset.digest,
    })),
  }
}

/** 构造 /releases/latest 的响应；默认只发 Setup（这条产品线唯一的产物）。 */
function releaseBody(remoteTag = 'v0.1.10', assetName = SETUP_KEWU, assetSize = 9, digest?: unknown): unknown {
  if (!assetName) {
    return { tag_name: remoteTag, html_url: 'https://github.com/' + LAUNCHER_RELEASE_REPOSITORY + '/releases/tag/' + remoteTag, assets: [] }
  }
  return assetsBody(remoteTag, [{ name: assetName, size: assetSize, digest }])
}

function latestFetch(body: unknown, status = 200): typeof fetch {
  return (async input => {
    if (String(input).endsWith('/repos/' + LAUNCHER_RELEASE_REPOSITORY + '/releases/latest')) {
      return new Response(status === 200 ? JSON.stringify(body) : '', { status })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
}

/** 分块发送内容的假 fetch，模拟 GitHub 资产下载。 */
function chunkedAssetFetch(chunkSize = 3, total = 9, body: unknown = releaseBody()): typeof fetch {
  return (async input => {
    const url = String(input)
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(body), { status: 200 })
    if (url.includes('/releases/download/')) {
      const bytes = new Uint8Array(total)
      bytes.fill(0x41)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let offset = 0
          while (offset < total) {
            controller.enqueue(bytes.slice(offset, Math.min(offset + chunkSize, total)))
            offset += chunkSize
          }
          controller.close()
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-length': String(total) } })
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
}

function tempUserData(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'launcher-update-'))
}

interface Harness {
  updater: LauncherUpdater
  userDataPath: string
  updateRoot: string
  /** 按发生顺序记录 stopPacks 与 spawn 的调用。 */
  calls: string[]
  spawned: Array<{ command: string; args: string[]; options?: Record<string, unknown> }>
  exitCodes: number[]
}

/**
 * 造一个「已下载好 Setup、可以 apply」的安装版启动器：
 * 下载目录里先放一份与资产摘要匹配的文件，download() 校验后直接复用。
 */
async function readyUpdater(overrides: Partial<UpdaterOptions> = {}, tag = 'v1.3.7', asset = HANDOFF_SETUP): Promise<Harness> {
  const userDataPath = overrides.userDataPath ?? tempUserData()
  const updateRoot = path.join(userDataPath, 'launcher-update')
  await mkdir(updateRoot, { recursive: true })
  await writeFile(path.join(updateRoot, asset), new Uint8Array(9))
  const calls: string[] = []
  const spawned: Harness['spawned'] = []
  const exitCodes: number[] = []
  const fakeSpawn = ((command: string, args: string[], spawnOptions: Record<string, unknown>) => {
    calls.push('spawn')
    spawned.push({ command, args, options: spawnOptions })
    const child = Object.assign(new EventEmitter(), { unref: () => undefined })
    queueMicrotask(() => child.emit('spawn'))
    return child
  }) as never
  const fakeExit = ((code: number) => {
    exitCodes.push(code)
    return undefined
  }) as never
  const updater = createLauncherUpdater({
    getVersion: () => '1.0.4',
    userDataPath,
    getExecPath: () => INSTALLED_EXEC,
    githubFetch: latestFetch(releaseBody(tag, asset, 9, ZERO_SETUP_DIGEST)),
    emitProgress: () => undefined,
    spawnProcess: fakeSpawn,
    exitProcess: fakeExit,
    stopPacks: () => {
      calls.push('stop')
    },
    ...overrides,
  } as UpdaterOptions)
  await updater.check()
  const status = await updater.download()
  expect(status.state).toBe('downloaded')
  return { updater, userDataPath, updateRoot, calls, spawned, exitCodes }
}

describe('resolveSetupAsset', () => {
  it('从 Release 里挑出 Setup 安装包', () => {
    expect(resolveSetupAsset(releaseBody() as never)).toEqual({
      name: SETUP_KEWU,
      size: 9,
      url: 'https://github.com/' + LAUNCHER_RELEASE_REPOSITORY + '/releases/download/v0.1.10/' + SETUP_KEWU,
    })
  })

  it('没有 Setup 资产时返回 null（便携包与 latest.yml 都不算）', () => {
    const release = assetsBody('v1.1.0', [
      { name: 'DSH-launcher-KEWU-Portable-1.1.0.exe' },
      { name: 'latest.yml' },
    ]) as never
    expect(resolveSetupAsset(release)).toBeNull()
  })

  it('多个 Setup 资产时取文件名里版本号最大的那个', () => {
    const release = assetsBody('v1.1.0', [
      { name: 'DSH-launcher-KEWU-Setup-1.0.4.exe' },
      { name: 'DSH-launcher-KEWU-Setup-1.1.0.exe' },
      { name: 'DSH-launcher-KEWU-Setup-1.0.10.exe' },
    ]) as never
    expect(resolveSetupAsset(release)?.name).toBe(SETUP_KEWU)
  })

  it('旧命名 DSH-Launcher-1.0.4-setup.exe 仍然被选中（大小写无关）', () => {
    const release = assetsBody('v1.0.4', [{ name: LEGACY_SETUP }]) as never
    expect(resolveSetupAsset(release)?.name).toBe(LEGACY_SETUP)
  })
})

describe('versionFromAssetName', () => {
  it('取文件名里最后一个版本号', () => {
    expect(versionFromAssetName(SETUP_KEWU)).toBe('1.1.0')
    expect(versionFromAssetName('DSH-launcher-KEWU-Setup-1.0.10.exe')).toBe('1.0.10')
    expect(versionFromAssetName('launcher.exe')).toBeNull()
  })
})

describe('detectInstallMode', () => {
  it('安装版 exe（不在 node_modules、名不带 portable）视为 installed', () => {
    expect(detectInstallMode(INSTALLED_EXEC, null)).toBe('installed')
  })

  it('execPath 落在 node_modules 里视为 dev', () => {
    expect(detectInstallMode(DEV_EXEC, null)).toBe('dev')
  })

  it('PORTABLE_EXECUTABLE_FILE 存在也判成 dev：便携版已停发', () => {
    expect(detectInstallMode('C:\\x\\launcher.exe', 'C:\\x\\launcher.exe')).toBe('dev')
  })

  it('exe 名带 -portable 同样判成 dev', () => {
    expect(detectInstallMode('C:\\Launcher\\DSH-Launcher-0.1.9-portable.exe', null)).toBe('dev')
  })
})

describe('isPortableRuntime', () => {
  it('环境变量有值时是历史便携包', () => {
    expect(isPortableRuntime(INSTALLED_EXEC, 'C:\\Launcher\\DSH-launcher-KEWU.exe')).toBe(true)
  })

  it('安装版不是便携包', () => {
    expect(isPortableRuntime(INSTALLED_EXEC, null)).toBe(false)
    expect(isPortableRuntime(INSTALLED_EXEC, '   ')).toBe(false)
  })
})

describe('checkLauncherUpdate', () => {
  it('远端更新时报告 update-available，并带上 Setup 的名字与大小', async () => {
    const status = await checkLauncherUpdate(() => '0.1.9', latestFetch(releaseBody()))
    expect(status).toMatchObject({
      state: 'update-available',
      localVersion: '0.1.9',
      remoteVersion: '0.1.10',
      assetName: SETUP_KEWU,
      assetSize: 9,
      releaseUrl: 'https://github.com/' + LAUNCHER_RELEASE_REPOSITORY + '/releases/tag/v0.1.10',
    })
  })

  it('把 Release 正文带进 update-available 状态（详情弹窗的「更新内容」）', async () => {
    const body = { ...(releaseBody() as object), body: '### v0.1.10\n- 修复官方整合包' }
    const status = await checkLauncherUpdate(() => '0.1.9', latestFetch(body))
    expect(status.state).toBe('update-available')
    expect(status.releaseNotes).toBe('### v0.1.10\n- 修复官方整合包')
  })

  it('版本相同报告 up-to-date（容忍前导 v），且不带资产名', async () => {
    const status = await checkLauncherUpdate(() => '0.1.9', latestFetch(releaseBody('v0.1.9')))
    expect(status.state).toBe('up-to-date')
    expect(status.remoteVersion).toBe('0.1.9')
    expect(status.assetName).toBeNull()
  })

  it('本地更新时报告 up-to-date', async () => {
    const status = await checkLauncherUpdate(() => '0.1.11', latestFetch(releaseBody('v0.1.10')))
    expect(status.state).toBe('up-to-date')
  })

  it('HTTP 失败时返回 error 状态而不是抛异常', async () => {
    const status = await checkLauncherUpdate(() => '0.1.9', latestFetch(releaseBody(), 403))
    expect(status.state).toBe('error')
    expect(status.message).toContain('额度')
  })

  it('Release 一个安装包都没有时返回中文 error', async () => {
    const status = await checkLauncherUpdate(() => '0.1.9', latestFetch(releaseBody('v0.1.10', '')))
    expect(status.state).toBe('error')
    expect(status.message).toContain('没有可下载的安装包')
  })

  it('Release 缺版本号时返回中文 error', async () => {
    const status = await checkLauncherUpdate(() => '0.1.9', latestFetch({ assets: [] }))
    expect(status.state).toBe('error')
    expect(status.message).toContain('缺少版本号')
  })

  it('JSON 坏掉时返回 error 状态', async () => {
    const malformed = (async input => {
      if (String(input).endsWith('/releases/latest')) return new Response('not json', { status: 200 })
      return new Response('', { status: 404 })
    }) as typeof fetch
    const status = await checkLauncherUpdate(() => '0.1.9', malformed)
    expect(status.state).toBe('error')
  })

  it('主接口被限流时回退镜像', async () => {
    const withMirror = (async input => {
      const url = String(input)
      if (url.startsWith('https://api.github.com/')) return new Response('', { status: 403 })
      if (url.includes('/releases/latest')) return new Response(JSON.stringify(releaseBody()), { status: 200 })
      return new Response('', { status: 404 })
    }) as typeof fetch
    const status = await checkLauncherUpdate(() => '0.1.9', withMirror)
    expect(status.state).toBe('update-available')
    expect(status.remoteVersion).toBe('0.1.10')
    expect(status.assetName).toBe(SETUP_KEWU)
  })

  it('主接口可用时只请求一次', async () => {
    const hits: string[] = []
    const tracking = (async input => {
      hits.push(String(input))
      if (String(input).endsWith('/releases/latest')) return new Response(JSON.stringify(releaseBody()), { status: 200 })
      return new Response('', { status: 404 })
    }) as typeof fetch
    await checkLauncherUpdate(() => '0.1.9', tracking)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('https://api.github.com/')
  })
})

describe('createLauncherUpdater download', () => {
  it('分块下载 Setup，进度按字节上报到 100%', async () => {
    const userDataPath = tempUserData()
    const progresses: Array<{ phase: string; percent: number }> = []
    const updater = createLauncherUpdater({
      getVersion: () => '0.1.9',
      userDataPath,
      getExecPath: () => INSTALLED_EXEC,
      githubFetch: chunkedAssetFetch(3, 9, releaseBody('v1.1.0', SETUP_KEWU, 9, CHUNKED_SETUP_DIGEST)),
      emitProgress: progress => progresses.push(progress),
    })
    await updater.check()
    const status = await updater.download()
    expect(status.state).toBe('downloaded')
    expect(progresses.length).toBeGreaterThan(0)
    expect(progresses.every(progress => progress.phase === 'downloading')).toBe(true)
    expect(progresses.at(-1)?.percent).toBe(100)
    const saved = await readFile(path.join(userDataPath, 'launcher-update', SETUP_KEWU))
    expect(saved.length).toBe(9)
    expect(saved[0]).toBe(0x41)
  })

  it('复用 SHA-256 匹配的缓存，且无需下载资产', async () => {
    const { updateRoot } = await readyUpdater()
    expect(await readFile(path.join(updateRoot, HANDOFF_SETUP))).toEqual(Buffer.alloc(9))
  })

  it.each([CHUNKED_SETUP_DIGEST.toUpperCase(), null])('重新下载不可验证的同大小缓存（digest=%s）', async digest => {
    const userDataPath = tempUserData()
    const updateRoot = path.join(userDataPath, 'launcher-update')
    const setupPath = path.join(updateRoot, SETUP_KEWU)
    await mkdir(updateRoot)
    await writeFile(setupPath, Buffer.alloc(9))
    const updater = createLauncherUpdater({
      getVersion: () => '1.0.4',
      userDataPath,
      githubFetch: chunkedAssetFetch(3, 9, releaseBody('v1.1.0', SETUP_KEWU, 9, digest)),
      emitProgress: () => undefined,
    })
    await updater.check()
    expect((await updater.download()).state).toBe('downloaded')
    expect(await readFile(setupPath)).toEqual(Buffer.alloc(9, 0x41))
    expect(await readdir(updateRoot)).toEqual([SETUP_KEWU])
  })

  it('摘要不符时拒绝安装并清除旧缓存，保留版本信息以便重试', async () => {
    const userDataPath = tempUserData()
    const updateRoot = path.join(userDataPath, 'launcher-update')
    await mkdir(updateRoot)
    await writeFile(path.join(updateRoot, SETUP_KEWU), Buffer.alloc(9, 0x43))
    const body = releaseBody('v1.1.0', SETUP_KEWU, 9, ZERO_SETUP_DIGEST)
    const badFetch = chunkedAssetFetch(3, 9, body)
    let useCorrectAsset = false
    const updater = createLauncherUpdater({
      getVersion: () => '1.0.4',
      userDataPath,
      githubFetch: async (input, init) => useCorrectAsset && String(input).includes('/releases/download/')
        ? new Response(Buffer.alloc(9))
        : badFetch(input, init),
      emitProgress: () => undefined,
    })
    await updater.check()
    expect(await updater.download()).toMatchObject({
      state: 'error',
      remoteVersion: '1.1.0',
      assetName: SETUP_KEWU,
      assetSize: 9,
      message: expect.stringContaining('SHA-256 校验失败'),
    })
    await expect(updater.apply()).rejects.toThrow('没有已下载的启动器更新')
    expect(await readdir(updateRoot)).toEqual([])
    useCorrectAsset = true
    expect((await updater.download()).state).toBe('downloaded')
    expect(await readFile(path.join(updateRoot, SETUP_KEWU))).toEqual(Buffer.alloc(9))
  })

  it('存在但格式无效的摘要不会回退到只校验大小', async () => {
    const userDataPath = tempUserData()
    const updater = createLauncherUpdater({
      getVersion: () => '1.0.4',
      userDataPath,
      githubFetch: chunkedAssetFetch(3, 9, releaseBody('v1.1.0', SETUP_KEWU, 9, 'sha256:invalid')),
      emitProgress: () => undefined,
    })
    await updater.check()
    expect(await updater.download()).toMatchObject({ state: 'error', message: expect.stringContaining('SHA-256 校验值无效') })
    expect(await readdir(userDataPath)).toEqual([])
  })

  it.each(['headers', 'first byte', 'partial body', 'EOF'] as const)('下载卡在 %s 时超时并中止传输', async stage => {
    const userDataPath = tempUserData()
    let downloadSignal: AbortSignal | null | undefined
    let bodyCancelled = false
    const updater = createLauncherUpdater({
      getVersion: () => '1.0.4',
      userDataPath,
      downloadIdleTimeoutMs: 40,
      githubFetch: async (input, init) => {
        if (String(input).endsWith('/releases/latest')) return new Response(JSON.stringify(releaseBody('v1.1.0')))
        downloadSignal = init?.signal
        if (stage === 'headers') return new Promise<Response>(() => undefined)
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            if (stage === 'partial body') controller.enqueue(Buffer.alloc(3))
            if (stage === 'EOF') controller.enqueue(Buffer.alloc(9))
          },
          cancel() { bodyCancelled = true },
        }), { headers: { 'content-length': '9' } })
      },
      emitProgress: () => undefined,
    })
    await updater.check()
    expect(await updater.download()).toMatchObject({ state: 'error', message: expect.stringContaining('下载超时') })
    expect(downloadSignal).toMatchObject({ aborted: true })
    expect(bodyCancelled).toBe(stage !== 'headers')
    expect(await readdir(userDataPath)).toEqual([])
  })

  it('持续收到数据时允许下载超过单次空闲时限', async () => {
    const userDataPath = tempUserData()
    const started = deferred()
    let stream!: ReadableStreamDefaultController<Uint8Array>
    vi.useFakeTimers()
    try {
      const updater = createLauncherUpdater({
        getVersion: () => '1.0.4',
        userDataPath,
        downloadIdleTimeoutMs: 100,
        githubFetch: async input => {
          if (String(input).endsWith('/releases/latest')) return new Response(JSON.stringify(releaseBody('v1.1.0')))
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller
              started.resolve()
            },
          }))
        },
        emitProgress: () => undefined,
      })
      await updater.check()
      const download = updater.download()
      await started.promise
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(60)
        stream.enqueue(Buffer.alloc(3))
      }
      await vi.advanceTimersByTimeAsync(60)
      stream.close()
      expect((await download).state).toBe('downloaded')
    } finally {
      vi.useRealTimers()
    }
  })

  it('无法原子替换目标时清理临时文件', async () => {
    const userDataPath = tempUserData()
    const updateRoot = path.join(userDataPath, 'launcher-update')
    const setupPath = path.join(updateRoot, SETUP_KEWU)
    const updater = createLauncherUpdater({
      getVersion: () => '1.0.4',
      userDataPath,
      githubFetch: chunkedAssetFetch(3, 9, releaseBody('v1.1.0')),
      emitProgress: () => { mkdirSync(setupPath, { recursive: true }) },
    })
    await updater.check()
    expect((await updater.download()).state).toBe('error')
    expect(await readdir(updateRoot)).toEqual([SETUP_KEWU])
    expect(await readdir(setupPath)).toEqual([])
  })

  it('没有待更新时原样返回当前状态', async () => {
    const updater = createLauncherUpdater({
      getVersion: () => '1.1.0',
      userDataPath: tempUserData(),
      getExecPath: () => INSTALLED_EXEC,
      githubFetch: latestFetch(assetsBody('v1.1.0', [{ name: SETUP_KEWU }])),
      emitProgress: () => undefined,
    })
    await updater.check()
    const status = await updater.download()
    expect(status.state).toBe('up-to-date')
  })

  it('下载字节数与资产大小不符时进 error 状态', async () => {
    const userDataPath = tempUserData()
    const lying = (async input => {
      const url = String(input)
      if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(releaseBody('v1.1.0')), { status: 200 })
      if (url.includes('/releases/download/')) {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]))
            controller.close()
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-length': '1000' } })
      }
      return new Response('', { status: 404 })
    }) as typeof fetch
    const updater = createLauncherUpdater({
      getVersion: () => '1.0.4',
      userDataPath,
      getExecPath: () => INSTALLED_EXEC,
      githubFetch: lying,
      emitProgress: () => undefined,
    })
    await updater.check()
    const status = await updater.download()
    expect(status.state).toBe('error')
    expect(status.message).toContain('下载内容不完整')
    expect(await readdir(userDataPath)).toEqual([])
  })
})

describe('apply（安装版：直接启动 Setup）', () => {
  it('没有已下载的更新就 apply 时抛中文错误', async () => {
    const updater = createLauncherUpdater({
      getVersion: () => '1.0.4',
      userDataPath: tempUserData(),
      getExecPath: () => INSTALLED_EXEC,
      githubFetch: latestFetch(releaseBody()),
      emitProgress: () => undefined,
    })
    await expect(updater.apply()).rejects.toThrow('没有已下载的启动器更新')
  })

  it('dev 模式拒绝自动更新', async () => {
    delete process.env.PORTABLE_EXECUTABLE_FILE
    const { updater } = await readyUpdater({ getExecPath: () => DEV_EXEC })
    await expect(updater.apply()).rejects.toThrow('自动更新仅支持安装版启动器')
  })

  it('便携包环境给出「便携版已停发」中文错误', async () => {
    const previous = process.env.PORTABLE_EXECUTABLE_FILE
    process.env.PORTABLE_EXECUTABLE_FILE = 'C:\\Launcher\\DSH-launcher-KEWU.exe'
    try {
      const { updater } = await readyUpdater()
      await expect(updater.apply()).rejects.toThrow('便携版已停发，请改用安装版。')
    } finally {
      if (previous === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE
      else process.env.PORTABLE_EXECUTABLE_FILE = previous
    }
  })

  it('stops packs, launches the verified Setup with raw NSIS arguments, then exits', async () => {
    const userDataPath = path.join(tempUserData(), 'custom cache & 10%')
    const { updater, updateRoot, calls, spawned, exitCodes } = await readyUpdater({ userDataPath })
    const beforeCommit = vi.fn(async () => { calls.push('arm') })
    const onCommit = vi.fn(() => {
      expect(exitCodes).toEqual([])
      calls.push('commit')
    })
    await updater.apply({ beforeCommit, onCommit })

    expect(calls).toEqual(['stop', 'arm', 'spawn', 'commit'])
    const setupPath = path.join(updateRoot, HANDOFF_SETUP)
    expect(spawned).toEqual([{
      command: setupPath,
      args: ['/S', '--dsh-handoff=' + process.pid, '/D=' + INSTALLED_DIR],
      options: {
        argv0: '"' + setupPath + '"',
        cwd: updateRoot,
        detached: true,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    }])
    expect(exitCodes).toEqual([0])

    const logName = 'handoff-' + process.pid + '.log'
    expect((await readdir(updateRoot)).sort()).toEqual([HANDOFF_SETUP, logName].sort())
    expect(await readFile(path.join(updateRoot, logName), 'utf8')).toContain('[apply] apply requested for ' + HANDOFF_SETUP)
  })

  it.each([
    ['v1.3.6', 'DSH-launcher-KEWU-Setup-1.3.6.exe'],
    ['v1.3.7-rc.1', 'DSH-launcher-KEWU-Setup-1.3.7-rc.1.exe'],
    ['v1.3.7', 'DSH-launcher-KEWU-Setup-1.3.6.exe'],
  ])('refuses unsupported handoff or a mismatched installer (%s, %s)', async (tag, asset) => {
    const { updater, calls, exitCodes } = await readyUpdater({}, tag, asset)
    await expect(updater.apply()).rejects.toThrow('不支持安全更新交接')
    expect(calls).toEqual([])
    expect(exitCodes).toEqual([])
  })

  it.each([undefined, '1.3.6', 'invalid'])('rejects a continuation with an incompatible apply context (%s)', async reason => {
    const preserveRunningPacks = reason !== undefined
    const { updater, calls, exitCodes } = await readyUpdater({ preserveRunningPacks, prepareForRelaunch: () => undefined })
    const continuation = { operationId: reason === 'invalid' ? OPERATION_ID + '\n' : OPERATION_ID, toVersion: reason === '1.3.6' ? reason : '1.3.7' }
    const beforeCommit = vi.fn()
    await expect(updater.apply({ continuation, beforeCommit })).rejects.toThrow(reason === 'invalid' ? 'Invalid launcher update continuation ID' : '与续接请求不匹配')
    expect(beforeCommit).not.toHaveBeenCalled()
    expect(calls).toEqual([])
    expect(exitCodes).toEqual([])
  })

  it('waits for sessions before preserving live packs and only passes a cache-root marker', async () => {
    const dataDir = path.join(tempUserData(), 'Custom data & 10% !')
    const prepared: boolean[] = []
    const { updater, updateRoot, calls, spawned, exitCodes } = await readyUpdater({
      userDataPath: dataDir,
      preserveRunningPacks: true,
      prepareForRelaunch: signal => { prepared.push(signal.aborted) },
      relaunchDataDir: dataDir,
    })
    const forbidden: string[] = []
    const forbiddenCall = (name: string) => () => {
      forbidden.push(name)
      throw new Error(name)
    }
    let probes = 0
    const wait = vi.fn(async () => {})
    const flow = createUpdateFlow({
      preserveRunningPacks: true,
      updater,
      settings: { read: async () => defaultSettings({ homeDirectory: updateRoot, documentsDirectory: updateRoot, platform: 'win32' }) },
      listRunningPacks: async () => [{ id: 'pack-a', url: 'http://127.0.0.1:3080/web' }],
      countRunningSessions: async () => ++probes === 1 ? 1 : 0,
      saveResume: forbiddenCall('save'),
      clearResume: forbiddenCall('clear'),
      wait,
    })
    expect((await updater.check()).state).toBe('downloaded')
    await flow.start()
    await flow.settled()
    expect(forbidden).toEqual([])
    expect(wait).toHaveBeenCalledTimes(1)
    expect(probes).toBe(3)
    expect(flow.status()).toMatchObject({ phase: 'applying', busy: [], resumePacks: [] })
    expect(prepared).toEqual([false])
    expect(calls).toEqual(['spawn'])
    expect(exitCodes).toEqual([0])
    expect(spawned[0].args).toEqual(['/S', '--dsh-handoff=' + process.pid, '--dsh-use-cache-root=1', '/D=' + INSTALLED_DIR])
  })

  it('rejects duplicate apply and rolls back cancellation during live preparation', async () => {
    const controller = new AbortController()
    const entered = deferred()
    const proceed = deferred()
    const rolledBack: boolean[] = []
    const { updater, calls, exitCodes } = await readyUpdater({
      preserveRunningPacks: true,
      prepareForRelaunch: async signal => {
        entered.resolve()
        await proceed.promise
        return () => { rolledBack.push(signal.aborted) }
      },
    })
    const applied = updater.apply({ signal: controller.signal })
    const rejected = expect(applied).rejects.toThrow('cancelled')
    await entered.promise
    expect((await updater.check()).state).toBe('applying')
    expect((await updater.download()).state).toBe('applying')
    await expect(updater.apply()).rejects.toThrow('正在安装')
    controller.abort(new Error('cancelled'))
    proceed.resolve()
    await rejected
    expect((await updater.check()).state).toBe('downloaded')
    expect(rolledBack).toEqual([true])
    expect(calls).toEqual([])
    expect(exitCodes).toEqual([])
  })

  it('keeps the launcher alive if preparation or process spawn fails', async () => {
    const rollback: string[] = []
    const { updater, calls, exitCodes } = await readyUpdater({
      preserveRunningPacks: true,
      prepareForRelaunch: () => { throw new Error('prepare failed') },
    })
    await expect(updater.apply()).rejects.toThrow('prepare failed')
    expect(calls).toEqual([])
    expect(exitCodes).toEqual([])

    const failing = await readyUpdater({
      preserveRunningPacks: true,
      prepareForRelaunch: () => () => { rollback.push('rollback') },
      spawnProcess: (() => {
        const child = new EventEmitter()
        queueMicrotask(() => child.emit('error', new Error('Setup missing')))
        return child
      }) as never,
    })
    await expect(failing.updater.apply()).rejects.toThrow('Setup missing')
    expect(failing.exitCodes).toEqual([])
    expect(rollback).toEqual(['rollback'])
    expect((await failing.updater.check()).state).toBe('downloaded')
  })

  it('rolls back when the installer exits immediately before commit', async () => {
    const rollback = vi.fn()
    const onCommit = vi.fn()
    const { updater, exitCodes } = await readyUpdater({
      preserveRunningPacks: true,
      prepareForRelaunch: () => rollback,
      spawnProcess: (() => {
        const child = new EventEmitter()
        queueMicrotask(() => {
          child.emit('spawn')
          child.emit('exit', 2, null)
        })
        return child
      }) as never,
    })
    await expect(updater.apply({ onCommit })).rejects.toThrow('安装程序在交接前退出（2）')
    expect(onCommit).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledOnce()
    expect(exitCodes).toEqual([])
    expect((await updater.check()).state).toBe('downloaded')
  })

  it('passes the armed UUID to Setup with the independently selected cache root', async () => {
    const dataDir = path.join(tempUserData(), 'Custom data')
    const beforeCommit = vi.fn(async () => undefined)
    const { updater, spawned, exitCodes } = await readyUpdater({
      userDataPath: dataDir,
      relaunchDataDir: dataDir,
      preserveRunningPacks: true,
      prepareForRelaunch: () => undefined,
    })
    await updater.apply({ beforeCommit, continuation: { operationId: OPERATION_ID, toVersion: '1.3.7' } })
    expect(beforeCommit).toHaveBeenCalledOnce()
    expect(spawned[0].args).toEqual(['/S', '--dsh-handoff=' + process.pid, '--dsh-continue=' + OPERATION_ID, '--dsh-use-cache-root=1', '/D=' + INSTALLED_DIR])
    expect(exitCodes).toEqual([0])
  })

  it('awaits graceful exit after Setup spawn and keeps a failed exit committed', async () => {
    const exiting = deferred()
    const release = deferred()
    const rollback: string[] = []
    const { updater, calls } = await readyUpdater({
      preserveRunningPacks: true,
      prepareForRelaunch: () => () => { rollback.push('rollback') },
      exitProcess: async () => {
        exiting.resolve()
        await release.promise
        throw new Error('quit failed')
      },
    })
    const applied = updater.apply()
    const rejected = expect(applied).rejects.toThrow('quit failed')
    await exiting.promise
    expect(calls).toEqual(['spawn'])
    expect((await updater.check()).state).toBe('applying')
    release.resolve()
    await rejected
    expect((await updater.check()).state).toBe('applying')
    expect(rollback).toEqual([])
  })

  it('整合包停不下来时中止更新，且不拉起安装助手', async () => {
    delete process.env.PORTABLE_EXECUTABLE_FILE
    const { updater, spawned, exitCodes } = await readyUpdater({
      stopPacks: () => new Promise<void>(() => undefined),
      stopPacksTimeoutMs: 10,
    })
    await expect(updater.apply()).rejects.toThrow(APPLY_STOP_PACKS_TIMEOUT_MESSAGE)
    expect(spawned).toHaveLength(0)
    expect(exitCodes).toHaveLength(0)
  })

  it('交接前拒绝下载后被替换的同大小安装包', async () => {
    const { updater, updateRoot, calls, spawned } = await readyUpdater()
    await writeFile(path.join(updateRoot, HANDOFF_SETUP), Buffer.alloc(9, 1))
    await expect(updater.apply()).rejects.toThrow('安装包校验失败')
    expect(calls).toEqual([])
    expect(spawned).toEqual([])
    await expect(updater.apply()).rejects.toThrow('没有已下载的启动器更新')
  })

  it('rechecks the digest after preparation and rolls back if the cached installer changed', async () => {
    const rollback = vi.fn()
    const { updater, updateRoot, spawned, exitCodes } = await readyUpdater({
      preserveRunningPacks: true,
      prepareForRelaunch: () => rollback,
    })
    const beforeCommit = () => writeFile(path.join(updateRoot, HANDOFF_SETUP), Buffer.alloc(9, 1))
    await expect(updater.apply({ beforeCommit })).rejects.toThrow('安装包校验失败')
    expect(rollback).toHaveBeenCalledOnce()
    expect(spawned).toEqual([])
    expect(exitCodes).toEqual([])
  })

  it('安装包没下载完就 apply 时抛中文错误', async () => {
    delete process.env.PORTABLE_EXECUTABLE_FILE
    const userDataPath = tempUserData()
    const updateRoot = path.join(userDataPath, 'launcher-update')
    await mkdir(updateRoot, { recursive: true })
    const updater = createLauncherUpdater({
      getVersion: () => '1.0.4',
      userDataPath,
      getExecPath: () => INSTALLED_EXEC,
      githubFetch: latestFetch(assetsBody('v1.1.0', [{ name: SETUP_KEWU }])),
      emitProgress: () => undefined,
      spawnProcess: (() => ({ unref: () => undefined })) as never,
      exitProcess: (() => undefined) as never,
    })
    await updater.check()
    const status = await updater.download()
    expect(status.state).toBe('error')
  })
})
