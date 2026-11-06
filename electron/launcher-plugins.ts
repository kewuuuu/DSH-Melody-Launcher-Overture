/**
 * 启动器插件宿主：启动页右下角数据面板的来源。
 *
 * 插件根目录是 <userData>/launcher-plugins，一个子目录一个插件：
 *   manifest.json  必填，至少要有 name；panels 可以是静态面板
 *   index.mjs      可选入口（manifest.entry 可改名），有它才会起子进程
 *
 * 代码插件的 stdout 必须是 JSON：{ panels: [...] } 或直接 [...]
 * 单个插件失败只写它自己的 error，绝不牵连别的插件；list() 读缓存，refresh() 重扫并重跑代码插件。
 */
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  LauncherPluginInfo,
  LauncherPluginItem,
  LauncherPluginPanel,
  LauncherPluginsState,
} from '../src/types'

export const DEFAULT_PLUGIN_TIMEOUT_MS = 10_000
export const DEFAULT_PLUGIN_ENTRY = 'index.mjs'
/** 单个插件最多产出的面板数。 */
export const MAX_PLUGIN_PANELS = 50
export const MAX_LIST_ITEMS = 200
export const MAX_TABLE_ROWS = 200
export const MAX_TABLE_COLUMNS = 12
/** 单个 html 面板的上限：512 KiB（按 UTF-8 字节算）。 */
export const MAX_HTML_BYTES = 512 * 1024

const PLUGIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const STDERR_KEEP = 4_000

export interface LauncherPluginsDeps {
  /** 插件根目录（<userData>/launcher-plugins）。 */
  directory: string
  /** 覆盖入口执行，返回插件的 stdout（测试用）。 */
  run?: (entry: string, pluginDir: string) => Promise<string>
  /** 单插件执行上限，默认 10 秒；注入更短的值只影响本服务实例。 */
  timeoutMs?: number
  now?: () => number
}

export interface LauncherPluginsService {
  readonly directory: string
  list(): LauncherPluginsState
  refresh(): Promise<LauncherPluginsState>
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function pluginTimeoutMessage(timeoutMs: number): string {
  return timeoutMs >= 1000
    ? `插件执行超时（${Math.round((timeoutMs / 1000) * 10) / 10} 秒）`
    : `插件执行超时（${timeoutMs} 毫秒）`
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
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

/**
 * 子进程只拿到跑 Node 必需的变量：用户环境里的密钥（API key、token 之类）一律不转发。
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const keys = [
    'PATH', 'Path', 'SystemRoot', 'windir', 'COMSPEC', 'PATHEXT',
    'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'TZ',
  ]
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

/** 默认执行器：node <entry> <pluginDir>，cwd 是插件目录，超时直接 kill。 */
function runNodeEntry(entry: string, pluginDir: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, pluginDir], {
      cwd: pluginDir,
      env: childEnvironment(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error: Error | null, output?: string): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve(output ?? '')
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(pluginTimeoutMessage(timeoutMs)))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_KEEP) stderr += chunk.toString('utf8')
    })
    child.once('error', (error: Error) => {
      finish(new Error(`插件进程启动失败：${error.message}`))
    })
    child.once('exit', (code: number | null) => {
      if (code === 0) {
        finish(null, stdout)
        return
      }
      const detail = stderr.trim() ? `：${stderr.trim().slice(0, 300)}` : ''
      finish(new Error(`插件退出（代码 ${code ?? '未知'}）${detail}`))
    })
  })
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(pluginTimeoutMessage(timeoutMs))), timeoutMs)
  })
  return Promise.race([task, guard]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

interface SanitizeResult {
  panel: LauncherPluginPanel | null
  notes: string[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cellText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 单个面板的校验与裁剪：非法就丢掉并留一条中文说明，绝不抛到插件外面。 */
function sanitizePanel(raw: unknown, plugin: string, notes: string[]): LauncherPluginPanel | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    notes.push('面板必须是对象')
    return null
  }
  const record = raw as Record<string, unknown>
  const id = text(record.id)
  if (!id) {
    notes.push('面板缺少 id')
    return null
  }
  const panelId = `${plugin}:${id}`
  const title = text(record.title)
  if (!title) {
    notes.push(`面板「${id}」缺少 title`)
    return null
  }
  const hint = typeof record.hint === 'string' && record.hint.trim() ? record.hint : undefined

  if (record.type === 'list') {
    const rawItems = Array.isArray(record.items) ? record.items : null
    if (!rawItems) notes.push(`面板「${id}」的 items 不是数组`)
    const items: LauncherPluginItem[] = []
    for (const rawItem of rawItems ?? []) {
      if (typeof rawItem !== 'object' || rawItem === null || Array.isArray(rawItem)) continue
      const item = rawItem as Record<string, unknown>
      const label = text(item.label)
      if (!label) continue
      const value = typeof item.value === 'string' ? item.value : undefined
      const href = typeof item.href === 'string' && item.href.trim() ? item.href : undefined
      items.push({ label, ...(value !== undefined ? { value } : {}), ...(href ? { href } : {}) })
    }
    if (items.length > MAX_LIST_ITEMS) {
      items.length = MAX_LIST_ITEMS
      notes.push(`面板「${id}」条目超过 ${MAX_LIST_ITEMS} 条，已截断`)
    }
    return { id: panelId, plugin, title, type: 'list', items, ...(hint ? { hint } : {}) }
  }

  if (record.type === 'table') {
    const columns: string[] = []
    for (const rawColumn of Array.isArray(record.columns) ? record.columns : []) {
      const column = text(rawColumn)
      if (column) columns.push(column)
    }
    if (columns.length === 0) {
      notes.push(`面板「${id}」缺少 columns`)
      return null
    }
    if (columns.length > MAX_TABLE_COLUMNS) {
      columns.length = MAX_TABLE_COLUMNS
      notes.push(`面板「${id}」列数超过 ${MAX_TABLE_COLUMNS} 列，已截断`)
    }
    const rows: string[][] = []
    for (const rawRow of Array.isArray(record.rows) ? record.rows : []) {
      if (!Array.isArray(rawRow)) continue
      const cells = rawRow.map(cellText)
      while (cells.length < columns.length) cells.push('')
      rows.push(cells.slice(0, columns.length))
    }
    if (rows.length > MAX_TABLE_ROWS) {
      rows.length = MAX_TABLE_ROWS
      notes.push(`面板「${id}」行数超过 ${MAX_TABLE_ROWS} 行，已截断`)
    }
    return { id: panelId, plugin, title, type: 'table', columns, rows, ...(hint ? { hint } : {}) }
  }

  if (record.type === 'html') {
    let html = typeof record.html === 'string' ? record.html : ''
    if (!html) {
      notes.push(`面板「${id}」缺少 html`)
      return null
    }
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      html = Buffer.from(html, 'utf8').subarray(0, MAX_HTML_BYTES).toString('utf8').replace(/\uFFFD+$/u, '')
      notes.push(`面板「${id}」的 HTML 超过 512 KiB，已截断`)
    }
    return { id: panelId, plugin, title, type: 'html', html, ...(hint ? { hint } : {}) }
  }

  notes.push(`面板「${id}」的 type 无效`)
  return null
}

interface PluginDraft {
  dirName: string
  name: string
  title: string
  version?: string
  description?: string
  hasCode: boolean
  panels: LauncherPluginPanel[]
  notes: string[]
}

type ManifestRead =
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; data: Record<string, unknown> }

async function readManifest(pluginDir: string): Promise<ManifestRead> {
  let raw: string
  try {
    raw = await readFile(path.join(pluginDir, 'manifest.json'), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'invalid', error: `manifest.json 读取失败：${errorText(error)}` }
  }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    return { kind: 'invalid', error: `manifest.json 不是合法 JSON：${errorText(error)}` }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { kind: 'invalid', error: 'manifest.json 顶层必须是对象' }
  }
  return { kind: 'ok', data: data as Record<string, unknown> }
}

async function readPluginDirs(directory: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((left, right) => left.localeCompare(right))
}

function collectPanels(
  rawPanels: unknown[],
  plugin: string,
  draft: PluginDraft,
  seen: Set<string>,
): void {
  for (const raw of rawPanels) {
    const panel = sanitizePanel(raw, plugin, draft.notes)
    if (!panel) continue
    if (seen.has(panel.id)) {
      draft.notes.push(`面板 id 重复：${panel.id}`)
      continue
    }
    seen.add(panel.id)
    draft.panels.push(panel)
  }
}

async function buildDrafts(
  directory: string,
  runner: (entry: string, pluginDir: string) => Promise<string>,
  timeoutMs: number,
): Promise<PluginDraft[]> {
  const drafts: PluginDraft[] = []
  const claimed = new Map<string, string>()

  for (const dirName of await readPluginDirs(directory)) {
    const pluginDir = path.join(directory, dirName)
    const manifest = await readManifest(pluginDir)
    if (manifest.kind === 'missing') continue

    const notes: string[] = []
    const data = manifest.kind === 'ok' ? manifest.data : null
    if (manifest.kind === 'invalid') notes.push(manifest.error)

    let name = typeof data?.name === 'string' ? data.name.trim() : ''
    if (!name) {
      name = dirName
      notes.push('manifest.name 缺失或不是字符串')
    } else if (!PLUGIN_NAME.test(name)) {
      notes.push(`manifest.name 含非法字符：${name}`)
      name = dirName
    }
    const owner = claimed.get(name)
    if (owner) notes.push(`插件名与目录「${owner}」重复`)
    else claimed.set(name, dirName)

    const title = text(data?.title) || name
    const version = text(data?.version)
    const description = typeof data?.description === 'string' && data.description.trim() ? data.description.trim() : ''

    const draft: PluginDraft = {
      dirName,
      name,
      title,
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      hasCode: false,
      panels: [],
      notes,
    }
    const seen = new Set<string>()

    if (data) {
      if (data.panels !== undefined) {
        if (Array.isArray(data.panels)) collectPanels(data.panels, name, draft, seen)
        else notes.push('manifest.panels 必须是数组')
      }

      const declaredEntry = typeof data.entry === 'string' && data.entry.trim() ? data.entry.trim() : null
      const entryName = declaredEntry ?? DEFAULT_PLUGIN_ENTRY
      const entryPath = path.resolve(pluginDir, entryName)
      if (!isInside(pluginDir, entryPath)) {
        notes.push(`入口路径越界：${entryName}`)
      } else if ((await pathKind(entryPath)) === 'file') {
        draft.hasCode = true
        try {
          const stdout = await withTimeout(runner(entryPath, pluginDir), timeoutMs)
          const output = stdout.trim()
          if (!output) throw new Error('插件没有在 stdout 输出 JSON')
          let parsed: unknown
          try {
            parsed = JSON.parse(output)
          } catch (error) {
            throw new Error(`插件输出不是合法 JSON：${errorText(error)}`)
          }
          const rawPanels = Array.isArray(parsed)
            ? parsed
            : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).panels)
              ? ((parsed as Record<string, unknown>).panels as unknown[])
              : null
          if (!rawPanels) throw new Error('插件输出缺少 panels 数组')
          collectPanels(rawPanels, name, draft, seen)
        } catch (error) {
          // 代码插件失败只落到它自己的 error 上：别的插件、整体流程都不受影响。
          notes.push(errorText(error))
        }
      } else if (declaredEntry) {
        notes.push(`入口文件不存在：${entryName}`)
      }
    }

    if (draft.panels.length > MAX_PLUGIN_PANELS) {
      draft.panels.length = MAX_PLUGIN_PANELS
      notes.push(`面板超过 ${MAX_PLUGIN_PANELS} 个，已截断`)
    }
    drafts.push(draft)
  }

  return drafts
}

function emptyState(directory: string): LauncherPluginsState {
  return { plugins: [], panels: [], fetchedAt: null, directory }
}

function assemble(drafts: PluginDraft[], directory: string, fetchedAt: number): LauncherPluginsState {
  const plugins: LauncherPluginInfo[] = []
  const panels: LauncherPluginPanel[] = []
  const seen = new Set<string>()
  const ordered = [...drafts].sort(
    (left, right) => left.name.localeCompare(right.name) || left.dirName.localeCompare(right.dirName),
  )
  for (const draft of ordered) {
    const kept: LauncherPluginPanel[] = []
    for (const panel of draft.panels) {
      if (seen.has(panel.id)) {
        draft.notes.push(`面板 id 与其它插件重复：${panel.id}`)
        continue
      }
      seen.add(panel.id)
      kept.push(panel)
    }
    panels.push(...kept)
    plugins.push({
      name: draft.name,
      title: draft.title,
      ...(draft.version ? { version: draft.version } : {}),
      ...(draft.description ? { description: draft.description } : {}),
      hasCode: draft.hasCode,
      error: draft.notes.length ? draft.notes.join('；') : null,
    })
  }
  return { plugins, panels, fetchedAt, directory }
}

export function createLauncherPluginsService(deps: LauncherPluginsDeps): LauncherPluginsService {
  const directory = deps.directory
  const timeoutMs = deps.timeoutMs ?? DEFAULT_PLUGIN_TIMEOUT_MS
  const runner = deps.run ?? ((entry: string, pluginDir: string) => runNodeEntry(entry, pluginDir, timeoutMs))
  const now = deps.now ?? (() => Date.now())
  let state = emptyState(directory)

  return {
    directory,
    list(): LauncherPluginsState {
      return state
    },
    async refresh(): Promise<LauncherPluginsState> {
      const drafts = await buildDrafts(directory, runner, timeoutMs)
      state = assemble(drafts, directory, now())
      return state
    },
  }
}
