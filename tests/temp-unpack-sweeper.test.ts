import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { DEFAULT_SWEEP_MAX_AGE_MS, NSIS_TEMP_DIR_PATTERN, sweepTempUnpackDirs } from '../electron/temp-unpack-sweeper';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 10, 13, 12, 0, 0);

function fixture(entries: Record<string, number>, imagePaths: string[] = []) {
  const removed: string[] = [];
  const run = (maxAgeMs?: number) => sweepTempUnpackDirs({
    dir: 'C:\\Temp',
    now,
    maxAgeMs,
    processImagePaths: imagePaths,
    listDirs: async () => Object.keys(entries),
    mtimeOf: async target => entries[path.basename(target)],
    removeDir: async target => { removed.push(target) },
  }).then(result => ({ result, removed }))
  return { entries, run }
}

describe('便携解压目录清扫', () => {
  it('只认 NSIS 的 nsXXXX.tmp 目录', () => {
    expect(NSIS_TEMP_DIR_PATTERN.test('nsr309C.tmp')).toBe(true)
    expect(NSIS_TEMP_DIR_PATTERN.test('nsd404C.tmp')).toBe(true)
    expect(NSIS_TEMP_DIR_PATTERN.test('3M31ODrrJNE6CIRYwMR1QnhdD4u')).toBe(false)
    expect(NSIS_TEMP_DIR_PATTERN.test('nsr309C.tmp.bak')).toBe(false)
  })

  it('过期又没人用的目录删掉，年轻的与别的临时目录都不动', async () => {
    const { run } = fixture({ 'nsold.tmp': now - 30 * DAY, 'nsnew.tmp': now - 1 * DAY, 'other-dir': now - 90 * DAY })
    const { result, removed } = await run()
    expect(removed).toEqual([path.join('C:\\Temp', 'nsold.tmp')])
    expect(result.skipped.sort()).toEqual([path.join('C:\\Temp', 'nsnew.tmp')].sort())
  })

  it('有进程正从里面运行就跳过，哪怕已经很旧', async () => {
    const { run } = fixture(
      { 'nsbusy.tmp': now - 30 * DAY, 'nsfree.tmp': now - 30 * DAY },
      [path.join('C:\\Temp', 'nsbusy.tmp', 'app', 'DSH-launcher-KEWU.exe')],
    )
    const { result, removed } = await run()
    expect(removed).toEqual([path.join('C:\\Temp', 'nsfree.tmp')])
    expect(result.skipped).toContain(path.join('C:\\Temp', 'nsbusy.tmp'))
  })

  it('删失败只记录，不影响别的目录', async () => {
    const run = await sweepTempUnpackDirs({
      dir: 'C:\\Temp',
      now,
      listDirs: async () => ['nsa.tmp', 'nsb.tmp'],
      mtimeOf: async () => now - 30 * DAY,
      removeDir: async target => {
        if (target.endsWith('nsa.tmp')) throw new Error('EBUSY')
      },
    })
    expect(run.failed).toEqual([path.join('C:\\Temp', 'nsa.tmp')])
    expect(run.removed).toEqual([path.join('C:\\Temp', 'nsb.tmp')])
  })

  it('默认只清 7 天以前的', async () => {
    expect(DEFAULT_SWEEP_MAX_AGE_MS).toBe(7 * DAY)
    const { run } = fixture({ 'ns6d.tmp': now - 6 * DAY, 'ns8d.tmp': now - 8 * DAY })
    const { removed } = await run()
    expect(removed).toEqual([path.join('C:\\Temp', 'ns8d.tmp')])
  })

  it('目录读不出来时安静返回', async () => {
    const result = await sweepTempUnpackDirs({ dir: 'C:\\Temp', now, listDirs: async () => { throw new Error('ENOENT') } })
    expect(result).toEqual({ removed: [], skipped: [], failed: [] })
  })
})
describe('启动接线与发布纪律', () => {
  it('主进程启动时确实会清一次过期解压目录', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync('electron/main.ts', 'utf8');
    expect(main).toContain('sweepTempUnpackDirs({ dir: os.tmpdir(), processImagePaths: defaultProcessImagePaths() })');
  })

  it('没有依赖 GitHub Actions 的发布流水线（账号没有 Actions 额度，发布只走本地）', async () => {
    const { existsSync } = await import('node:fs');
    expect(existsSync('.github/workflows/signpath.yml')).toBe(false);
  })
})
