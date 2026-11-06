/**
 * 工作区 skill 的 IPC 装配：list / set-enabled / remove / reveal 四个 handler 对应
 * src/constants.ts 的 workspaceSkills* 键。业务逻辑在 workspace-skills.ts。
 *
 * reveal 走注入的 revealPath（main.ts 那边是 shell.showItemInFolder），路径从最新一次
 * list() 里按 id 查出来，绝不让渲染进程自己拼路径。
 */
import type { IpcMain } from 'electron'
import { IPC } from '../src/constants'
import type { WorkspaceSkillsOverview } from '../src/types'
import type { WorkspaceSkillsService } from './workspace-skills'

export interface WorkspaceSkillsIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  service: WorkspaceSkillsService
  revealPath?: (target: string) => Promise<void> | void
}

function register(
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  channel: string,
  handler: (...args: unknown[]) => unknown,
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, handler)
}

function readSkillId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error('技能标识无效。')
  return id
}

export function registerWorkspaceSkillsIpc(deps: WorkspaceSkillsIpcDeps): void {
  register(deps.ipcMain, IPC.workspaceSkillsList, async (): Promise<WorkspaceSkillsOverview> => {
    return deps.service.list()
  })

  register(deps.ipcMain, IPC.workspaceSkillsSetEnabled, async (_event, raw: unknown) => {
    if (typeof raw !== 'object' || raw === null) throw new Error('技能参数无效。')
    const payload = raw as Record<string, unknown>
    const id = readSkillId(payload.id)
    if (typeof payload.enabled !== 'boolean') throw new Error('技能启用状态无效。')
    return deps.service.setEnabled(id, payload.enabled)
  })

  register(deps.ipcMain, IPC.workspaceSkillsRemove, async (_event, id: unknown) => {
    return deps.service.remove(readSkillId(id))
  })

  register(deps.ipcMain, IPC.workspaceSkillsReveal, async (_event, raw: unknown) => {
    const id = readSkillId(raw)
    const current = await deps.service.list()
    const target = current.skills.find(skill => skill.id === id)
    if (!target) throw new Error(`未找到技能：${id}`)
    await deps.revealPath?.(target.path)
  })
}
