import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  buildUninstallCommand,
  buildUninstallScript,
  UNINSTALL_SCRIPT_BOM,
  UNINSTALL_SCRIPT_FILENAME,
} from '../electron/uninstall-script'
import { UNINSTALL_LOGIN_ITEM_NAME } from '../electron/uninstall-plan'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const normalize = (text: string) => text.replace(/\r\n/g, '\n')

describe('uninstall script template', () => {
  it('生成的 ps1 带 WaitPid 轮询、注册表与保留规则', () => {
    const script = buildUninstallScript({ executablePath: 'C:\\apps\\DSH Launcher.exe', dataDir: 'C:\\apps\\launcher-data' })

    expect(script).toContain('[int]$WaitPid = 0')
    expect(script).toContain('Get-Process -Id $WaitPid')
    expect(script).toContain('AddSeconds(120)')
    expect(script).toContain("[string]$ExePath = 'C:\\apps\\DSH Launcher.exe'")
    expect(script).toContain("[string]$DataDir = 'C:\\apps\\launcher-data'")
    expect(script).toContain("'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'")
    expect(script).toContain(UNINSTALL_LOGIN_ITEM_NAME)
    expect(script).toContain('[switch]$DeleteData')
    expect(script).toContain('[switch]$DryRun')
    expect(script).toContain('[switch]$Yes')
    expect(script).toContain('这是旧版启动器数据，按规则保留')
    expect(script).toContain('DSH 的家目录')
    expect(script).toContain("'3L*'")
  })

  it('没有危险的删除动作：Remove-Item 不带通配符，也没有 del/rd 直接删', () => {
    const script = buildUninstallScript({ executablePath: '', dataDir: '' })
    const lines = script.split('\n')

    const wildcardDeletes = lines.filter(line => /Remove-Item\b/.test(line) && line.includes('*'))
    expect(wildcardDeletes).toEqual([])
    const shellDeletes = lines.filter(line => /^\s*(del|rd|rmdir)\s/i.test(line))
    expect(shellDeletes).toEqual([])
    // 递归删除只允许出现在受 Assert-SafeTarget 保护的 Remove-Target 里
    const recursiveDeletes = lines.filter(line => line.includes('Remove-Item') && line.includes('-Recurse'))
    for (const line of recursiveDeletes) expect(line).toContain('Remove-Item -LiteralPath $')
    expect(script).toContain('Assert-SafeTarget $target')
    // 保留项在安装目录里时绝不能整体删目录（否则会把 launcher-data 一起删掉）
    expect(script).toContain('foreach ($keptTarget in $keepSteps)')
  })

  it('没有 -ExePath 时打印中文用法并退出 1，不留任何删除动作', () => {
    const script = buildUninstallScript({ executablePath: '', dataDir: '' })
    expect(script).toContain("if (-not $ExePath) {")
    expect(script).toContain('Write-Usage')
    const usage = script.slice(script.indexOf('function Write-Usage'))
    expect(usage).toContain('用法：')
    expect(usage).toContain('退出码：0 = 完成或预览成功')
    const guard = script.slice(script.indexOf('if (-not $ExePath) {'))
    expect(guard.indexOf('exit 1')).toBeLessThan(guard.indexOf('$deleteSteps'))
  })

  it('仓库里的 tools/uninstall-kewu.ps1 与模板逐字一致（UTF-8 带 BOM）', async () => {
    const file = path.resolve('tools/uninstall-kewu.ps1')
    const bytes = await readFile(file)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = bytes.subarray(3).toString('utf8')
    expect(text.charCodeAt(0)).not.toBe(0xfeff)
    expect(normalize(text)).toBe(normalize(buildUninstallScript({ executablePath: '', dataDir: '' })))
  })

  it('导出的 ps1 带 BOM、cmd 只负责拉起 ps1', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'uninstall-script-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const scriptText = buildUninstallScript({ executablePath: 'D:\\a b\\DSH Launcher.exe', dataDir: 'D:\\a b\\launcher-data' })
    const scriptFile = path.join(root, 'uninstall-kewu.ps1')
    await writeFile(scriptFile, UNINSTALL_SCRIPT_BOM + scriptText, 'utf8')
    const written = await readFile(scriptFile, 'utf8')
    expect(written.charCodeAt(0)).toBe(0xfeff)
    expect(written.slice(1)).toBe(scriptText)

    const command = buildUninstallCommand({
      executablePath: 'D:\\a b\\DSH Launcher.exe',
      dataDir: 'D:\\a b\\launcher-data',
      waitPid: 4321,
      deleteData: true,
      logPath: 'C:\\temp\\uninstall-log.txt',
    })
    expect(command.split('\r\n')[0]).toBe('@echo off')
    expect(command).toContain(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0' + UNINSTALL_SCRIPT_FILENAME + '"',
    )
    expect(command).toContain('-ExePath "D:\\a b\\DSH Launcher.exe"')
    expect(command).toContain('-DataDir "D:\\a b\\launcher-data"')
    expect(command).toContain('-WaitPid 4321')
    expect(command).toContain('-LogPath "C:\\temp\\uninstall-log.txt"')
    expect(command).toContain('-Yes')

    const keepData = buildUninstallCommand({ executablePath: 'D:\\x.exe', dataDir: 'D:\\launcher-data' })
    expect(keepData).not.toContain('-DeleteData')
    expect(keepData).not.toContain('-WaitPid')
  })

  it('路径里的单引号按 PowerShell 规则转义', () => {
    const script = buildUninstallScript({ executablePath: "C:\\it's\\DSH.exe", dataDir: '' })
    expect(script).toContain("[string]$ExePath = 'C:\\it''s\\DSH.exe'")
    expect(script).toContain("[string]$DataDir = ''")
  })
})
