/**
 * 工作区 skill 扫描与停用/删除。
 *
 * 启动器以前只看 <home>/skills，工作区里的 <workspace>/.dsh/skills 完全看不见。
 * 这里把两处一起列出来：全局组固定 id 'global'，每个工作区用 workspace.json 里的 uuid 当组 id。
 *
 * 三条不能破的规则：
 *   1. 停用 = 目录/文件名末尾加 .disabled，绝不删文件；启用就是把后缀去掉。
 *   2. 删除必须先过备份区（backupBeforeDelete）。备份抛错就中止，文件原样留在盘上。
 *   3. id 里的路径段要校验，解析出来的路径必须落在对应 skills 根目录里。
 */
import { readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { WorkspaceSkillEntry, WorkspaceSkillGroup, WorkspaceSkillsOverview } from '../src/types'
import { backupBeforeDelete } from './backups'
import { isSkillName, parseSkillDocument } from './skill-format'

export const DISABLED_SUFFIX = '.disabled'
export const GLOBAL_SKILLS_GROUP = 'global'
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export interface WorkspaceSkillsDeps {
  /** DSH 家目录；每次调用都重新取，家目录切换后不用重建服务。 */
  home: () => string
}

export interface WorkspaceSkillsService {
  list(): Promise<WorkspaceSkillsOverview>
  setEnabled(id: string, enabled: boolean): Promise<WorkspaceSkillsOverview>
  remove(id: string): Promise<WorkspaceSkillsOverview>
}

interface SkillGroup {
  group: WorkspaceSkillGroup
  root: string
  scope: 'global' | 'workspace'
  workspace?: { id: string; title: string }
}

interface StoredWorkspace {
  id: string
  path: string
  title: string
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isDisabledName(name: string): boolean {
  return name.toLowerCase().endsWith(DISABLED_SUFFIX)
}

function stripDisabled(name: string): string {
  return isDisabledName(name) ? name.slice(0, -DISABLED_SUFFIX.length) : name
}

async function pathKind(target: string): Promise<'file' | 'directory' | null> {
  try {
    const info = await stat(target)
    if (info.isDirectory()) return 'directory'
    return info.isFile() ? 'file' : null
  } catch {
    return null
  }
}

async function pathExists(target: string): Promise<boolean> {
  return (await pathKind(target)) !== null
}

/** 目标必须是 root 的直接子项：既挡住 ..，也挡住借绝对路径跳出根目录。 */
function assertDirectChild(root: string, target: string): void {
  const base = path.resolve(root)
  const resolved = path.resolve(target)
  const relative = path.relative(base, resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error(`技能路径越界：${target}`)
  }
}

/** 读 <home>/storages/workspace.json 的 version 2 信封；缺失或损坏一律当成「只有全局组」。 */
async function readWorkspaceRecords(home: string): Promise<StoredWorkspace[]> {
  let raw: string
  try {
    raw = await readFile(path.join(home, 'storages', 'workspace.json'), 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const envelope = parsed as Record<string, unknown>
  const globalSection = envelope.global
  if (typeof globalSection !== 'object' || globalSection === null) return []
  const ids = (globalSection as Record<string, unknown>).workspaceIds
  if (!Array.isArray(ids)) return []
  const tables = envelope.tables
  const table = typeof tables === 'object' && tables !== null
    ? (tables as Record<string, unknown>).workspaces
    : undefined
  const workspaces = typeof table === 'object' && table !== null ? (table as Record<string, unknown>) : {}

  const records: StoredWorkspace[] = []
  const seen = new Set<string>()
  for (const value of ids) {
    if (typeof value !== 'string') continue
    const id = value.trim()
    if (!id || seen.has(id) || !WORKSPACE_ID.test(id)) continue
    const entry = workspaces[id]
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const directory = typeof record.path === 'string' ? record.path.trim() : ''
    if (!directory) continue
    const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : id
    seen.add(id)
    records.push({ id, path: directory, title })
  }
  return records
}

async function buildGroups(home: string): Promise<SkillGroup[]> {
  const globalRoot = path.join(home, 'skills')
  const groups: SkillGroup[] = [{
    group: { id: GLOBAL_SKILLS_GROUP, title: '全局', path: globalRoot, missing: !(await pathExists(globalRoot)) },
    root: globalRoot,
    scope: 'global',
  }]
  for (const workspace of await readWorkspaceRecords(home)) {
    const root = path.join(workspace.path, '.dsh', 'skills')
    groups.push({
      group: { id: workspace.id, title: workspace.title, path: root, missing: !(await pathExists(root)) },
      root,
      scope: 'workspace',
      workspace: { id: workspace.id, title: workspace.title },
    })
  }
  return groups
}

async function scanGroup(group: SkillGroup): Promise<WorkspaceSkillEntry[]> {
  let entries
  try {
    entries = await readdir(group.root, { withFileTypes: true })
  } catch {
    return []
  }
  const skills: WorkspaceSkillEntry[] = []
  const seen = new Set<string>()
  // 同一 base 名同时存在启用与 .disabled 两份时，启用那份先扫到（去重保留它）。
  const ordered = [...entries].sort((left, right) => {
    const diff = stripDisabled(left.name).localeCompare(stripDisabled(right.name))
    if (diff !== 0) return diff
    return Number(isDisabledName(left.name)) - Number(isDisabledName(right.name))
  })

  for (const entry of ordered) {
    // 点开头的是隐藏项：<home>/skills/.disabled 是 skill-format 的停用区，不是技能本身。
    if (entry.name.startsWith('.')) continue
    const disabled = isDisabledName(entry.name)
    let documentPath: string
    let skillPath: string
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const candidate = path.join(group.root, entry.name, 'SKILL.md')
      if ((await pathKind(candidate)) !== 'file') continue
      skillPath = path.join(group.root, entry.name)
      documentPath = candidate
    } else if (entry.isFile()) {
      const lower = entry.name.toLowerCase()
      if (!lower.endsWith('.md') && !lower.endsWith(`.md${DISABLED_SUFFIX}`)) continue
      skillPath = path.join(group.root, entry.name)
      documentPath = skillPath
    } else {
      continue
    }

    let document: string
    try {
      document = await readFile(documentPath, 'utf8')
    } catch {
      continue
    }
    const parsed = parseSkillDocument(document)
    if (!parsed || !isSkillName(parsed.name)) continue

    // 扁平技能用去掉扩展名的文件名做标识，和 bundle 的 <目录名> 形态对齐。
    const trimmed = stripDisabled(entry.name)
    const segment = entry.isFile() && trimmed.toLowerCase().endsWith('.md') ? trimmed.slice(0, -3) : trimmed
    const id = `${group.group.id}/${segment}`
    if (seen.has(id)) continue
    seen.add(id)
    skills.push({
      id,
      name: parsed.name,
      description: parsed.description,
      path: skillPath,
      scope: group.scope,
      ...(group.workspace
        ? { workspaceId: group.workspace.id, workspaceTitle: group.workspace.title }
        : {}),
      disabled,
    })
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

async function overview(home: string): Promise<WorkspaceSkillsOverview> {
  const groups = await buildGroups(home)
  const skills: WorkspaceSkillEntry[] = []
  for (const group of groups) skills.push(...await scanGroup(group))
  // 全局组由界面自己按 scope 汇总，不属于「工作区」列表：混进来会多出一个同名的空分组。
  return { skills, workspaces: groups.filter(group => group.group.id !== GLOBAL_SKILLS_GROUP).map(group => group.group) }
}

/** id 形状是 <groupId>/<name>，两段都只允许单个路径段。 */
function splitSkillId(raw: unknown): [string, string] {
  const id = typeof raw === 'string' ? raw.trim() : ''
  const parts = id.split('/')
  const [groupId, name] = parts
  if (
    parts.length !== 2
    || !groupId
    || !name
    || name === '.'
    || name === '..'
    || name.includes('\\')
    || name.includes('\u0000')
    || groupId.includes('\\')
  ) {
    throw new Error(`技能标识无效：${id || String(raw)}`)
  }
  return [groupId, name]
}

async function resolveSkill(home: string, rawId: unknown): Promise<{ entry: WorkspaceSkillEntry; group: SkillGroup }> {
  const [groupId] = splitSkillId(rawId)
  const id = String(rawId).trim()
  const groups = await buildGroups(home)
  const group = groups.find(item => item.group.id === groupId)
  if (!group) throw new Error(`未找到技能：${id}`)

  const skills = await scanGroup(group)
  const entry = skills.find(item => item.id === id)
  if (!entry) throw new Error(`未找到技能：${id}`)
  assertDirectChild(group.root, entry.path)
  return { entry, group }
}

export function createWorkspaceSkillsService(deps: WorkspaceSkillsDeps): WorkspaceSkillsService {
  return {
    list(): Promise<WorkspaceSkillsOverview> {
      return overview(deps.home())
    },

    async setEnabled(id: string, enabled: boolean): Promise<WorkspaceSkillsOverview> {
      const home = deps.home()
      const { entry, group } = await resolveSkill(home, id)
      const current = path.basename(entry.path)
      const enabledNow = !isDisabledName(current)
      if (enabledNow === enabled) return overview(home)

      const next = enabled ? stripDisabled(current) : `${current}${DISABLED_SUFFIX}`
      if (!next) throw new Error(`技能标识无效：${id}`)
      const from = path.join(group.root, current)
      const to = path.join(group.root, next)
      assertDirectChild(group.root, from)
      assertDirectChild(group.root, to)
      const action = enabled ? '启用' : '停用'
      if (await pathExists(to)) {
        throw new Error(`无法${action}技能「${entry.name}」：目标位置已存在同名文件`)
      }
      try {
        await rename(from, to)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EACCES') {
          throw new Error(`无法${action}技能「${entry.name}」：${errorText(error)}`)
        }
        throw error
      }
      return overview(home)
    },

    async remove(id: string): Promise<WorkspaceSkillsOverview> {
      const home = deps.home()
      const { entry } = await resolveSkill(home, id)
      // 先备份、再删除：备份抛错时这里直接冒泡，rm 根本不会执行。
      await backupBeforeDelete({ paths: [entry.path], label: entry.name, op: 'skill.delete' })
      await rm(entry.path, { recursive: true, force: true })
      return overview(home)
    },
  }
}
