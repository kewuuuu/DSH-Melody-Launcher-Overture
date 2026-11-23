// 升级助手（纯函数）：安装版自更新要交给一个「活得比启动器久」的进程去装。
// 这里只拼文本：一次性 cmd、隐藏启动它的 vbs、日志路径、重启命令。不碰进程也不碰文件，
// 测试断言生成结果就够了；真正的 spawn 在 launcher-update.ts 里做。
//
// 为什么不能让启动器自己装：
//   · 安装器要覆盖安装目录里的 exe，启动器还活着就装 = 文件被占用，可能装一半失败；
//   · 不传 /D= 时 NSIS 会装回它自己认定的默认目录，用户自定义的安装路径被换掉，
//     连 EXE 旁边的 launcher-storage.json（数据目录指针）也跟着丢，用户得重新指定数据目录。
//
// 生成的脚本只写 ASCII：cmd 按控制台代码页解析批处理文件，UTF-8 中文在 GBK 代码页下会变乱码，
// 而这段脚本是隐藏运行的，乱码日志等于没有日志。中文文案留在 TS 层的状态与错误信息里。

import path from 'node:path'

/** 日志文件名前缀：<userData>/launcher-update/apply-<时间戳>.log。 */
export const APPLY_LOG_PREFIX = 'apply-'
/** 等旧进程退出的上限（秒）：等不到就放弃安装，绝不带着文件占用去装。 */
export const APPLY_WAIT_TIMEOUT_SECONDS = 60
/** 轮询旧进程的间隔（秒）。 */
export const APPLY_WAIT_POLL_SECONDS = 1

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function cmdQuoted(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error('路径含有无法安全传给更新助手的字符。')
  return '"' + value.replaceAll('%', '%%') + '"'
}

/** apply-20261115-231019.log：Windows 文件名不能带冒号，时间戳压成日期-时分秒。 */
export function buildApplyLogName(date: Date = new Date()): string {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
    + `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  return `${APPLY_LOG_PREFIX}${stamp}.log`
}

/** 日志落在启动器自己的下载缓存目录里：出问题时用户只需要看这一个文件夹。 */
export function buildApplyLogPath(updateRoot: string, date: Date = new Date()): string {
  return path.join(updateRoot, buildApplyLogName(date))
}

/** 一次性批处理：apply-<pid>.cmd。 */
export function buildApplyCommandPath(updateRoot: string, pid: number): string {
  return path.join(updateRoot, `apply-${Math.trunc(pid)}.cmd`)
}

/** 隐藏启动批处理的 vbs：apply-<pid>.vbs（跑完自删）。 */
export function buildApplyLauncherPath(updateRoot: string, pid: number): string {
  return path.join(updateRoot, `apply-${Math.trunc(pid)}.vbs`)
}

/** 安装目录 = 当前 exe 所在目录。按 win32 口径解析：下游是 Windows 批处理。 */
export function installDirFromExecPath(execPath: string): string {
  return path.win32.dirname(execPath.trim())
}

/** 安装成功后重新拉起启动器的那一行。 */
export const ADOPT_RUNNING_PACKS_FLAG = '--adopt-running-packs'

export function buildRestartCommand(exePath: string, adoptRunningPacks = false, dataDir?: string): string {
  const adopt = adoptRunningPacks ? ' ' + ADOPT_RUNNING_PACKS_FLAG : ''
  const override = dataDir ? ' --data-dir ' + cmdQuoted(dataDir.replace(/\\+$/, tail => tail + tail)) : ''
  return `start "" ${cmdQuoted(exePath)}${adopt}${override}`
}

/** 安装目录里会让批处理命令行跑偏的字符：它们没有可靠的转义写法，只能拒绝。 */
const UNSAFE_INSTALL_DIR_CHARS = ['&', '|', '<', '>', '^', '%', '"']

/**
 * NSIS 的 /D=<目录>：官方要求它必须是命令行最后一个参数，且即使路径含空格也不能带引号
 * （见 NSIS 手册 "must not contain any quotes, even if the path contains spaces"）。
 * 所以这里不加引号，改为把含有批处理元字符的目录挡在外面：宁可让用户手动跑安装包，
 * 也不能让 /D= 被拆成半截路径——那等于又换了一次安装目录。
 */
export function buildInstallDirArgument(installDir: string): string {
  const value = installDir.trim()
  if (!value) throw new Error('找不到当前安装目录，已中止更新。')
  if (UNSAFE_INSTALL_DIR_CHARS.some(ch => value.includes(ch))) {
    throw new Error('安装目录含有无法安全传给安装程序的字符（& | < > ^ % 或引号），请手动运行下载好的安装包。')
  }
  return `/D=${value}`
}

export interface ApplyCommandInput {
  /** 正在运行的启动器进程号：脚本轮询等它退出。 */
  pid: number
  /** 下载好的 Setup 全路径。 */
  setupPath: string
  /** 当前安装目录：/D= 用它，升级不再换目录。 */
  installDir: string
  /** 装成功后要拉起的 exe（<安装目录>/<当前 exe 名>）。 */
  exePath: string
  /** 全程日志文件；脚本只往里追加 ASCII 行。 */
  logPath: string
  adoptRunningPacks?: boolean
  relaunchDataDir?: string
  /** 等待上限（秒），缺省 APPLY_WAIT_TIMEOUT_SECONDS。 */
  waitTimeoutSeconds?: number
  /** 轮询间隔（秒），缺省 APPLY_WAIT_POLL_SECONDS。 */
  pollSeconds?: number
}

/**
 * 生成一次性批处理文本（CRLF：cmd 对只有 LF 的批处理会读错行）。
 * 顺序是固定的：轮询等 PID 退出 → `Setup /S /D=<安装目录>` → 只有退出码 0 才 start 新 exe。
 */
export function buildApplyCommand(input: ApplyCommandInput): string {
  const pid = Math.trunc(input.pid)
  const waitTimeoutSeconds =
    typeof input.waitTimeoutSeconds === 'number' && input.waitTimeoutSeconds >= 1
      ? Math.trunc(input.waitTimeoutSeconds)
      : APPLY_WAIT_TIMEOUT_SECONDS
  const pollSeconds =
    typeof input.pollSeconds === 'number' && input.pollSeconds >= 1
      ? Math.trunc(input.pollSeconds)
      : APPLY_WAIT_POLL_SECONDS
  const tries = Math.max(1, Math.ceil(waitTimeoutSeconds / pollSeconds))
  // ping -n N 的间隔是 N-1 秒。不用 timeout.exe：它要读控制台输入，隐藏进程里会直接失败。
  const pingCount = pollSeconds + 1
  const setup = cmdQuoted(input.setupPath)
  const installDirArg = buildInstallDirArgument(input.installDir)
  return [
    '@echo off',
    'rem DSH Launcher apply helper. Generated per run and deleted when finished.',
    'rem ASCII only: cmd decodes batch files with the console code page.',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "ERRORLEVEL="',
    `set ${cmdQuoted('LOG=' + input.logPath)}`,
    'call :log "=== apply start: %DATE% %TIME% ==="',
    'set "CODE=1"',
    `call :log "waiting for launcher pid ${pid} to exit (up to ${waitTimeoutSeconds}s)"`,
    'set "TRIES=0"',
    ':wait',
    `%SystemRoot%\\System32\\tasklist.exe /nh /fi "PID eq ${pid}" | %SystemRoot%\\System32\\find.exe "${pid}" >nul`,
    'if errorlevel 1 goto launcher_gone',
    'set /a TRIES+=1',
    `if %TRIES% GEQ ${tries} goto wait_timeout`,
    `%SystemRoot%\\System32\\ping.exe -n ${pingCount} 127.0.0.1 >nul`,
    'goto wait',
    ':wait_timeout',
    `call :log "launcher pid ${pid} is still running after ${waitTimeoutSeconds}s; setup was not run"`,
    'call :log "=== apply aborted: %DATE% %TIME% ==="',
    'goto done',
    ':launcher_gone',
    'call :log "launcher exited; running setup silently"',
    `${setup} /S ${installDirArg}`,
    'set "CODE=%ERRORLEVEL%"',
    'if not "%CODE%"=="0" goto setup_failed',
    'call :log "setup finished with exit code 0; starting the new version"',
    buildRestartCommand(input.exePath, input.adoptRunningPacks, input.relaunchDataDir),
    'set "CODE=%ERRORLEVEL%"',
    'if not "%CODE%"=="0" goto restart_failed',
    'call :log "=== apply done: %DATE% %TIME% ==="',
    'goto done',
    ':setup_failed',
    'call :log "setup failed with exit code %CODE%; the new version was not started"',
    'call :log "the installer is kept for a manual retry"',
    'call :log "=== apply failed: %DATE% %TIME% ==="',
    'goto done',
    ':restart_failed',
    'call :log "setup succeeded but launcher restart failed with exit code %CODE%"',
    ':done',
    'del "%~f0" & exit /b %CODE%',
    ':log',
    '>>"%LOG%" echo [apply] %~1',
    'goto :eof',
    '',
  ].join('\r\n')
}

/**
 * 隐藏启动批处理的 vbs。cmd 是控制台程序，detached spawn 会给它新建一个可见的黑色窗口，
 * 借 wscript（GUI 子系统）以窗口模式 0 拉起就看不见；vbs 自己跑完即删，目录不留垃圾。
 */
export function buildHiddenLauncherScript(commandPath: string): string {
  // 三引号是 VBScript 里「字符串内容带一个引号」的写法："""C:\x.cmd""" 的实参就是 "C:\x.cmd"。
  const quoted = commandPath.split('"').join('')
  return [
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run """${quoted}""", 0, False`,
    'CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName',
    '',
  ].join('\r\n')
}
