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

describe('便携版解压目录', () => {
  // electron-builder 的便携壳始终用构建期固定的临时目录（unpackDirName 关不掉，传 false 也照样生成 KSUID）
  // 并先 RMDir /r 再解压，所以「同一份便携 EXE 起第二个实例」必然清掉第一个正在用的文件。
  // 我们能控的是不去主动制造第二个实例：提权判定必须拿到 portable 标志。
  // electron-builder 的判定是 `typeof unpackDirName === 'string' || !unpackDirName`：传字符串会用
  // $TEMP\<名字>，传 false/不传都会生成一个构建期固定的 KSUID。只有「真值但非字符串」能跳过这段，
  // 让 NSIS 用默认的 $PLUGINSDIR\app —— 那是每次启动都不同的临时目录，谁也不会删谁的文件。
  it('portable 用每次启动都不同的解压目录（unpackDirName 真值非字符串）', () => {
    const pkg = JSON.parse(read('package.json')) as { build: { portable: { unpackDirName?: unknown } } }
    const unpackDirName = pkg.build.portable.unpackDirName
    expect(typeof unpackDirName).not.toBe('string')
    expect(Boolean(unpackDirName)).toBe(true)
  })
})
