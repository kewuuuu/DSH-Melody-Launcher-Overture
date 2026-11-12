import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version

interface ReleaseScript {
  resolveOutputDir: (v: string, options?: { root?: string }) => { dir: string; reused: boolean }
}

let script: ReleaseScript | null = null
async function loadScript(): Promise<ReleaseScript> {
  if (!script) {
    const href = pathToFileURL(join(repoRoot, 'scripts', 'release.mjs')).href
    script = (await import(/* @vite-ignore */ href)) as ReleaseScript
  }
  return script
}

const tempRoots: string[] = []

function makeRoot(builds: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'overture-release-'))
  tempRoots.push(root)
  for (const [build, files] of Object.entries(builds)) {
    mkdirSync(join(root, 'release', build), { recursive: true })
    for (const file of files) writeFileSync(join(root, 'release', build, file), '')
  }
  return root
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('scripts/release.mjs 默认产物目录', () => {
  it('b14 已含当前版本便携版时复用它，而不是跳到空的 b15', async () => {
    const root = makeRoot({
      b14: [`DSH-launcher-KEWU-Portable-${version}.exe`],
      b15: [],
    })
    const { resolveOutputDir } = await loadScript()
    expect(resolveOutputDir(version, { root })).toEqual({ dir: join('release', 'b14'), reused: true })
  })

  it('多个目录都装着当前版本时取编号最大的', async () => {
    const portable = `DSH-launcher-KEWU-Portable-${version}.exe`
    const root = makeRoot({ b12: [portable], b14: [portable], b13: [] })
    const { resolveOutputDir } = await loadScript()
    expect(resolveOutputDir(version, { root })).toEqual({ dir: join('release', 'b14'), reused: true })
  })

  it('没有目录装着当前版本时回落到最大编号 + 1', async () => {
    const root = makeRoot({ b13: [], b15: [], b16: ['DSH-launcher-KEWU-Portable-0.0.1.exe'] })
    const { resolveOutputDir } = await loadScript()
    expect(resolveOutputDir(version, { root })).toEqual({ dir: join('release', 'b17'), reused: false })
  })

  it('release 目录不存在时从 b1 开始', async () => {
    const root = makeRoot({})
    const { resolveOutputDir } = await loadScript()
    expect(resolveOutputDir(version, { root })).toEqual({ dir: join('release', 'b1'), reused: false })
  })
})
