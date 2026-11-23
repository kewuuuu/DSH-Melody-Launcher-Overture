import { describe, expect, it, vi } from 'vitest'
import { prepareUserQuit } from '../electron/main-lifecycle'

function quitFixture(response: number, legacyRunning = false) {
  return {
    policy: 'ask' as const,
    isPackRunning: () => true,
    isLegacyRuntimeBusy: () => legacyRunning,
    showMessageBox: vi.fn(async () => ({ response })),
    stopLegacyRuntime: vi.fn(async () => {}),
    shutdownPacks: vi.fn(async (_mode: 'keep' | 'stop') => {}),
  }
}

describe('launcher quit preparation', () => {
  it('leaves both runtime paths untouched when the user cancels', async () => {
    const fixture = quitFixture(2, true)
    await expect(prepareUserQuit(fixture)).resolves.toBe(false)
    expect(fixture.stopLegacyRuntime).not.toHaveBeenCalled()
    expect(fixture.shutdownPacks).not.toHaveBeenCalled()
  })

  it('stops without prompting and waits for the owned pack outcome', async () => {
    const fixture = quitFixture(2, true)
    let completeStop!: () => void
    const stopping = new Promise<void>(resolve => { completeStop = resolve })
    fixture.shutdownPacks.mockReturnValue(stopping)
    const onReadyToQuit = vi.fn()
    const prepared = prepareUserQuit({ ...fixture, policy: 'stop' }).then(onReadyToQuit)
    await vi.waitFor(() => expect(fixture.shutdownPacks).toHaveBeenCalledWith('stop'))
    expect(fixture.showMessageBox).not.toHaveBeenCalled()
    expect(fixture.stopLegacyRuntime).toHaveBeenCalledOnce()
    expect(onReadyToQuit).not.toHaveBeenCalled()
    completeStop()
    await prepared
    expect(onReadyToQuit).toHaveBeenCalledOnce()
  })

  it('propagates a failed pack stop', async () => {
    const fixture = quitFixture(0)
    fixture.shutdownPacks.mockRejectedValue(new Error('pack stop failed'))
    await expect(prepareUserQuit(fixture)).rejects.toThrow('pack stop failed')
  })

  it('keeps packs through the preservation hook and propagates its errors', async () => {
    const fixture = quitFixture(1)
    fixture.shutdownPacks.mockRejectedValue(new Error('pack cannot survive launcher exit'))
    await expect(prepareUserQuit(fixture)).rejects.toThrow('pack cannot survive launcher exit')
    expect(fixture.shutdownPacks).toHaveBeenCalledExactlyOnceWith('keep')
    expect(fixture.stopLegacyRuntime).not.toHaveBeenCalled()
  })

  it('blocks keep before committing when the legacy runtime is live', async () => {
    const fixture = quitFixture(1, true)
    await expect(prepareUserQuit(fixture)).rejects.toThrow('仍有旧版运行实例')
    expect(fixture.shutdownPacks).not.toHaveBeenCalled()
    expect(fixture.stopLegacyRuntime).not.toHaveBeenCalled()
  })
})
