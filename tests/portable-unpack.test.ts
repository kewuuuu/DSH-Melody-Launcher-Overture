import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

describe('许可证', () => {
  it('package.json 声明 MIT，LICENSE 与 NOTICE 都在，元数据指向本分支仓库', () => {
    const pkg = JSON.parse(read('package.json')) as { license?: string; repository?: { url?: string } }
    expect(pkg.license).toBe('MIT')
    expect(pkg.repository?.url ?? '').toContain('kewuuuu/DSH-Melody-Launcher-Overture')
    expect(read('LICENSE')).toContain('MIT License')
    expect(read('NOTICE')).toContain('rirko/dsh-melody-launcher')
  })
})
