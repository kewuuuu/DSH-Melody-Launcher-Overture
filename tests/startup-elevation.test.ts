import { EventEmitter } from 'node:events'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, mergeStoredSettings, validateSettings } from '../electron/settings'
import {
  ELEVATED_RELAUNCH_FLAG,
  buildElevatedPowerShellCommand,
  buildElevatedRelaunchArgs,
  relaunchElevated,
  shouldRelaunchElevated,
} from '../electron/startup-elevation'
import type { AppSettings } from '../src/types'

describe('shouldRelaunchElevated', () => {
  it('设置关着就不重启，即使没提权、argv 里也没有标记', () => {
    expect(shouldRelaunchElevated({ launchElevated: false, argv: [], elevated: false })).toBe(false)
    expect(shouldRelaunchElevated({ launchElevated: undefined, argv: [], elevated: false })).toBe(false)
  })

  it('设置开着、未提权、且不是重启出来的那一次，才重启', () => {
    expect(shouldRelaunchElevated({ launchElevated: true, argv: ['--background'], elevated: false })).toBe(true)
  })

  it('已经提权时不重启', () => {
    expect(shouldRelaunchElevated({ launchElevated: true, argv: [], elevated: true })).toBe(false)
  })

  it('argv 里已有重启标记时不重启（防止无限重启）', () => {
    expect(shouldRelaunchElevated({ launchElevated: true, argv: [ELEVATED_RELAUNCH_FLAG], elevated: false })).toBe(false)
    expect(shouldRelaunchElevated({ launchElevated: true, argv: ['--ELEVATED-RELAUNCH'], elevated: false })).toBe(false)
    expect(shouldRelaunchElevated({ launchElevated: true, argv: ['--elevated-relaunch=1'], elevated: false })).toBe(false)
  })
})

describe('buildElevatedRelaunchArgs', () => {
  const dataDir = 'C:/Users/zhang san/AppData/Roaming/dsh-launcher'

  it('去掉旧的标记与 --data-dir=，再追加标记和绝对路径的数据目录', () => {
    const args = buildElevatedRelaunchArgs({
      argv: ['--background', '--data-dir=C:/old', ELEVATED_RELAUNCH_FLAG],
      dataDir,
    })
    expect(args).toEqual(['--background', ELEVATED_RELAUNCH_FLAG, '--data-dir=' + path.resolve(dataDir)])
  })

  it('空格写法的 --data-dir 连它的值一起丢掉', () => {
    const args = buildElevatedRelaunchArgs({ argv: ['--data-dir', 'C:/old', '--keep'], dataDir })
    expect(args).toEqual(['--keep', ELEVATED_RELAUNCH_FLAG, '--data-dir=' + path.resolve(dataDir)])
  })

  it('没有旧参数时只追加，且数据目录一定是绝对路径', () => {
    const args = buildElevatedRelaunchArgs({ argv: [], dataDir: './relative-data' })
    expect(args.length).toBe(2)
    expect(args[0]).toBe(ELEVATED_RELAUNCH_FLAG)
    expect(path.isAbsolute(args[1].slice('--data-dir='.length))).toBe(true)
  })
})

describe('buildElevatedPowerShellCommand', () => {
  it('用 Start-Process -Verb RunAs 拉新实例，且不加 -Wait', () => {
    const script = buildElevatedPowerShellCommand({
      executablePath: 'C:/Program Files/DSH Launcher/DSH Launcher.exe',
      args: [ELEVATED_RELAUNCH_FLAG, '--data-dir=C:/Users/zhang san/AppData/Roaming/dsh-launcher'],
    })
    expect(script).toContain("Start-Process -FilePath 'C:/Program Files/DSH Launcher/DSH Launcher.exe'")
    expect(script).toContain("-ArgumentList @('--elevated-relaunch','--data-dir=C:/Users/zhang san/AppData/Roaming/dsh-launcher')")
    expect(script).toContain('-Verb RunAs')
    expect(script).not.toContain('-Wait')
  })

  it('单引号按 PowerShell 规则翻倍', () => {
    const script = buildElevatedPowerShellCommand({ executablePath: "C:/a'b/app.exe", args: ["--x='y'"] })
    expect(script).toContain("'C:/a''b/app.exe'")
    expect(script).toContain("'--x=''y'''")
  })
})

type SpawnImpl = NonNullable<Parameters<typeof relaunchElevated>[0]['spawnImpl']>

function fakeSpawn(options: { closeCode: number | null; stderr?: string }) {
  const captured: { command?: string; args?: readonly string[] } = {}
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void }
  child.stderr = new EventEmitter()
  child.kill = () => {}
  const spawnImpl = ((command: string, args: readonly string[]) => {
    captured.command = command
    captured.args = args
    setTimeout(() => {
      if (options.stderr) child.stderr.emit('data', Buffer.from(options.stderr))
      child.emit('close', options.closeCode)
    }, 0)
    return child
  }) as unknown as SpawnImpl
  return { spawnImpl, captured }
}

describe('relaunchElevated', () => {
  it.skipIf(process.platform !== 'win32')('成功时返回 true，并把 Start-Process 脚本交给 PowerShell', async () => {
    const { spawnImpl, captured } = fakeSpawn({ closeCode: 0 })
    const ok = await relaunchElevated({ executablePath: 'C:/App/launcher.exe', args: [ELEVATED_RELAUNCH_FLAG], spawnImpl })
    expect(ok).toBe(true)
    expect(captured.command).toBe('powershell.exe')
    const args = captured.args ?? []
    expect(args).toContain('-Command')
    const script = args[args.indexOf('-Command') + 1]
    expect(script).toContain('-Verb RunAs')
    expect(script).toContain("'C:/App/launcher.exe'")
    expect(args).toContain('-NoProfile')
  })

  it.skipIf(process.platform !== 'win32')('用户点「否」时返回 false 且只 warn，不抛异常', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { spawnImpl } = fakeSpawn({ closeCode: 1, stderr: 'The operation was canceled by the user' })
      const ok = await relaunchElevated({ executablePath: 'C:/App/launcher.exe', args: [], spawnImpl })
      expect(ok).toBe(false)
      expect(warn).toHaveBeenCalled()
      expect(String(warn.mock.calls[0]?.[0])).toContain('按未提权继续')
    } finally {
      warn.mockRestore()
    }
  })
})

const baseSettings: AppSettings = {
  dshInstallPath: '/home/tester/.dsh-runtime',
  dshHome: '/home/tester/.dsh',
  profileName: 'web',
  workspace: '/home/tester/Documents',
  launchExecutable: 'npx',
  launchArgs: ['--yes', '@deepseek-ai/dsh', 'web'],
  webPort: 3080,
  openAfterLaunch: true,
}

describe('launchElevated 设置归一化', () => {
  const defaults = defaultSettings({
    homeDirectory: '/home/tester',
    documentsDirectory: '/home/tester/Documents',
    platform: 'linux',
  })

  it('defaultSettings 缺省为 false', () => {
    expect(defaults.launchElevated).toBe(false)
  })

  it('validateSettings 只认显式 true', () => {
    expect(validateSettings({ ...baseSettings, launchElevated: true }).launchElevated).toBe(true)
    expect(validateSettings({ ...baseSettings, launchElevated: false }).launchElevated).toBe(false)
    expect(validateSettings({ ...baseSettings, launchElevated: 'yes' as unknown as boolean }).launchElevated).toBe(false)
  })

  it('mergeStoredSettings 用存储里的布尔值，否则回落缺省 false', () => {
    expect(mergeStoredSettings(defaults, { launchElevated: true }).launchElevated).toBe(true)
    expect(mergeStoredSettings(defaults, { launchElevated: false }).launchElevated).toBe(false)
    expect(mergeStoredSettings(defaults, {}).launchElevated).toBe(false)
    expect(mergeStoredSettings(defaults, null).launchElevated).toBe(false)
    expect(mergeStoredSettings(defaults, { launchElevated: 'yes' as unknown as boolean }).launchElevated).toBe(false)
  })
})
