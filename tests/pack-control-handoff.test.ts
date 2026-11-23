import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { writePackRegistry, type PackRecord } from '../electron/pack-registry'
import type { RuntimeState } from '../src/types'
import { fixtureControl } from './fixtures/pack-control-owner'

it.skipIf(process.platform !== 'win32')('preserves a verified fixture across launcher exit, then adopts or force-stops only its worker', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'overture-pack-handoff-'))
  const id = 'alpha'
  const contender = fixtureControl(root, path.join(root, 'contender'))
  const observer = fixtureControl(root, path.join(root, 'observer'))
  const require = createRequire(import.meta.url)
  const runner = path.join(path.dirname(require.resolve('vite-node/package.json')), 'dist', 'cli.mjs')
  const ownerScript = fileURLToPath(new URL('./fixtures/pack-control-owner.ts', import.meta.url))
  const homePath = path.join(root, 'home')
  await mkdir(homePath)
  await writePackRegistry(path.join(root, 'packs.json'), [{ id, name: id, description: '', version: '1', homePath, source: 'created', installedAt: '', updatedAt: '', state: 'complete', plugins: [] } as PackRecord])
  await writeFile(path.join(root, 'server.cjs'), "const http = require('node:http'); const port = Number(process.argv[process.argv.indexOf('--port')+1]); http.createServer((_, res) => res.end('fixture')).listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:'+port));")
  const owner = fork(runner, [ownerScript, '--', '--owner-fixture', root], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const command = (control: typeof contender, command: string, args?: Record<string, unknown>) => control.execute({ command, packId: id, args })
  const state = async (control: typeof contender) => (await command(control, 'pack.list') as { packs: Array<{ runtime: RuntimeState & { ownership?: string; activeSessionCount?: number | null } }> }).packs[0].runtime
  try {
    expect((await once(owner, 'message'))[0]).toBe('started')
    const first = await vi.waitFor(async () => {
      const current = await state(contender)
      expect(current).toMatchObject({ running: true, ownership: 'observer', activeSessionCount: 0, url: expect.any(String) })
      return current
    }, { timeout: 7000 })
    expect(contender.hasRunningHome(homePath)).toBe(true)
    await expect(command(contender, 'pack.start')).rejects.toThrow(/another launcher/)
    await expect(command(contender, 'pack.restart')).rejects.toThrow(/another launcher/)
    await expect(command(contender, 'pack.stop')).rejects.toThrow(/another launcher/)
    await expect(command(contender, 'pack.config.set', { port: 12345 })).rejects.toThrow(/Cannot modify/)
    await expect(contender.acquirePackRemoval(id)).rejects.toThrow(/Cannot modify/)
    await observer.shutdown('stop')
    expect(await (await fetch(first.url!)).text()).toBe('fixture')
    const exited = once(owner, 'exit')
    owner.send('leave')
    expect((await exited)[0]).toBe(0)
    const adopted = await state(contender)
    expect(adopted).toMatchObject({ ownership: 'owned', pid: first.pid, port: first.port, url: first.url })
    expect(await command(contender, 'pack.start')).toMatchObject({ ownership: 'owned', pid: first.pid })
    expect(await command(contender, 'pack.openWeb')).toMatchObject({ url: first.url })
    const rollback = await contender.prepareForRelaunch()
    await expect(command(contender, 'pack.stop')).rejects.toThrow(/shutting down/)
    rollback()
    expect(await command(contender, 'pack.restart')).toMatchObject({ accepted: true })
    const restarted = await vi.waitFor(async () => {
      const current = await state(contender)
      expect(current.pid).toEqual(expect.any(Number))
      expect(current.pid).not.toBe(first.pid)
      expect(current.url).toEqual(expect.any(String))
      return current
    }, { timeout: 8000 })
    observer.resumeAfterStop()
    expect(await state(observer)).toMatchObject({ ownership: 'observer', pid: restarted.pid })
    const workers = path.join(homePath, 'profiles', id, '.launcher-overture-runtimes')
    let checkedStale = false
    for (const name of await readdir(workers)) {
      const recordPath = path.join(workers, name, 'pack-runtime.json')
      const text = await readFile(recordPath, 'utf8')
      const saved = JSON.parse(text)
      if (saved.runtime.pid !== restarted.pid) continue
      checkedStale = true
      try {
        saved.runtime.creationFileTime = '1'
        await writeFile(recordPath, JSON.stringify(saved))
        expect(await state(observer)).toMatchObject({ ownership: 'observer', pid: null, url: null })
        await expect(command(observer, 'pack.stop', { force: true })).rejects.toThrow(/identity is unverified/)
        expect(await (await fetch(restarted.url!)).text()).toBe('fixture')
      } finally { await writeFile(recordPath, text) }
    }
    expect(checkedStale).toBe(true)
    expect(await command(observer, 'pack.stop', { force: true })).toMatchObject({ running: false, stoppedBy: 'session' })
    await vi.waitFor(async () => expect(await state(contender)).toMatchObject({ running: false }), { timeout: 3000 })
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, 'exit')
      owner.send('leave')
      await exited
    }
    await command(contender, 'pack.stop', { force: true }).catch(() => undefined)
    await contender.shutdown().catch(() => undefined)
    await observer.shutdown().catch(() => undefined)
    await rm(root, { recursive: true, force: true })
  }
}, 25000)
