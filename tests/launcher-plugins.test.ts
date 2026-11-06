import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/constants'
import type { LauncherPluginsState } from '../src/types'
import { createLauncherPluginsService } from '../electron/launcher-plugins'
import { registerLauncherPluginsIpc } from '../electron/launcher-plugins-ipc'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-launcher-plugins-'))
  roots.push(root)
  return root
}

async function writePlugin(
  directory: string,
  dirName: string,
  manifest: unknown,
  files: Record<string, string> = {},
): Promise<string> {
  const pluginDir = path.join(directory, dirName)
  await mkdir(pluginDir, { recursive: true })
  const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2)
  await writeFile(path.join(pluginDir, 'manifest.json'), body, 'utf8')
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(pluginDir, name), content, 'utf8')
  }
  return pluginDir
}

const CHILD_PLUGIN = [
  'const items = [',
  "  { label: 'cwd', value: process.cwd() },",
  "  { label: 'argv', value: process.argv[2] ?? '' },",
  ']',
  "process.stdout.write(JSON.stringify({ panels: [{ id: 'code', title: '子进程', type: 'list', items }] }))",
].join('\n')

afterEach(async () => {
  // 被 kill 的子进程在 Windows 上会短暂占住 cwd，清理失败不应让用例背锅。
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } catch {
      // 临时目录留给系统回收。
    }
  }
})

describe('launcher plugins: 扫描与面板', () => {
  it('纯 manifest 插件不跑子进程也出面板，id 带插件名前缀', async () => {
    const directory = await makeRoot()
    await writePlugin(directory, 'plain-dir', {
      name: 'plain',
      title: '静态面板',
      version: '1.2.3',
      description: '只有 manifest',
      panels: [{ id: 'main', title: '今日', type: 'list', items: [{ label: '输入', value: '1.2M' }, { label: '文档', href: 'https://example.com' }] }],
    })

    const service = createLauncherPluginsService({ directory })
    expect(service.list()).toEqual({ plugins: [], panels: [], fetchedAt: null, directory })

    const state = await service.refresh()
    expect(state.directory).toBe(directory)
    expect(state.fetchedAt).toBeTypeOf('number')
    expect(state.plugins).toEqual([
      { name: 'plain', title: '静态面板', version: '1.2.3', description: '只有 manifest', hasCode: false, error: null },
    ])
    expect(state.panels).toEqual([
      {
        id: 'plain:main',
        plugin: 'plain',
        title: '今日',
        type: 'list',
        items: [{ label: '输入', value: '1.2M' }, { label: '文档', href: 'https://example.com' }],
      },
    ])
    expect(service.list()).toBe(state)
  })

  it('index.mjs 插件在真实子进程里跑通，cwd 与 argv 都是插件目录', async () => {
    const directory = await makeRoot()
    const pluginDir = await writePlugin(directory, 'child', { name: 'runner', title: '子进程' }, { 'index.mjs': CHILD_PLUGIN })

    const state = await createLauncherPluginsService({ directory }).refresh()
    expect(state.plugins).toEqual([{ name: 'runner', title: '子进程', hasCode: true, error: null }])

    const panel = state.panels[0]
    expect(panel).toMatchObject({ id: 'runner:code', plugin: 'runner', title: '子进程', type: 'list' })
    if (panel?.type !== 'list') throw new Error('期望 list 面板')
    const items = Object.fromEntries(panel.items.map(item => [item.label, item.value]))
    expect(items.cwd?.toLowerCase()).toBe(pluginDir.toLowerCase())
    expect(items.argv?.toLowerCase()).toBe(pluginDir.toLowerCase())
  })

  it('超时插件按失败隔离，别的插件照常出面板', async () => {
    const directory = await makeRoot()
    await writePlugin(directory, 'slow', { name: 'slow', title: '慢插件' }, {
      'index.mjs': 'setTimeout(() => {}, 60_000)',
    })
    await writePlugin(directory, 'fast', { name: 'fast', title: '快插件' }, {
      'index.mjs': "process.stdout.write(JSON.stringify([{ id: 'ok', title: '正常', type: 'list', items: [{ label: 'a' }] }]))",
    })

    const service = createLauncherPluginsService({ directory, timeoutMs: 1_200 })
    const startedAt = Date.now()
    const state = await service.refresh()
    expect(Date.now() - startedAt).toBeLessThan(10_000)

    const slow = state.plugins.find(plugin => plugin.name === 'slow')
    expect(slow?.hasCode).toBe(true)
    expect(slow?.error).toContain('插件执行超时（1.2 秒）')
    expect(state.panels.some(panel => panel.plugin === 'slow')).toBe(false)

    const fast = state.plugins.find(plugin => plugin.name === 'fast')
    expect(fast?.error).toBeNull()
    expect(state.panels.some(panel => panel.id === 'fast:ok')).toBe(true)
  })

  it('非法与超限面板被裁剪并写进 error，不影响插件整体', async () => {
    const directory = await makeRoot()
    const panels = [
      { id: 'big-list', title: '列表', type: 'list', items: Array.from({ length: 250 }, (_, index) => ({ label: `项 ${index}`, value: String(index) })) },
      {
        id: 'big-table',
        title: '表格',
        type: 'table',
        columns: Array.from({ length: 15 }, (_, index) => `c${index}`),
        rows: Array.from({ length: 250 }, (_, row) => Array.from({ length: 15 }, (_, column) => `${row}-${column}`)),
      },
      { id: 'big-html', title: '网页', type: 'html', html: 'x'.repeat(600 * 1024) },
      { id: '', title: '没有 id', type: 'list', items: [] },
      { id: 'no-title', type: 'list', items: [] },
      { id: 'bad-type', title: '坏类型', type: 'chart' },
      ...Array.from({ length: 60 }, (_, index) => ({ id: `filler-${index}`, title: `填充 ${index}`, type: 'list', items: [] })),
    ]
    await writePlugin(directory, 'bulk', { name: 'bulk', title: '批量', panels })

    const state = await createLauncherPluginsService({ directory }).refresh()
    const info = state.plugins[0]
    expect(info.name).toBe('bulk')
    expect(info.error).toContain('面板缺少 id')
    expect(info.error).toContain('面板「no-title」缺少 title')
    expect(info.error).toContain('面板「bad-type」的 type 无效')
    expect(info.error).toContain('条目超过 200 条，已截断')
    expect(info.error).toContain('列数超过 12 列，已截断')
    expect(info.error).toContain('行数超过 200 行，已截断')
    expect(info.error).toContain('HTML 超过 512 KiB，已截断')
    expect(info.error).toContain('面板超过 50 个，已截断')
    expect(state.panels).toHaveLength(50)

    const list = state.panels.find(panel => panel.id === 'bulk:big-list')
    if (list?.type !== 'list') throw new Error('期望 list 面板')
    expect(list.items).toHaveLength(200)

    const table = state.panels.find(panel => panel.id === 'bulk:big-table')
    if (table?.type !== 'table') throw new Error('期望 table 面板')
    expect(table.columns).toHaveLength(12)
    expect(table.rows).toHaveLength(200)
    expect(table.rows.every(row => row.length === 12)).toBe(true)

    const html = state.panels.find(panel => panel.id === 'bulk:big-html')
    if (html?.type !== 'html') throw new Error('期望 html 面板')
    expect(Buffer.byteLength(html.html, 'utf8')).toBeLessThanOrEqual(512 * 1024)
    expect(state.panels.some(panel => panel.title === '没有 id')).toBe(false)
  })

  it('目录不存在时返回空面板，坏 manifest 只影响自己', async () => {
    const root = await makeRoot()
    const missing = createLauncherPluginsService({ directory: path.join(root, 'not-here') })
    expect(missing.list().panels).toEqual([])
    expect(await missing.refresh()).toEqual({ plugins: [], panels: [], fetchedAt: expect.any(Number), directory: path.join(root, 'not-here') })

    const directory = path.join(root, 'plugins')
    await mkdir(directory, { recursive: true })
    await mkdir(path.join(directory, 'broken'), { recursive: true })
    await writeFile(path.join(directory, 'broken', 'manifest.json'), '{ not json', 'utf8')
    await writePlugin(directory, 'good', { name: 'good', title: '好的', panels: [{ id: 'a', title: 'A', type: 'list', items: [] }] })

    const state = await createLauncherPluginsService({ directory }).refresh()
    const broken = state.plugins.find(plugin => plugin.name === 'broken')
    expect(broken?.error).toContain('manifest.json 不是合法 JSON')
    expect(broken?.hasCode).toBe(false)
    expect(state.plugins.find(plugin => plugin.name === 'good')?.error).toBeNull()
    expect(state.panels.map(panel => panel.id)).toEqual(['good:a'])
  })

  it('manifest 声明的入口不存在时只报自己的错', async () => {
    const directory = await makeRoot()
    await writePlugin(directory, 'no-entry', { name: 'no-entry', title: '丢入口', entry: 'main.js' })

    const state = await createLauncherPluginsService({ directory }).refresh()
    expect(state.plugins[0].hasCode).toBe(false)
    expect(state.plugins[0].error).toContain('入口文件不存在：main.js')
  })
})

describe('launcher plugins: IPC 装配', () => {
  it('三个 handler 各就各位，openFolder 拿到插件目录', async () => {
    const directory = await makeRoot()
    await writePlugin(directory, 'plain', { name: 'plain', title: '静态', panels: [{ id: 'a', title: 'A', type: 'list', items: [] }] })

    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const removed: string[] = []
    const ipcMain = {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => { handlers.set(channel, listener) },
      removeHandler: (channel: string) => { removed.push(channel) },
    }
    const openFolder = vi.fn(async () => undefined)
    const service = registerLauncherPluginsIpc({ ipcMain: ipcMain as never, directory, openFolder })

    expect(service.directory).toBe(directory)
    expect([...handlers.keys()].sort()).toEqual(
      [IPC.launcherPluginsList, IPC.launcherPluginsRefresh, IPC.launcherPluginsOpenFolder].sort(),
    )
    expect(removed).toEqual(expect.arrayContaining([IPC.launcherPluginsList, IPC.launcherPluginsRefresh, IPC.launcherPluginsOpenFolder]))

    await handlers.get(IPC.launcherPluginsRefresh)!({})
    const listed = await handlers.get(IPC.launcherPluginsList)!({}) as LauncherPluginsState
    expect(listed.plugins.map(plugin => plugin.name)).toEqual(['plain'])
    expect(listed.panels.map(panel => panel.id)).toEqual(['plain:a'])

    await handlers.get(IPC.launcherPluginsOpenFolder)!({})
    expect(openFolder).toHaveBeenCalledTimes(1)
    expect(openFolder).toHaveBeenCalledWith(directory)
  })
})
