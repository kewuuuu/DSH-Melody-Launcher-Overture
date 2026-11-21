import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'

/**
 * 「更新前正在运行的整合包」记录：更新流程在停包之前把它写下来，
 * 新版本启动时只恢复这些包（不碰 autoStart），读完即删。
 * 坏文件一律当「没有记录」——多起一个包比启动时崩掉更糟。
 */

export const UPDATE_RESUME_FILENAME = 'resume-after-update.json'
export const UPDATE_RESUME_VERSION = 1
const UPDATE_RESUME_DIRNAME = 'launcher-update'

export interface UpdateResumePack {
  id: string
  name?: string
}

export interface UpdateResumeFile {
  version: number
  /** 更新到的版本；只是现场记录，不参与恢复判定。 */
  toVersion: string | null
  packs: UpdateResumePack[]
  /** 写入时刻（ISO）。 */
  at: string
}

export function updateResumePath(userData: string): string {
  return path.join(userData, UPDATE_RESUME_DIRNAME, UPDATE_RESUME_FILENAME)
}

/** 解析文件内容；结构不对就返回 null，不做局部修复。 */
export function parseUpdateResume(text: string): UpdateResumeFile | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  const record = value as { version?: unknown; toVersion?: unknown; packs?: unknown; at?: unknown }
  if (!Array.isArray(record.packs)) return null
  const packs: UpdateResumePack[] = []
  for (const item of record.packs) {
    if (!item || typeof item !== 'object') continue
    const pack = item as { id?: unknown; name?: unknown }
    if (typeof pack.id !== 'string' || !pack.id.trim()) continue
    packs.push({ id: pack.id.trim(), ...(typeof pack.name === 'string' && pack.name ? { name: pack.name } : {}) })
  }
  return {
    version: typeof record.version === 'number' ? record.version : UPDATE_RESUME_VERSION,
    toVersion: typeof record.toVersion === 'string' ? record.toVersion : null,
    packs,
    at: typeof record.at === 'string' ? record.at : new Date(0).toISOString(),
  }
}

export async function readUpdateResume(userData: string): Promise<UpdateResumeFile | null> {
  let text: string
  try {
    text = await readFile(updateResumePath(userData), 'utf8')
  } catch {
    return null // 文件不存在＝这次启动没有待恢复的包
  }
  return parseUpdateResume(text)
}

export async function saveUpdateResume(userData: string, file: UpdateResumeFile): Promise<void> {
  const target = updateResumePath(userData)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFileAtomic(target, JSON.stringify(file, null, 2))
}

export async function clearUpdateResume(userData: string): Promise<void> {
  await rm(updateResumePath(userData), { force: true })
}
