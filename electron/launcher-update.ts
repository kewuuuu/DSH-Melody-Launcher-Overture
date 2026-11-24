import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { LAUNCHER_RELEASE_REPOSITORY } from '../src/constants'
import type { LauncherUpdateProgress, LauncherUpdateStatus } from '../src/types'
import { compareVersions, normalizeVersion } from './dsh-update'
import { downloadReleaseAsset } from './release-download'
import {
  buildApplyCommand,
  buildApplyCommandPath,
  buildApplyLauncherPath,
  buildApplyLogPath,
  buildHiddenLauncherScript,
  installDirFromExecPath,
} from './launcher-update-helper'

/**
 * 启动器自更新：启动时检测 GitHub Release 是否有新版本 → 自动后台下载 Setup（带进度）
 * → 退出前交给一次性助手：等本进程退出，再 `Setup /S /D=<当前安装目录>` 静默覆盖安装，
 * 只有装成功才重新拉起启动器。便携版已停发，只发安装版。
 * 检测逻辑与 dsh-update 对齐：任何网络/解析失败都收敛成 error 状态，绝不阻塞启动。
 */

const GITHUB_API_ROOT = 'https://api.github.com'
/** api.github.com 的镜像前缀（按顺序尝试）。直连被匿名限流（403）或连接失败时，
 * 镜像用自己的出口绕过官方限额，读取同一个 Release 元数据。 */
const GITHUB_API_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/'] as const
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'DSH-Launcher',
  'X-GitHub-Api-Version': '2022-11-28',
}
/** 新安装包体积上限（Setup 约 91MB，放宽到 512MiB 防极端情况）。 */
const MAX_LAUNCHER_BYTES = 512 * 1024 * 1024
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000

/** 停整合包最多等这么久：等不到就中止更新——覆盖安装不能撞上正在运行的文件。 */
export const APPLY_STOP_PACKS_TIMEOUT_MS = 20_000

export const APPLY_STOP_PACKS_TIMEOUT_MESSAGE = '还有整合包在运行，已中止更新'

interface GitHubReleaseAsset {
  name?: unknown
  browser_download_url?: unknown
  size?: unknown
  digest?: unknown
}

interface GitHubLatestRelease {
  tag_name?: unknown
  html_url?: unknown
  /** Release 正文（发布时自动生成的更新说明）。 */
  body?: unknown
  assets?: unknown
}

export interface ResolvedLauncherAsset {
  name: string
  size: number
  url: string
  digest?: string
}

/** NSIS 安装包的文件名标记：便携版停发后，这是唯一还产的资产。 */
const SETUP_ASSET_MARKER = 'setup'

/** 文件名里最后一个版本号（`DSH-launcher-KEWU-Setup-1.1.0.exe` → `1.1.0`）；没有则 null。 */
export function versionFromAssetName(name: string): string | null {
  const versions = name.toLowerCase().match(/\d+(?:\.\d+)+/g)
  return versions && versions.length > 0 ? versions[versions.length - 1] : null
}

function collectAssets(release: GitHubLatestRelease, marker: string): ResolvedLauncherAsset[] {
  const assets = Array.isArray(release.assets) ? release.assets : []
  const collected: ResolvedLauncherAsset[] = []
  for (const entry of assets) {
    const candidate = entry as GitHubReleaseAsset | null
    if (!candidate || typeof candidate.name !== 'string' || typeof candidate.browser_download_url !== 'string') continue
    const lower = candidate.name.toLowerCase()
    if (!lower.endsWith('.exe') || !lower.includes(marker) || /[<>:"/\\|?*]/.test(candidate.name)) continue
    collected.push({
      name: candidate.name,
      size: Number.isFinite(candidate.size) ? Number(candidate.size) : 0,
      url: candidate.browser_download_url,
      ...(candidate.digest == null ? {} : { digest: typeof candidate.digest === 'string' ? candidate.digest.toLowerCase() : '' }),
    })
  }
  return collected
}

/** 多个候选时取文件名里版本号最大的那个；没有版本号可比的保留先出现的。 */
function pickNewestAsset(candidates: readonly ResolvedLauncherAsset[]): ResolvedLauncherAsset | null {
  let best: ResolvedLauncherAsset | null = null
  for (const candidate of candidates) {
    if (!best) {
      best = candidate
      continue
    }
    const bestVersion = versionFromAssetName(best.name)
    const candidateVersion = versionFromAssetName(candidate.name)
    if (!bestVersion) {
      if (candidateVersion) best = candidate
      continue
    }
    if (!candidateVersion) continue
    // compareVersions(local, remote) > 0 读作「remote 更新」。
    if (compareVersions(bestVersion, candidateVersion) > 0) best = candidate
  }
  return best
}

/** 安装版的 Setup 资产；Release 里没有可用的 Setup 时返回 null，由调用方给出中文错误。 */
export function resolveSetupAsset(release: GitHubLatestRelease): ResolvedLauncherAsset | null {
  return pickNewestAsset(collectAssets(release, SETUP_ASSET_MARKER))
}

async function fetchLatestRelease(fetchImpl: typeof fetch): Promise<{
  tag: string
  htmlUrl: string
  notes: string | null
  /** 本次要运行的 Setup；Release 没发安装版时是 null。 */
  setup: ResolvedLauncherAsset | null
}> {
  const endpoint = `${GITHUB_API_ROOT}/repos/${LAUNCHER_RELEASE_REPOSITORY}/releases/latest`
  const candidates = [endpoint, ...GITHUB_API_MIRRORS.map(prefix => `${prefix}${endpoint}`)]
  const failures: string[] = []
  for (const url of candidates) {
    try {
      const response = await fetchImpl(url, { headers: GITHUB_HEADERS })
      if (!response.ok) {
        failures.push(url === endpoint
          ? response.status === 403 ? 'GitHub 请求额度暂时用尽。' : `GitHub 返回 ${response.status}。`
          : `镜像返回 ${response.status}。`)
        continue
      }
      const release = await response.json() as GitHubLatestRelease
      if (typeof release.tag_name !== 'string' || !release.tag_name) throw new Error('Release 返回异常（缺少版本号）。')
      const setup = resolveSetupAsset(release)
      // 便携版已停发：Release 里没有 Setup 就等于没有可用的安装包。
      if (!setup) throw new Error('新版本没有可下载的安装包。')
      const rawNotes = typeof release.body === 'string' ? release.body.trim() : ''
      return {
        tag: typeof release.tag_name === 'string' ? release.tag_name : '',
        htmlUrl: typeof release.html_url === 'string' ? release.html_url : '',
        // 正文截到 4000 字符：详情弹窗展示用，超长部分去 Release 页看。
        notes: rawNotes ? rawNotes.slice(0, 4000) : null,
        setup,
      }
    } catch (error) {
      failures.push(url === endpoint ? errorMessage(error) : '镜像不可用。')
    }
  }
  throw new Error(failures.join('；'))
}

function checkedAt(): string {
  return new Date().toISOString()
}

/** 网络层失败要翻成中文：这里拼的是 failures.join('；')，直接进用户可见的更新失败文案。 */
const NETWORK_ERROR_TEXT: Record<string, string> = {
  ECONNREFUSED: '连不上 GitHub（连接被拒绝，通常是代理没开）。',
  ETIMEDOUT: '连 GitHub 超时。',
  ECONNRESET: '连 GitHub 的连接被重置。',
  ENOTFOUND: '解析不到 GitHub 域名（离线或 DNS 被劫持）。',
  EAI_AGAIN: 'DNS 暂时解析失败。',
}

function errorMessage(error: unknown): string {
  // fetch 失败时真实错误码在 cause 上，error.message 只有没信息量的 "fetch failed"。
  const code = (error as { cause?: { code?: unknown } })?.cause?.code ?? (error as { code?: unknown })?.code
  if (typeof code === 'string' && NETWORK_ERROR_TEXT[code]) return NETWORK_ERROR_TEXT[code]
  return error instanceof Error ? error.message : String(error)
}

interface PendingUpdate {
  tag: string
  htmlUrl: string
  /** 本次要运行的 Setup：安装版自更新的唯一产物。 */
  setup: ResolvedLauncherAsset | null
}

interface UpdateSnapshot {
  status: LauncherUpdateStatus
  pending: PendingUpdate | null
}

/** 一次 fetch 完成「版本比较 + 状态构造」，供纯函数与服务共用。 */
async function readUpdate(getVersion: () => string, fetchImpl: typeof fetch): Promise<UpdateSnapshot> {
  const localVersion = normalizeVersion(getVersion())
  try {
    const release = await fetchLatestRelease(fetchImpl)
    const remoteVersion = normalizeVersion(release.tag)
    if (compareVersions(localVersion, remoteVersion) > 0) {
      return {
        status: {
          state: 'update-available',
          localVersion,
          remoteVersion,
          releaseUrl: release.htmlUrl || null,
          releaseNotes: release.notes,
          assetName: release.setup?.name ?? null,
          assetSize: release.setup?.size || null,
          checkedAt: checkedAt(),
          message: `发现新版本 ${remoteVersion}。`,
        },
        pending: { tag: release.tag, htmlUrl: release.htmlUrl, setup: release.setup },
      }
    }
    return {
      status: {
        state: 'up-to-date',
        localVersion,
        remoteVersion,
        releaseUrl: release.htmlUrl || null,
        assetName: null,
        assetSize: null,
        checkedAt: checkedAt(),
        message: '当前启动器已是最新版本。',
      },
      pending: null,
    }
  } catch (error) {
    return {
      status: {
        state: 'error',
        localVersion,
        remoteVersion: null,
        releaseUrl: null,
        assetName: null,
        assetSize: null,
        checkedAt: checkedAt(),
        message: `暂时无法检查更新：${errorMessage(error)}`,
      },
      pending: null,
    }
  }
}

/** 纯检测：比较本地版本与最新 Release，返回状态。网络失败返回 error 状态。 */
export async function checkLauncherUpdate(
  getVersion: () => string,
  fetchImpl: typeof fetch,
): Promise<LauncherUpdateStatus> {
  const snapshot = await readUpdate(getVersion, fetchImpl)
  return snapshot.status
}

export type LauncherInstallMode = 'installed' | 'dev'

/**
 * 老便携包识别：便携版已停发，但机器上可能还跑着历史便携包。
 * 它没有安装目录、也没有 Setup 覆盖安装的前提，只能拒绝并让用户改用安装版。
 */
export function isPortableRuntime(
  execPath: string,
  portableExecutableFile: string | null | undefined = process.env.PORTABLE_EXECUTABLE_FILE,
): boolean {
  if (typeof portableExecutableFile === 'string' && portableExecutableFile.trim()) return true
  return path.basename(execPath).toLowerCase().includes('-portable')
}

/**
 * 当前进程的安装形态：
 * - installed：NSIS 安装版，唯一支持自更新的形态——Setup 覆盖安装回当前安装目录；
 * - dev：直接跑 electron / node（execPath 落在 node_modules 里），没有可覆盖安装的产物；
 * - 历史便携包（PORTABLE_EXECUTABLE_FILE 或 exe 名带 Portable）也归成 dev：便携版已停发。
 */
export function detectInstallMode(
  execPath: string,
  portableExecutableFile: string | null | undefined = process.env.PORTABLE_EXECUTABLE_FILE,
): LauncherInstallMode {
  if (isPortableRuntime(execPath, portableExecutableFile)) return 'dev'
  if (execPath.replace(/\\/g, '/').toLowerCase().includes('node_modules')) return 'dev'
  return 'installed'
}

export interface LauncherUpdaterOptions {
  /** 本地启动器版本。 */
  getVersion: () => string
  /** userData 目录：下载缓存、升级助手脚本与日志都在这里的 launcher-update/。 */
  userDataPath: string
  /** 当前运行的可执行文件路径；测试注入。缺省 process.execPath。 */
  getExecPath?: () => string
  /** 停掉所有正在运行的整合包（父级主进程接 packControl.shutdown）：装之前必须停干净。 */
  stopPacks?: () => Promise<void> | void
  /** 停整合包的超时，缺省 APPLY_STOP_PACKS_TIMEOUT_MS。 */
  stopPacksTimeoutMs?: number
  preserveRunningPacks?: boolean
  /** 退出前由主进程准备接管；失败须自行撤销未完成的准备，可返回后续交接失败时的撤销函数。 */
  prepareForRelaunch?: (signal: AbortSignal) => RelaunchRollback | void | Promise<RelaunchRollback | void>
  /** 仅在本次启动有明确的数据目录参数时提供已解析的绝对路径。 */
  relaunchDataDir?: string
  /** 带 GitHub 鉴权的 fetch；缺省用全局 fetch。 */
  githubFetch?: typeof fetch
  downloadIdleTimeoutMs?: number
  /** 进度事件（下载百分比 / 应用阶段）。 */
  emitProgress: (progress: LauncherUpdateProgress) => void
  /** 测试注入的 spawn。缺省 node:child_process spawn。 */
  spawnProcess?: typeof nodeSpawn
  /** 助手启动后退出旧进程；主进程可注入异步清理及正常退出。缺省 process.exit。 */
  exitProcess?: (code?: number) => void | Promise<void>
}

export class LauncherRelaunchExitError extends Error {}

class InstallerIntegrityError extends Error {}

type RelaunchRollback = () => void | Promise<void>

export interface LauncherApplyOptions {
  signal?: AbortSignal
  /** 安装助手即将启动，此后不能取消。 */
  onCommit?: () => void
}

export interface LauncherUpdater {
  check(): Promise<LauncherUpdateStatus>
  download(): Promise<LauncherUpdateStatus>
  apply(options?: LauncherApplyOptions): Promise<void>
}

async function installerMatches(filePath: string, size: number, sha256: string): Promise<boolean> {
  try {
    const info = await lstat(filePath)
    if (!info.isFile() || info.size !== size) return false
    const hash = createHash('sha256')
    let received = 0
    for await (const chunk of createReadStream(filePath, { end: size })) {
      received += chunk.length
      hash.update(chunk)
    }
    return received === size && hash.digest('hex') === sha256
  } catch {
    return false
  }
}

export function createLauncherUpdater(options: LauncherUpdaterOptions): LauncherUpdater {
  const doFetch = options.githubFetch ?? fetch
  const updateRoot = path.join(options.userDataPath, 'launcher-update')
  /** 用户手里那个 exe：安装版就是 process.execPath（便携版已停发，不再取 PORTABLE_EXECUTABLE_FILE）。 */
  const execPathOf = (): string => (options.getExecPath ?? (() => process.execPath))()
  const stopPacksTimeoutMs =
    typeof options.stopPacksTimeoutMs === 'number' && options.stopPacksTimeoutMs > 0
      ? options.stopPacksTimeoutMs
      : APPLY_STOP_PACKS_TIMEOUT_MS
  let status: LauncherUpdateStatus = {
    state: 'up-to-date',
    localVersion: null,
    remoteVersion: null,
    releaseUrl: null,
    assetName: null,
    assetSize: null,
    checkedAt: null,
    message: '',
  }
  let pending: PendingUpdate | null = null
  let verifiedSha256: string | null = null
  let downloading: Promise<LauncherUpdateStatus> | null = null

  let checking: Promise<LauncherUpdateStatus> | null = null
  const isApplying = (): boolean => status.state === 'applying'

  async function check(): Promise<LauncherUpdateStatus> {
    if (isApplying() || downloading) return status
    if (!checking) {
      checking = readUpdate(options.getVersion, doFetch).then(snapshot => {
        if (isApplying() || downloading) return status
        const nextSetup = snapshot.pending?.setup
        const previousSetup = pending?.setup
        const sameDownload = status.state === 'downloaded' && nextSetup && previousSetup
          && nextSetup.url === previousSetup.url && nextSetup.name === previousSetup.name
          && nextSetup.size === previousSetup.size && nextSetup.digest === previousSetup.digest
          && snapshot.status.remoteVersion === status.remoteVersion
        pending = snapshot.pending
        if (!sameDownload) status = snapshot.status
        return status
      }).finally(() => { checking = null })
    }
    return checking
  }

  async function download(): Promise<LauncherUpdateStatus> {
    if (downloading) return downloading
    if ((status.state !== 'update-available' && status.state !== 'error') || !pending) return status
    downloading = performDownload()
    try {
      return await downloading
    } finally {
      downloading = null
    }
  }

  async function performDownload(): Promise<LauncherUpdateStatus> {
    const target = pending as PendingUpdate
    // 只发安装版：永远只下 Setup。
    const asset = target.setup
    if (!asset) {
      status = { ...status, state: 'error', message: '新版本没有可下载的安装版安装包。' }
      return status
    }
    const targetPath = path.join(updateRoot, asset.name)
    try {
      verifiedSha256 = null
      if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_LAUNCHER_BYTES) {
        throw new Error('Release 安装包大小无效。')
      }
      const expectedSha256 = asset.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1]
      if (asset.digest !== undefined && !expectedSha256) throw new Error('Release 安装包的 SHA-256 校验值无效。')
      if (expectedSha256 && await installerMatches(targetPath, asset.size, expectedSha256)) {
        verifiedSha256 = expectedSha256
        status = { ...status, state: 'downloaded', assetName: asset.name, assetSize: asset.size || null, message: '更新已就绪，可以重启应用。' }
        return status
      }
      // 旧 Release 可能没有摘要，只允许重新下载并验证大小，不能信任磁盘缓存。
      await rm(targetPath, { force: true })
      status = { ...status, state: 'downloading', assetName: asset.name, assetSize: asset.size, message: '正在下载更新…' }
      const buffer = await downloadReleaseAsset(
        asset.url,
        MAX_LAUNCHER_BYTES,
        (received, total) => {
          options.emitProgress({
            phase: 'downloading',
            percent: total ? Math.round(Math.min(1, received / total) * 100) : 0,
            downloadedBytes: received,
            totalBytes: total ?? undefined,
          })
        },
        doFetch,
        undefined,
        options.downloadIdleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS,
      )
      if (buffer.length !== asset.size) {
        throw new Error(`下载内容不完整（${buffer.length} ≠ ${asset.size} 字节）。`)
      }
      const sha256 = createHash('sha256').update(buffer).digest('hex')
      if (expectedSha256 && sha256 !== expectedSha256) throw new Error('安装包 SHA-256 校验失败。')
      await mkdir(updateRoot, { recursive: true })
      const tempPath = path.join(updateRoot, `.${randomUUID()}.tmp`)
      try {
        await writeFile(tempPath, buffer, { flag: 'wx' })
        await rename(tempPath, targetPath)
      } catch (error) {
        await rm(tempPath, { force: true })
        throw error
      }
      verifiedSha256 = sha256
      status = { ...status, state: 'downloaded', assetName: asset.name, assetSize: asset.size || null, message: '更新已就绪，可以重启应用。' }
      return status
    } catch (error) {
      status = { ...status, state: 'error', message: `更新下载失败：${errorMessage(error)}` }
      return status
    }
  }

  /**
   * 停掉正在运行的整合包：覆盖安装会写这些文件，任何一个还开着都可能让安装失败。
   * 等不到就中止本次更新——宁可这次不装，也不装一半。
   */
  async function stopRunningPacks(): Promise<void> {
    if (!options.stopPacks) return
    const doStop = Promise.resolve(options.stopPacks())
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(APPLY_STOP_PACKS_TIMEOUT_MESSAGE)), stopPacksTimeoutMs)
      // 这个计时器不该拖着进程退出。
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      await Promise.race([doStop, timeout])
    } catch (error) {
      const text = errorMessage(error)
      throw new Error(text === APPLY_STOP_PACKS_TIMEOUT_MESSAGE ? text : `停止整合包失败，已中止更新：${text}`)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * 安装版：写一个一次性助手（cmd + vbs），由它等本进程退出后再执行
   * 《Setup /S /D=<当前安装目录>》，装成功才重新拉起启动器。
   *
   * - 必须等本进程退出：Setup 要覆盖正在运行的 exe，活着装就是文件占用。
   * - 必须带 /D=<当前安装目录>：不带的话 Setup 会装回它自己认定的默认目录，
   *   用户自定义的安装目录（连同 EXE 同级的 launcher-storage.json 数据目录指针）就丢了。
   * - 装失败不拉起 exe；保留安装包和日志，供手动恢复。
   */
  async function writeSetupHelper(target: PendingUpdate, execPath: string): Promise<string> {
    const setup = target.setup
    if (!setup) throw new Error('新版本没有可下载的安装版安装包。')
    const setupPath = path.join(updateRoot, setup.name)
    if (!verifiedSha256 || !await installerMatches(setupPath, setup.size, verifiedSha256)) {
      throw new InstallerIntegrityError('安装包校验失败，请重新下载更新后再试。')
    }
    const installDir = installDirFromExecPath(execPath)
    if (!installDir) throw new Error('找不到当前安装目录，已中止更新。')
    await mkdir(updateRoot, { recursive: true })
    const logPath = buildApplyLogPath(updateRoot)
    // 写明安装请求，便于排查助手没有启动的情况。
    await writeFile(logPath, `[apply] apply requested for ${setup.name} at ${new Date().toISOString()}\n`, { flag: 'a' })
    const commandPath = buildApplyCommandPath(updateRoot, process.pid)
    const launcherPath = buildApplyLauncherPath(updateRoot, process.pid)
    await writeFile(commandPath, buildApplyCommand({
      pid: process.pid,
      setupPath,
      installDir,
      exePath: execPath,
      logPath,
      adoptRunningPacks: options.preserveRunningPacks,
      relaunchDataDir: options.relaunchDataDir,
    }))
    await writeFile(launcherPath, buildHiddenLauncherScript('.\\' + path.basename(commandPath)))
    return launcherPath
  }

  async function startSetupHelper(launcherPath: string): Promise<void> {
    const doSpawn = options.spawnProcess ?? nodeSpawn
    try {
      const child = doSpawn('wscript.exe', [launcherPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: updateRoot,
      })
      await once(child, 'spawn')
      child.unref()
    } catch (error) {
      throw new Error(`启动安装助手失败：${errorMessage(error)}`)
    }
  }

  async function apply(applyOptions: LauncherApplyOptions = {}): Promise<void> {
    if (isApplying()) throw new Error('已有一个启动器更新正在安装。')
    if (status.state !== 'downloaded' || !pending) {
      throw new Error('没有已下载的启动器更新。')
    }
    const target = pending as PendingUpdate
    const execPath = execPathOf()
    // 便携版已停发：历史便携包没有安装目录，也没法覆盖安装，只能请用户改用安装版。
    if (isPortableRuntime(execPath)) {
      throw new Error('便携版已停发，请改用安装版。')
    }
    // 开发模式（process.execPath 指向 node_modules/electron 等）没有可覆盖安装的产物。
    if (detectInstallMode(execPath) === 'dev') {
      throw new Error('当前以开发模式运行，自动更新仅支持安装版启动器。')
    }
    const signal = applyOptions.signal ?? new AbortController().signal
    signal.throwIfAborted()
    const prepare = options.prepareForRelaunch
    if (options.preserveRunningPacks && !prepare) throw new Error('缺少整合包接管准备，已中止更新。')
    const downloaded = status
    let rollback: RelaunchRollback | void = undefined
    status = { ...status, state: 'applying', message: '正在准备安装更新，请稍候…' }
    try {
      const launcherPath = await writeSetupHelper(target, execPath)
      signal.throwIfAborted()
      if (options.preserveRunningPacks && prepare) {
        rollback = await prepare(signal)
      } else {
        await stopRunningPacks()
      }
      signal.throwIfAborted()
      options.emitProgress({ phase: 'applying', percent: 100 })
      signal.throwIfAborted()
      applyOptions.onCommit?.()
      await startSetupHelper(launcherPath)
    } catch (error) {
      let message = errorMessage(error)
      try {
        await rollback?.()
      } catch (rollbackError) {
        message += '；撤销接管准备失败：' + errorMessage(rollbackError)
        throw new Error(message, { cause: error })
      } finally {
        status = { ...downloaded, state: error instanceof InstallerIntegrityError ? 'error' : downloaded.state, message }
      }
      throw error
    }
    const doExit = options.exitProcess ?? (code => process.exit(code))
    try {
      await doExit(0)
    } catch (error) {
      const message = '安装助手已启动，但退出启动器失败：' + errorMessage(error)
      status = { ...status, message }
      throw new LauncherRelaunchExitError(message, { cause: error })
    }
  }

  return { check, download, apply }
}
