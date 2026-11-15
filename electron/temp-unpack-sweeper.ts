import { promises as fs } from 'node:fs';
import path from 'node:path';

/** NSIS 自解压外壳（Setup 安装包，以及已停发的便携版外壳）会在 %TEMP% 里建 nsXXXX.tmp 并解出一整份程序。 */
export const NSIS_TEMP_DIR_PATTERN = /^ns[a-z0-9]+\.tmp$/i
/** 只有明显过期的目录才清：进程崩掉时没人替它删，正常退出时壳自己会删。 */
export const DEFAULT_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface SweepTempUnpackDirsOptions {
  dir: string
  now?: number
  maxAgeMs?: number
  /** 正在运行的进程的映像路径，命中某个目录（含子路径）就跳过。 */
  processImagePaths?: string[]
  listDirs?: (dir: string) => Promise<string[]>
  removeDir?: (target: string) => Promise<void>
  mtimeOf?: (target: string) => Promise<number>
}

export interface SweepTempUnpackDirsResult {
  removed: string[]
  skipped: string[]
  failed: string[]
}

function inUseBy(target: string, imagePaths: string[]): boolean {
  const lowered = target.toLowerCase()
  return imagePaths.some(image => {
    const value = image.toLowerCase()
    return value === lowered || value.startsWith(lowered.endsWith(path.sep) ? lowered : lowered + path.sep)
  })
}

/**
 * 删掉 %TEMP% 里过期的 NSIS 解压残渣。安装版本体不再自解压，这里捡的是两类别人留下的目录：
 * ① 从旧便携版升级上来的机器上还睡着的 ns*.tmp；② Setup / 更新安装包被强杀时没删干净的 ns*.tmp。
 * 有进程正从里面运行、或者目录还年轻（默认 7 天）就原样留着：宁可漏收，也不删正在跑的实例。
 */
export async function sweepTempUnpackDirs(options: SweepTempUnpackDirsOptions): Promise<SweepTempUnpackDirsResult> {
  const {
    dir,
    now = Date.now(),
    maxAgeMs = DEFAULT_SWEEP_MAX_AGE_MS,
    processImagePaths = [],
    listDirs = async target => (await fs.readdir(target, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name),
    removeDir = target => fs.rm(target, { recursive: true, force: true }),
    mtimeOf = async target => (await fs.stat(target)).mtimeMs,
  } = options
  const result: SweepTempUnpackDirsResult = { removed: [], skipped: [], failed: [] }
  let names: string[]
  try {
    names = await listDirs(dir)
  } catch {
    return result
  }
  for (const name of names) {
    if (!NSIS_TEMP_DIR_PATTERN.test(name)) continue
    const target = path.join(dir, name)
    if (inUseBy(target, processImagePaths)) { result.skipped.push(target); continue }
    let mtime: number
    try {
      mtime = await mtimeOf(target)
    } catch {
      continue
    }
    if (!Number.isFinite(mtime) || now - mtime < maxAgeMs) { result.skipped.push(target); continue }
    try {
      await removeDir(target)
      result.removed.push(target)
    } catch {
      result.failed.push(target)
    }
  }
  return result
}
