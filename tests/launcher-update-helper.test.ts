import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APPLY_WAIT_POLL_SECONDS,
  APPLY_WAIT_TIMEOUT_SECONDS,
  buildApplyCommand,
  buildApplyCommandPath,
  buildApplyLauncherPath,
  buildApplyLogName,
  buildApplyLogPath,
  buildHiddenLauncherScript,
  buildInstallDirArgument,
  buildRestartCommand,
  installDirFromExecPath,
} from '../electron/launcher-update-helper'
import type { ApplyCommandInput } from '../electron/launcher-update-helper'

const INSTALL_DIR = 'C:\\Program Files\\DSH-launcher-KEWU'
const EXE_PATH = INSTALL_DIR + '\\DSH-launcher-KEWU.exe'
const UPDATE_ROOT = 'C:\\Users\\kewu\\AppData\\Roaming\\DSH-launcher-KEWU\\launcher-update'
const SETUP_PATH = UPDATE_ROOT + '\\DSH-launcher-KEWU-Setup-1.1.0.exe'
const LOG_PATH = UPDATE_ROOT + '\\apply-20261115-231019.log'

const BASE: ApplyCommandInput = {
  pid: 4321,
  setupPath: SETUP_PATH,
  installDir: INSTALL_DIR,
  exePath: EXE_PATH,
  logPath: LOG_PATH,
}

/** 取命令行里 /S /D=… 那一行：升级装到哪全看它。 */
function setupLine(command: string): string {
  return command.split('\r\n').find(line => line.includes(' /S /D=')) ?? ''
}

/** 取 :label 与下一个 :label 之间的分支，用来断言「失败分支里做了什么」。 */
function branch(command: string, from: string, to: string): string {
  const lines = command.split('\r\n')
  const start = lines.indexOf(from)
  const end = lines.indexOf(to)
  return lines.slice(start, end).join('\r\n')
}

describe('installDirFromExecPath', () => {
  it('安装目录就是当前 exe 所在目录', () => {
    expect(installDirFromExecPath(EXE_PATH)).toBe(INSTALL_DIR)
    expect(installDirFromExecPath('  ' + EXE_PATH + '  ')).toBe(INSTALL_DIR)
  })
})

describe('日志路径', () => {
  it('日志名是 apply-<年月日>-<时分秒>.log', () => {
    expect(buildApplyLogName(new Date(2026, 10, 15, 23, 10, 19))).toBe('apply-20261115-231019.log')
    expect(buildApplyLogName(new Date(2026, 0, 2, 3, 4, 5))).toBe('apply-20260102-030405.log')
  })

  it('日志落在 <userData>/launcher-update/ 下', () => {
    const date = new Date(2026, 10, 15, 23, 10, 19)
    expect(buildApplyLogPath(UPDATE_ROOT, date)).toBe(path.join(UPDATE_ROOT, 'apply-20261115-231019.log'))
  })

  it('一次性脚本以 pid 命名，cmd 与 vbs 成对', () => {
    expect(buildApplyCommandPath(UPDATE_ROOT, 4321)).toBe(path.join(UPDATE_ROOT, 'apply-4321.cmd'))
    expect(buildApplyLauncherPath(UPDATE_ROOT, 4321)).toBe(path.join(UPDATE_ROOT, 'apply-4321.vbs'))
  })
})

describe('buildRestartCommand', () => {
  it('装完后前台拉起新版本，路径带引号以扛住空格', () => {
    expect(buildRestartCommand(EXE_PATH)).toBe('start "" "' + EXE_PATH + '"')
  })
})

describe('buildInstallDirArgument', () => {
  it('返回 /D=<安装目录>，且不带引号（NSIS 要求原样传目录）', () => {
    expect(buildInstallDirArgument(INSTALL_DIR)).toBe('/D=' + INSTALL_DIR)
    expect(buildInstallDirArgument('  ' + INSTALL_DIR + '  ')).toBe('/D=' + INSTALL_DIR)
  })

  it('目录为空时给中文错误', () => {
    expect(() => buildInstallDirArgument('   ')).toThrow('找不到当前安装目录，已中止更新。')
  })

  it('目录含批处理元字符时拒绝，并给出中文错误', () => {
    expect(() => buildInstallDirArgument('C:\\A & B')).toThrow('无法安全传给安装程序')
    expect(() => buildInstallDirArgument('C:\\100%\\DSH')).toThrow('无法安全传给安装程序')
  })
})

describe('buildApplyCommand', () => {
  it('安装那一行是「Setup /S /D=<当前安装目录>」', () => {
    const command = buildApplyCommand(BASE)
    expect(setupLine(command)).toBe('"' + SETUP_PATH + '" /S /D=' + INSTALL_DIR)
    expect(command).not.toContain('/D="')
  })

  it('安装前先轮询等旧进程 PID 退出', () => {
    const command = buildApplyCommand(BASE)
    expect(command).toContain(':wait\r\n')
    expect(command).toContain('/nh /fi "PID eq 4321"')
    expect(command).toContain('find.exe "4321"')
    expect(command).toContain('if errorlevel 1 goto launcher_gone')
    expect(command).toContain('goto wait')
    expect(command).toContain('ping.exe -n ' + (APPLY_WAIT_POLL_SECONDS + 1) + ' 127.0.0.1')
  })

  it('等不到退出就按上限放弃，不带着文件占用去装', () => {
    const command = buildApplyCommand(BASE)
    const tries = Math.ceil(APPLY_WAIT_TIMEOUT_SECONDS / APPLY_WAIT_POLL_SECONDS)
    expect(command).toContain('if %TRIES% GEQ ' + tries + ' goto wait_timeout')
    expect(branch(command, ':wait_timeout', ':launcher_gone')).toContain('setup was not run')
    expect(branch(command, ':wait_timeout', ':launcher_gone')).not.toContain('/S /D=')
  })

  it('等待上限与轮询间隔可按入参收紧', () => {
    const command = buildApplyCommand({ ...BASE, waitTimeoutSeconds: 5, pollSeconds: 2 })
    expect(command).toContain('if %TRIES% GEQ 3 goto wait_timeout')
    expect(command).toContain('ping.exe -n 3 127.0.0.1')
  })

  it('安装成功后才启动新版本，顺序在安装之后', () => {
    const command = buildApplyCommand(BASE)
    const restart = 'start "" "' + EXE_PATH + '"'
    expect(command).toContain(restart)
    expect(command.indexOf('/S /D=')).toBeLessThan(command.indexOf(restart))
    expect(branch(command, ':launcher_gone', ':setup_failed')).toContain(restart)
  })

  it('安装失败（退出码非 0）时不启动新版本，只写日志', () => {
    const command = buildApplyCommand(BASE)
    expect(command).toContain('set "CODE=%ERRORLEVEL%"')
    expect(command).toContain('if not "%CODE%"=="0" goto setup_failed')
    const failed = branch(command, ':setup_failed', ':done')
    expect(failed).not.toContain('start ""')
    expect(failed).toContain('setup failed with exit code %CODE%')
    expect(failed).toContain('the installer is kept for a manual retry')
  })

  it('全程把日志追加到同一个 apply 日志文件里', () => {
    const command = buildApplyCommand(BASE)
    expect(command).toContain('set "LOG=' + LOG_PATH + '"')
    expect(command).toContain('>>"%LOG%" echo [apply] %~1')
    expect(command).toContain('call :log "=== apply start: %DATE% %TIME% ==="')
  })

  it('脚本跑完自删，不留一次性文件', () => {
    const command = buildApplyCommand(BASE)
    expect(branch(command, ':done', ':log')).toContain('del "%~f0"')
    expect(command).toContain('exit /b 0')
  })

  it('是 CRLF 换行、且只有 ASCII（cmd 按控制台代码页解析批处理）', () => {
    const command = buildApplyCommand(BASE)
    expect(command).toContain('\r\n')
    expect(command.replace(/\r\n/g, '')).not.toContain('\n')
    expect(command).toMatch(/^[\x20-\x7E\r\n]*$/)
  })

  it('安装目录带元字符时整段脚本都生成失败（宁愿让用户手动装）', () => {
    expect(() => buildApplyCommand({ ...BASE, installDir: 'C:\\A&B' })).toThrow('无法安全传给安装程序')
  })
})

describe('buildHiddenLauncherScript', () => {
  it('用 WScript.Shell 以窗口模式 0 拉起 cmd，不出现控制台黑框', () => {
    const commandPath = buildApplyCommandPath(UPDATE_ROOT, 4321)
    const script = buildHiddenLauncherScript(commandPath)
    expect(script).toContain('Set shell = CreateObject("WScript.Shell")')
    expect(script).toContain('shell.Run """' + commandPath + '""", 0, False')
    expect(script).not.toContain('""""')
  })

  it('vbs 自己跑完即删', () => {
    const script = buildHiddenLauncherScript(buildApplyCommandPath(UPDATE_ROOT, 4321))
    expect(script).toContain('CreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName')
  })

  it('Run 的实参就是那条 cmd（三引号进出 = VBScript 里的带引号字符串）', () => {
    const commandPath = buildApplyCommandPath(UPDATE_ROOT, 4321)
    const script = buildHiddenLauncherScript(commandPath)
    const line = script.split('\r\n').find(item => item.startsWith('shell.Run ')) ?? ''
    expect(line).toBe('shell.Run """' + commandPath + '""", 0, False')
  })
})
