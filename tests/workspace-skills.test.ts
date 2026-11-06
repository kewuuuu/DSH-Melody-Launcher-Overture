import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../src/constants'
import type { WorkspaceSkillsOverview } from '../src/types'
import { backupBeforeDelete } from '../electron/backups'
import { createWorkspaceSkillsService, type WorkspaceSkillsService } from '../electron/workspace-skills'
import { registerWorkspaceSkillsIpc } from '../electron/workspace-skills-ipc'

vi.mock('../electron/backups', () => ({
  backupBeforeDelete: vi.fn(async () => null),
}))

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const backupMock = vi.mocked(backupBeforeDelete)
const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-workspace-skills-'))
  roots.push(root)
  return root
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

function skillDocument(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n正文\n`
}

async function writeBundle(root: string, dirName: string, name: string, description: string): Promise<string> {
  const dir = path.join(root, dirName)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'SKILL.md'), skillDocument(name, description), 'utf8')
  return dir
}

async function writeFlat(root: string, fileName: string, name: string, description: string): Promise<string> {
  await mkdir(root, { recursive: true })
  const file = path.join(root, fileName)
  await writeFile(file, skillDocument(name, description), 'utf8')
  return file
}

async function writeWorkspaceJson(
  home: string,
  records: { id: string; path: string; title: string }[],
): Promise<void> {
  const workspaces: Record<string, unknown> = {}
  for (const record of records) workspaces[record.id] = { path: record.path, title: record.title, sessionIds: [] }
  await mkdir(path.join(home, 'storages'), { recursive: true })
  await writeFile(
    path.join(home, 'storages', 'workspace.json'),
    JSON.stringify({ version: 2, global: { workspaceIds: records.map(record => record.id) }, tables: { workspaces } }, null, 2),
    'utf8',
  )
}

interface Fixture {
  home: string
  workspacePath: string
  workspaceRoot: string
  service: WorkspaceSkillsService
}

async function makeFixture(): Promise<Fixture> {
  const home = await makeRoot()
  const workspacePath = path.join(home, 'ws-demo')
  await mkdir(workspacePath, { recursive: true })
  const workspaceRoot = path.join(workspacePath, '.dsh', 'skills')
  await writeBundle(path.join(home, 'skills'), 'global-skill', 'global-skill', '全局技能')
  await writeBundle(workspaceRoot, 'ws-skill', 'ws-skill', '工作区技能')
  await writeFlat(workspaceRoot, 'flat-note.md', 'flat-note', '扁平技能')
  await writeWorkspaceJson(home, [{ id: WORKSPACE_ID, path: workspacePath, title: '示例工作区' }])
  return { home, workspacePath, workspaceRoot, service: createWorkspaceSkillsService({ home: () => home }) }
}

beforeEach(() => {
  backupMock.mockReset()
  backupMock.mockResolvedValue(null)
})

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('workspace skills: 扫描', () => {
  it('workspace.json 缺失时只有全局组', async () => {
    const home = await makeRoot()
    const service = createWorkspaceSkillsService({ home: () => home })
    const overview = await service.list()
    expect(overview.workspaces).toEqual([
      { id: 'global', title: '全局', path: path.join(home, 'skills'), missing: true },
    ])
    expect(overview.skills).toEqual([])
  })

  it('workspace.json 损坏时也不抛错，只有全局组', async () => {
    const home = await makeRoot()
    await mkdir(path.join(home, 'storages'), { recursive: true })
    await writeFile(path.join(home, 'storages', 'workspace.json'), '{ "version": 2, "global": ', 'utf8')
    await writeBundle(path.join(home, 'skills'), 'only-global', 'only-global', '全局技能')

    const overview = await createWorkspaceSkillsService({ home: () => home }).list()
    expect(overview.workspaces.map(group => group.id)).toEqual(['global'])
    expect(overview.skills.map(skill => skill.id)).toEqual(['global/only-global'])
  })

  it('工作区 skill 被列出且 scope / workspaceId / 路径都正确，缺目录的组标 missing', async () => {
    const home = await makeRoot()
    const workspacePath = path.join(home, 'ws-demo')
    const workspaceRoot = path.join(workspacePath, '.dsh', 'skills')
    await writeBundle(path.join(home, 'skills'), 'global-skill', 'global-skill', '全局技能')
    await writeBundle(workspaceRoot, 'ws-skill', 'ws-skill', '工作区技能')
    await writeFlat(workspaceRoot, 'flat-note.md', 'flat-note', '扁平技能')
    await writeWorkspaceJson(home, [
      { id: WORKSPACE_ID, path: workspacePath, title: '示例工作区' },
      { id: '22222222-2222-4222-8222-222222222222', path: path.join(home, 'ghost'), title: '幽灵工作区' },
    ])

    const overview = await createWorkspaceSkillsService({ home: () => home }).list()
    expect(overview.workspaces).toEqual([
      { id: 'global', title: '全局', path: path.join(home, 'skills'), missing: false },
      { id: WORKSPACE_ID, title: '示例工作区', path: workspaceRoot, missing: false },
      { id: '22222222-2222-4222-8222-222222222222', title: '幽灵工作区', path: path.join(home, 'ghost', '.dsh', 'skills'), missing: true },
    ])

    const global = overview.skills.find(skill => skill.id === 'global/global-skill')
    expect(global).toMatchObject({ name: 'global-skill', description: '全局技能', path: path.join(home, 'skills', 'global-skill'), scope: 'global', disabled: false })
    expect(global?.workspaceId).toBeUndefined()
    expect(global?.workspaceTitle).toBeUndefined()

    const workspaceSkill = overview.skills.find(skill => skill.id === `${WORKSPACE_ID}/ws-skill`)
    expect(workspaceSkill).toMatchObject({
      name: 'ws-skill',
      description: '工作区技能',
      path: path.join(workspaceRoot, 'ws-skill'),
      scope: 'workspace',
      workspaceId: WORKSPACE_ID,
      workspaceTitle: '示例工作区',
      disabled: false,
    })

    const flat = overview.skills.find(skill => skill.id === `${WORKSPACE_ID}/flat-note`)
    expect(flat).toMatchObject({ name: 'flat-note', path: path.join(workspaceRoot, 'flat-note.md'), scope: 'workspace' })
  })
})

describe('workspace skills: 停用与启用', () => {
  it('停用改成 .disabled，启用再改回来，文件不丢', async () => {
    const { workspaceRoot, service } = await makeFixture()
    const id = `${WORKSPACE_ID}/ws-skill`
    const enabledPath = path.join(workspaceRoot, 'ws-skill')

    let overview = await service.setEnabled(id, false)
    let entry = overview.skills.find(skill => skill.id === id)
    expect(entry?.disabled).toBe(true)
    expect(entry?.name).toBe('ws-skill')
    expect(entry?.path).toBe(`${enabledPath}.disabled`)
    expect(await exists(`${enabledPath}.disabled`)).toBe(true)
    expect(await exists(path.join(enabledPath, 'SKILL.md'))).toBe(false)

    overview = await service.setEnabled(id, true)
    entry = overview.skills.find(skill => skill.id === id)
    expect(entry?.disabled).toBe(false)
    expect(entry?.path).toBe(enabledPath)
    expect(await exists(path.join(enabledPath, 'SKILL.md'))).toBe(true)
    expect(await exists(`${enabledPath}.disabled`)).toBe(false)
  })

  it('停用中的旧 id 仍可寻址，重复停用是幂等的', async () => {
    const { service } = await makeFixture()
    const id = `${WORKSPACE_ID}/ws-skill`
    await service.setEnabled(id, false)
    const again = await service.setEnabled(id, false)
    expect(again.skills.find(skill => skill.id === id)?.disabled).toBe(true)
  })

  it('目标位置已存在同名技能时抛中文错误', async () => {
    const home = await makeRoot()
    const globalRoot = path.join(home, 'skills')
    await writeBundle(globalRoot, 'dupe', 'dupe', '启用副本')
    await writeBundle(globalRoot, 'dupe.disabled', 'dupe', '停用副本')
    const service = createWorkspaceSkillsService({ home: () => home })

    const overview = await service.list()
    expect(overview.skills.filter(skill => skill.id === 'global/dupe')).toHaveLength(1)
    expect(overview.skills.find(skill => skill.id === 'global/dupe')?.disabled).toBe(false)

    await expect(service.setEnabled('global/dupe', false)).rejects.toThrow('无法停用技能「dupe」：目标位置已存在同名文件')
  })
})

describe('workspace skills: 删除必须先备份', () => {
  it('删除前把技能目录交给备份区，成功后文件消失', async () => {
    const { workspaceRoot, service } = await makeFixture()
    const id = `${WORKSPACE_ID}/ws-skill`
    const skillPath = path.join(workspaceRoot, 'ws-skill')

    const overview = await service.remove(id)
    expect(backupMock).toHaveBeenCalledTimes(1)
    expect(backupMock).toHaveBeenCalledWith({ paths: [skillPath], label: 'ws-skill', op: 'skill.delete' })
    expect(await exists(skillPath)).toBe(false)
    expect(overview.skills.some(skill => skill.id === id)).toBe(false)
  })

  it('备份失败时中止删除，文件仍在盘上', async () => {
    const { workspaceRoot, service } = await makeFixture()
    const id = `${WORKSPACE_ID}/ws-skill`
    const skillPath = path.join(workspaceRoot, 'ws-skill')
    backupMock.mockRejectedValueOnce(new Error('备份「ws-skill」失败，已阻止删除：磁盘已满'))

    await expect(service.remove(id)).rejects.toThrow('已阻止删除')
    expect(await exists(path.join(skillPath, 'SKILL.md'))).toBe(true)
    const overview = await service.list()
    expect(overview.skills.some(skill => skill.id === id)).toBe(true)
  })
})

describe('workspace skills: 标识校验', () => {
  it('越界 id 与不存在的 id 都被拒绝，且不会碰根目录外的东西', async () => {
    const { home, service } = await makeFixture()
    const outside = path.join(home, 'outside-skill')
    await writeBundle(home, 'outside-skill', 'outside-skill', '根目录外的技能')

    await expect(service.setEnabled(`${WORKSPACE_ID}/../escape`, false)).rejects.toThrow('技能标识无效')
    await expect(service.remove('../../etc/passwd')).rejects.toThrow('技能标识无效')
    await expect(service.remove(`${WORKSPACE_ID}/missing-skill`)).rejects.toThrow('未找到技能')
    await expect(service.remove('no-such-group/x')).rejects.toThrow('未找到技能')
    expect(backupMock).not.toHaveBeenCalled()
    expect(await exists(path.join(outside, 'SKILL.md'))).toBe(true)
  })
})

describe('workspace skills: IPC 装配', () => {
  it('list / reveal / set-enabled / remove 都从 service 走，路径由服务给出', async () => {
    const { workspaceRoot, service } = await makeFixture()
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const removed: string[] = []
    const ipcMain = {
      handle: (channel: string, listener: (...args: unknown[]) => unknown) => { handlers.set(channel, listener) },
      removeHandler: (channel: string) => { removed.push(channel) },
    }
    const revealPath = vi.fn(async () => undefined)
    registerWorkspaceSkillsIpc({ ipcMain: ipcMain as never, service, revealPath })

    expect([...handlers.keys()].sort()).toEqual([
      IPC.workspaceSkillsList,
      IPC.workspaceSkillsRemove,
      IPC.workspaceSkillsReveal,
      IPC.workspaceSkillsSetEnabled,
    ].sort())
    expect(removed).toHaveLength(4)

    const listed = await handlers.get(IPC.workspaceSkillsList)!({}) as WorkspaceSkillsOverview
    expect(listed.workspaces.map(group => group.id)).toEqual(['global', WORKSPACE_ID])

    await handlers.get(IPC.workspaceSkillsReveal)!({}, `${WORKSPACE_ID}/ws-skill`)
    expect(revealPath).toHaveBeenCalledWith(path.join(workspaceRoot, 'ws-skill'))
    await expect(handlers.get(IPC.workspaceSkillsReveal)!({}, 'global/nope')).rejects.toThrow('未找到技能')

    await expect(
      handlers.get(IPC.workspaceSkillsSetEnabled)!({}, { id: `${WORKSPACE_ID}/ws-skill`, enabled: 'yes' }),
    ).rejects.toThrow('技能启用状态无效')

    const toggled = await handlers.get(IPC.workspaceSkillsSetEnabled)!({}, { id: `${WORKSPACE_ID}/ws-skill`, enabled: false }) as WorkspaceSkillsOverview
    expect(toggled.skills.find(skill => skill.id === `${WORKSPACE_ID}/ws-skill`)?.disabled).toBe(true)

    await expect(handlers.get(IPC.workspaceSkillsRemove)!({}, '')).rejects.toThrow('技能标识无效')
  })
})
