import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BOOT_MARKER_FILENAME,
  bootMarkerPath,
  clearBootMarker,
  waitForBootMarker,
  writeBootMarker,
} from '../electron/elevation-handshake'

const temporaryRoots: string[] = []
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-boot-marker-'))
  temporaryRoots.push(root)
  return root
}

/** 假时钟 + 只推进时间不真睡的 sleep：等待逻辑用真实 20 秒会拖垮整个测试套件。 */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; elapsed: () => number } {
  let current = 0
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms
    },
    elapsed: () => current,
  }
}

describe('writeBootMarker / bootMarkerPath', () => {
  it('写进数据目录下的约定文件名，内容带数字 at，父目录不存在也递归建好', async () => {
    const root = await temporaryRoot()
    const dataDir = path.join(root, 'userData', 'nested')

    await writeBootMarker(dataDir, () => 1234, 4321)

    expect(bootMarkerPath(dataDir)).toBe(path.join(dataDir, BOOT_MARKER_FILENAME))
    const raw = await readFile(bootMarkerPath(dataDir), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(JSON.parse(raw)).toEqual({ pid: 4321, at: 1234 })
    expect(typeof JSON.parse(raw).at).toBe('number')
  })

  it('并发两次写不会留下半截文件，读回来总能 JSON.parse 成功', async () => {
    const root = await temporaryRoot()

    await Promise.all([writeBootMarker(root, () => 1000, 1), writeBootMarker(root, () => 2000, 2)])

    const parsed = JSON.parse(await readFile(bootMarkerPath(root), 'utf8'))
    expect([1000, 2000]).toContain(parsed.at)
    expect(typeof parsed.pid).toBe('number')
  })
})

describe('waitForBootMarker', () => {
  it('at 早于 since 的旧标记不算新实例，用满超时后返回 false', async () => {
    const root = await temporaryRoot()
    await writeBootMarker(root, () => 1000, 111)
    const clock = fakeClock()
    const wallClock = Date.now()

    const result = await waitForBootMarker(root, {
      since: 2000,
      timeoutMs: 1000,
      pollMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result).toBe(false)
    // 恰好用满预算：注入的 sleep 推进了假时钟，而不是真的等了一秒。
    expect(clock.elapsed()).toBe(1000)
    expect(Date.now() - wallClock).toBeLessThan(1000)
  })

  it('看到 at >= since 的标记立刻返回 true，不再睡', async () => {
    const root = await temporaryRoot()
    await writeBootMarker(root, () => 3000, 222)
    const clock = fakeClock()

    const result = await waitForBootMarker(root, {
      since: 2000,
      timeoutMs: 5000,
      pollMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result).toBe(true)
    expect(clock.elapsed()).toBe(0)
  })

  it('坏 JSON / at 不是数字的文件都当「还没起来」，最终超时 false 且不抛', async () => {
    const root = await temporaryRoot()
    const file = bootMarkerPath(root)
    const clock = fakeClock()
    const options = { since: 2000, timeoutMs: 500, pollMs: 250, now: clock.now, sleep: clock.sleep }

    await writeFile(file, '{"pid":1,"at":')
    await expect(waitForBootMarker(root, options)).resolves.toBe(false)

    await writeFile(file, '{"pid":1,"at":"3000"}')
    await expect(waitForBootMarker(root, options)).resolves.toBe(false)

    await writeFile(file, 'null')
    await expect(waitForBootMarker(root, options)).resolves.toBe(false)
  })

  it('标记稍后出现也能等到：每一轮都重新读文件', async () => {
    const root = await temporaryRoot()
    const clock = fakeClock()
    let reads = 0
    const read = async (): Promise<string | null> => {
      reads += 1
      return reads < 3 ? null : JSON.stringify({ pid: 7, at: 2000 }) + '\n'
    }

    const result = await waitForBootMarker(path.join(root, 'not-written-yet'), {
      since: 2000,
      timeoutMs: 2000,
      pollMs: 250,
      read,
      now: clock.now,
      sleep: clock.sleep,
    })

    expect(result).toBe(true)
    expect(reads).toBe(3)
    expect(clock.elapsed()).toBe(500)
  })
})

describe('clearBootMarker', () => {
  it('文件不存在不抛错；删掉已存在的标记后同一个目录等不到启动', async () => {
    const root = await temporaryRoot()

    await expect(clearBootMarker(root)).resolves.toBeUndefined()

    await writeBootMarker(root, () => 5000, 333)
    const first = fakeClock()
    await expect(
      waitForBootMarker(root, { since: 1000, timeoutMs: 500, pollMs: 250, now: first.now, sleep: first.sleep }),
    ).resolves.toBe(true)

    await clearBootMarker(root)
    const second = fakeClock()
    await expect(
      waitForBootMarker(root, { since: 1000, timeoutMs: 500, pollMs: 250, now: second.now, sleep: second.sleep }),
    ).resolves.toBe(false)
  })
})
