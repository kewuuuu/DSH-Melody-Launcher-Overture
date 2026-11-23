import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
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

const SETUP_KEWU = 'DSH-launcher-KEWU-Setup-1.1.0.exe'
const LEGACY_SETUP = 'DSH-Launcher-1.0.4-setup.exe'
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
function assetsBody(remoteTag: string, assets: Array<{ name: string; size?: number }>): unknown {
  return {
    tag_name: remoteTag,
    html_url: 'https://github.com/' + LAUNCHER_RELEASE_REPOSITORY + '/releases/tag/' + remoteTag,
    assets: assets.map(asset => ({
      name: asset.name,
      browser_download_url: 'https://github.com/' + LAUNCHER_RELEASE_REPOSITORY + '/releases/download/' + remoteTag + '/' + asset.name,
      size: asset.size ?? 9,
    })),
  }
}

/** 构造 /releases/latest 的响应；默认只发 Setup（这条产品线唯一的产物）。 */
function releaseBody(remoteTag = 'v0.1.10', assetName = SETUP_KEWU, assetSize = 9): unknown {
  if (!assetName) {
    return { tag_name: remoteTag, html_url: 'https://github.com/' + LAUNCHER_RELEASE_REPOSITORY + '/releases/tag/' + remoteTag, assets: [] }
  }
  return assetsBody(remoteTag, [{ name: assetName, size: assetSize }])
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
 * 下载目录里先放一份与资产同大小的文件，download() 会走「已存在同大小」分支，不碰网络。
 */
async function readyUpdater(overrides: Partial<UpdaterOptions> = {}): Promise<Harness> {
  const userDataPath = overrides.userDataPath ?? tempUserData()
  const updateRoot = path.join(userDataPath, 'launcher-update')
  await mkdir(updateRoot, { recursive: true })
  await writeFile(path.join(updateRoot, SETUP_KEWU), new Uint8Array(9))
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
    githubFetch: latestFetch(assetsBody('v1.1.0', [{ name: SETUP_KEWU }])),
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
      githubFetch: chunkedAssetFetch(3, 9),
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

  it('已存在同大小的安装包时不重新下载（幂等）', async () => {
    const { updateRoot } = await readyUpdater()
    const saved = await readFile(path.join(updateRoot, SETUP_KEWU))
    expect(saved[0]).toBe(0x00)
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
      userDataPath: tempUserData(),
      getExecPath: () => INSTALLED_EXEC,
      githubFetch: lying,
      emitProgress: () => undefined,
    })
    await updater.check()
    const status = await updater.download()
    expect(status.state).toBe('error')
    expect(status.message).toContain('下载内容不完整')
  })
})

describe('apply（安装版：一次性助手覆盖安装）', () => {
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

  it('先停整合包，再写 cmd+vbs、以 wscript 隐藏拉起并退出应用', async () => {
    delete process.env.PORTABLE_EXECUTABLE_FILE
    const { updater, updateRoot, calls, spawned, exitCodes } = await readyUpdater()
    await updater.apply()

    // 顺序：先停整合包，再拉起助手。
    expect(calls).toEqual(['stop', 'spawn'])
    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toBe('wscript.exe')
    const launcherPath = spawned[0].args[0]
    expect(launcherPath).toContain('apply-' + process.pid + '.vbs')
    expect(spawned[0].options?.windowsHide).toBe(true)
    expect(spawned[0].options?.detached).toBe(true)
    expect(exitCodes).toEqual([0])

    // vbs 只用窗口模式 0 拉起 cmd：隐藏运行，不留黑框；跑完自删。
    const launcherScript = await readFile(launcherPath, 'utf8')
    expect(launcherScript).toContain('WScript.Shell')
    expect(launcherScript).toContain(', 0, False')
    expect(launcherScript).toContain('DeleteFile WScript.ScriptFullName')
    expect(launcherScript).toContain('shell.Run """.\\apply-' + process.pid + '.cmd""", 0, False')
    const commandPath = path.join(updateRoot, 'apply-' + process.pid + '.cmd')

    // cmd：等 PID 退出 → Setup /S /D=<当前安装目录> → 只有成功才 start 新 exe。
    const command = await readFile(commandPath, 'utf8')
    expect(command).toContain('/D=' + INSTALLED_DIR)
    expect(command).toContain('"PID eq ' + process.pid + '"')
    expect(command).toContain('goto wait')
    expect(command).toContain('start "" "' + INSTALLED_EXEC + '"\r\n')
    expect(command).not.toContain('--adopt-running-packs')
    expect(command).toContain('if not "%CODE%"=="0" goto setup_failed')

    // 日志落在 <userData>/launcher-update/apply-<时间戳>.log
    const logNames = (await import('node:fs/promises').then(fs => fs.readdir(updateRoot))).filter(name => name.endsWith('.log'))
    expect(logNames).toHaveLength(1)
    expect(command).toContain(logNames[0])
  })

  it('装失败时不启动新版本（失败分支里没有 start）', async () => {
    delete process.env.PORTABLE_EXECUTABLE_FILE
    const { updater, updateRoot } = await readyUpdater()
    await updater.apply()
    const command = await readFile(path.join(updateRoot, 'apply-' + process.pid + '.cmd'), 'utf8')
    const label = '\r\n:setup_failed\r\n'
    const endLabel = '\r\n:done\r\n'
    const failedBranch = command.slice(command.indexOf(label), command.indexOf(endLabel))
    expect(failedBranch).toContain(':setup_failed')
    expect(failedBranch).not.toContain('start ""')
    expect(failedBranch).toContain('setup failed with exit code %CODE%')
  })

  it('preserves live sessions through the CLI flow and writes the adoption relaunch command', async () => {
    const dataDir = 'D:\\Custom data & 10% !'
    const prepared: boolean[] = []
    const { updater, updateRoot, calls, exitCodes } = await readyUpdater({
      preserveRunningPacks: true,
      prepareForRelaunch: signal => { prepared.push(signal.aborted) },
      relaunchDataDir: dataDir,
    })
    const forbidden: string[] = []
    const forbiddenCall = (name: string) => () => {
      forbidden.push(name)
      throw new Error(name)
    }
    const flow = createUpdateFlow({
      preserveRunningPacks: true,
      updater,
      settings: { read: forbiddenCall('settings') },
      listRunningPacks: forbiddenCall('list'),
      countRunningSessions: forbiddenCall('probe'),
      saveResume: forbiddenCall('save'),
      clearResume: forbiddenCall('clear'),
      wait: forbiddenCall('wait'),
    })
    expect((await updater.check()).state).toBe('downloaded')
    await flow.start()
    await flow.settled()
    expect(forbidden).toEqual([])
    expect(flow.status()).toMatchObject({ phase: 'applying', busy: [], resumePacks: [] })
    expect(prepared).toEqual([false])
    expect(calls).toEqual(['spawn'])
    expect(exitCodes).toEqual([0])
    const command = await readFile(path.join(updateRoot, 'apply-' + process.pid + '.cmd'), 'utf8')
    const restart = 'start "" "' + INSTALLED_EXEC + '" --adopt-running-packs --data-dir "D:\\Custom data & 10%% !"'
    expect(command).toContain(restart)
    expect(command.indexOf('if not "%CODE%"=="0" goto setup_failed')).toBeLessThan(command.indexOf(restart))
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
        queueMicrotask(() => child.emit('error', new Error('wscript missing')))
        return child
      }) as never,
    })
    await expect(failing.updater.apply()).rejects.toThrow('wscript missing')
    expect(failing.exitCodes).toEqual([])
    expect(rollback).toEqual(['rollback'])
    expect((await failing.updater.check()).state).toBe('downloaded')
  })

  it('awaits graceful exit after helper spawn and keeps a failed exit committed', async () => {
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
