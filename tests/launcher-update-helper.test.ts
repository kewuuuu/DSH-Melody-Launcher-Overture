import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApplyLogPath, buildInstallDirArgument, buildInstallerArgs, installDirFromExecPath } from '../electron/launcher-update-helper'

const INSTALL_DIR = 'C:\\Program Files\\DSH Launcher & 100%'
const EXE_PATH = INSTALL_DIR + '\\DSH Launcher.exe'
const OPERATION_ID = '2ff065d2-1c98-4b56-bccc-4a6e351ec279'

const input = { pid: 4321, installDir: INSTALL_DIR }

describe('Windows installer paths', () => {
  it('uses the current executable directory and leaves the raw NSIS path unquoted', () => {
    expect(installDirFromExecPath(EXE_PATH)).toBe(INSTALL_DIR)
    expect(buildInstallDirArgument(INSTALL_DIR)).toBe('/D=' + INSTALL_DIR)
    expect(buildInstallDirArgument('C:/Program Files/DSH Launcher')).toBe('/D=C:\\Program Files\\DSH Launcher')
    expect(buildInstallDirArgument('\\\\server\\share\\DSH Launcher')).toBe('/D=\\\\server\\share\\DSH Launcher')
  })

  it.each([
    '', '.', 'launcher', 'C:launcher', '\\launcher', ' C:\\Launcher', 'C:\\',
    'C:\\Launcher\\..', 'C:\\Launcher\\.', 'C:\\Launcher ', 'C:\\Launcher.',
    'C:\\Launcher\\\\nested', 'C:\\foo"bar', 'C:\\foo\nbar', 'C:\\foo\x00bar',
    'C:\\foo\\COM1', 'C:\\foo|bar', 'C:\\foo?bar', 'C:\\foo:bar',
    '\\\\?\\C:\\launcher', '\\\\.\\C:\\launcher', '\\\\server\\share',
  ])('rejects malformed install directory %j', dir => {
    expect(() => buildInstallDirArgument(dir)).toThrow('绝对路径')
  })

  it.each(['launcher.exe', 'C:\\Launcher\\launcher', 'C:\\Launcher\\launcher.exe\\'])('rejects invalid executable path %j', exe => {
    expect(() => installDirFromExecPath(exe)).toThrow()
  })
})

describe('native installer handoff', () => {
  it('uses the per-process log beside Setup', () => {
    expect(buildApplyLogPath('update cache', input.pid)).toBe(path.join('update cache', 'handoff-4321.log'))
  })

  it('includes only the fixed flags and puts the unquoted directory last', () => {
    expect(buildInstallerArgs(input)).toEqual(['/S', '--dsh-handoff=4321', '/D=' + INSTALL_DIR])
    expect(buildInstallerArgs({ ...input, operationId: OPERATION_ID, useCacheRoot: true })).toEqual([
      '/S', '--dsh-handoff=4321', '--dsh-continue=' + OPERATION_ID, '--dsh-use-cache-root=1', '/D=' + INSTALL_DIR,
    ])
  })

  it.each([0, -1, 1.5, Infinity, NaN, 0x1_0000_0000])('rejects invalid PID %s', pid => {
    expect(() => buildInstallerArgs({ ...input, pid })).toThrow('Invalid launcher process ID')
  })

  it.each(['', 'wrong', OPERATION_ID.toUpperCase(), OPERATION_ID.replace('-4', '-1'), OPERATION_ID + '\n'])('rejects noncanonical continuation ID %j', operationId => {
    expect(() => buildInstallerArgs({ ...input, operationId })).toThrow('Invalid launcher update continuation ID')
  })
})
