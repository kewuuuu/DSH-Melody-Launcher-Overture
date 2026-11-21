import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearUpdateResume,
  parseUpdateResume,
  readUpdateResume,
  saveUpdateResume,
  updateResumePath,
} from '../electron/update-resume'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kewu-update-resume-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('update resume file', () => {
  it('writes and reads the packs that were running before the update', async () => {
    const root = await tempRoot()
    await saveUpdateResume(root, {
      version: 1,
      toVersion: '1.3.2',
      packs: [{ id: 'pack-test', name: '基础包' }, { id: 'web' }],
      at: '2026-11-21T08:00:00.000Z',
    })
    const read = await readUpdateResume(root)
    expect(read).toEqual({
      version: 1,
      toVersion: '1.3.2',
      packs: [{ id: 'pack-test', name: '基础包' }, { id: 'web' }],
      at: '2026-11-21T08:00:00.000Z',
    })
    // 落在 launcher-update/ 下，和下载缓存同一个目录
    expect(updateResumePath(root)).toBe(path.join(root, 'launcher-update', 'resume-after-update.json'))
    const raw = await readFile(updateResumePath(root), 'utf8')
    expect(raw.endsWith('\n') || raw.endsWith('}')).toBe(true)
  })

  it('returns null when no update has been applied yet', async () => {
    const root = await tempRoot()
    expect(await readUpdateResume(root)).toBeNull()
  })

  it('drops a corrupt file instead of throwing', async () => {
    const root = await tempRoot()
    await mkdir(path.join(root, 'launcher-update'), { recursive: true })
    await writeFile(updateResumePath(root), '{ not json')
    expect(await readUpdateResume(root)).toBeNull()
    expect(parseUpdateResume('null')).toBeNull()
    expect(parseUpdateResume('{"packs":"nope"}')).toBeNull()
  })

  it('keeps usable pack entries and skips the rest', () => {
    const parsed = parseUpdateResume(JSON.stringify({ version: 2, toVersion: 3, packs: [{ id: ' ok ' }, { id: '' }, { name: 'no-id' }, null] }))
    expect(parsed).toEqual({ version: 2, toVersion: null, packs: [{ id: 'ok' }], at: new Date(0).toISOString() })
  })

  it('clears the file so the next launch falls back to autostart', async () => {
    const root = await tempRoot()
    await saveUpdateResume(root, { version: 1, toVersion: null, packs: [], at: '2026-11-21T08:00:00.000Z' })
    await clearUpdateResume(root)
    expect(await readUpdateResume(root)).toBeNull()
    // 再删一次也不报错
    await clearUpdateResume(root)
  })
})
