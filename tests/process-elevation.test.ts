import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: mocked.execFile }))
import { isProcessElevated, parseElevationProbe, resetProcessElevationCache } from '../electron/process-elevation'

/** 探针的真实输出由 mock 的 execFile 回调喂进来，绝不起 PowerShell。 */
function respond(error: Error | null, stdout: string): void {
  mocked.execFile.mockImplementation(((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void
    callback(error, stdout, '')
  }) as never)
}

describe('launcher process elevation probe', () => {
  beforeEach(() => {
    resetProcessElevationCache()
    mocked.execFile.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses the last meaningful probe line and ignores noise', () => {
    expect(parseElevationProbe('True')).toBe(true)
    expect(parseElevationProbe('False')).toBe(false)
    expect(parseElevationProbe('True\r\n')).toBe(true)
    // PowerShell 的 Add-Type 警告排在答案前面：只认最后一行。
    expect(parseElevationProbe('WARNING: something\nFalse\n')).toBe(false)
    expect(parseElevationProbe('')).toBeNull()
    expect(parseElevationProbe('\n\n')).toBeNull()
    expect(parseElevationProbe('unexpected output')).toBeNull()
  })

  it('caches the probe result and re-probes after a reset', async () => {
    respond(null, 'True')
    expect(await isProcessElevated()).toBe(true)
    expect(await isProcessElevated()).toBe(true)
    // 两次调用只起一次 PowerShell。
    expect(mocked.execFile).toHaveBeenCalledTimes(1)
    expect(mocked.execFile.mock.calls[0][0]).toBe('powershell.exe')
    resetProcessElevationCache()
    respond(null, 'False')
    expect(await isProcessElevated()).toBe(false)
    expect(mocked.execFile).toHaveBeenCalledTimes(2)
  })

  it('treats a failing probe as not elevated and warns only once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    respond(new Error('PowerShell refused the probe'), '')
    expect(await isProcessElevated()).toBe(false)
    expect(await isProcessElevated()).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('never probes on a non-Windows platform', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      expect(await isProcessElevated()).toBe(false)
      expect(mocked.execFile).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  })
})
