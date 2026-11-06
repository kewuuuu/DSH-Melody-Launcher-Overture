// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LauncherApiProvider } from '../../api/client'
import type { LauncherApi, WorkspaceSkillsOverview } from '../../types'
import { WorkspaceSkillsPanel, groupSkills } from './WorkspaceSkillsPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })

const sample = (): WorkspaceSkillsOverview => ({
  skills: [
    { id: 'global:wksp-rules', name: 'wksp-rules', description: '全局落盘规则', path: 'D:\\DSH_HOME\\skills\\wksp-rules\\SKILL.md', scope: 'global', disabled: false },
    { id: 'ws:w1:wksp-rules', name: 'wksp-rules', description: '工作区里的同名规则', path: 'D:\\a\\.dsh\\skills\\wksp-rules\\SKILL.md', scope: 'workspace', workspaceId: 'w1', workspaceTitle: '项目甲', disabled: false },
    { id: 'ws:w2:notes', name: 'notes', path: 'D:\\b\\.dsh\\skills\\notes\\SKILL.md', scope: 'workspace', workspaceId: 'w2', workspaceTitle: '项目乙', disabled: true },
  ],
  workspaces: [
    { id: 'w1', title: '项目甲', path: 'D:\\a', missing: false },
    { id: 'w2', title: '项目乙', path: 'D:\\b', missing: true },
  ],
})

type Call = { name: string; args: unknown[] }

async function mount(seed: WorkspaceSkillsOverview = sample()) {
  const calls: Call[] = []
  let current = seed
  const api = {
    workspaceSkills: {
      list: async () => { calls.push({ name: 'list', args: [] }); return current },
      setEnabled: async (id: string, enabled: boolean) => {
        calls.push({ name: 'setEnabled', args: [id, enabled] })
        current = { ...current, skills: current.skills.map(item => (item.id === id ? { ...item, disabled: !enabled } : item)) }
        return current
      },
      remove: async (id: string) => {
        calls.push({ name: 'remove', args: [id] })
        current = { ...current, skills: current.skills.filter(item => item.id !== id) }
        return current
      },
      reveal: async (id: string) => { calls.push({ name: 'reveal', args: [id] }) },
    },
  } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<LauncherApiProvider value={api}><WorkspaceSkillsPanel /></LauncherApiProvider>) })
  await act(async () => {})
  const groups = () => Array.from(container.querySelectorAll('.workspace-skill-group')) as HTMLElement[]
  const rowOf = (text: string) => {
    const found = (Array.from(container.querySelectorAll('.workspace-skill-row')) as HTMLElement[])
      .find(item => (item.textContent ?? '').includes(text))
    expect(found, '找不到 skill 行：' + text).toBeTruthy()
    return found as HTMLElement
  }
  const buttonIn = (scope: HTMLElement, label: string) => {
    const found = Array.from(scope.querySelectorAll('button'))
      .find(item => (item.textContent ?? '').replace(/\s+/g, '') === label)
    expect(found, '按钮不存在：' + label).toBeTruthy()
    return found as HTMLButtonElement
  }
  return { container, calls, groups, rowOf, buttonIn }
}

it('按全局与各工作区分组，缺失工作区标灰并给出提示', async () => {
  const { container, groups } = await mount()
  expect(groups().map(item => item.getAttribute('aria-label'))).toEqual(['全局 skill', '项目甲 skill', '项目乙 skill'])
  expect(groups()[0].className).not.toContain('is-missing')
  expect(groups()[2].className).toContain('is-missing')
  expect(groups()[2].textContent).toContain('工作区路径不存在')
  expect(groupSkills(sample()).map(item => item.title)).toEqual(['全局', '项目甲', '项目乙'])
  const sources = Array.from(container.querySelectorAll('.workspace-skill-source')).map(item => item.textContent)
  expect(sources).toEqual(['全局', '项目甲', '项目乙'])
  const rows = Array.from(container.querySelectorAll('.workspace-skill-row')) as HTMLElement[]
  expect(rows.filter(item => (item.textContent ?? '').includes('wksp-rules'))).toHaveLength(2)
})

it('删除要两步确认，确认后对同名工作区 skill 调 remove', async () => {
  const { container, calls, rowOf, buttonIn } = await mount()
  await act(async () => { buttonIn(rowOf('工作区里的同名规则'), '删除').click() })
  expect(container.textContent).toContain('删除会进备份')
  expect(calls.some(item => item.name === 'remove')).toBe(false)
  await act(async () => { buttonIn(rowOf('工作区里的同名规则'), '确认删除').click() })
  await act(async () => {})
  expect(calls.find(item => item.name === 'remove')?.args).toEqual(['ws:w1:wksp-rules'])
  expect(container.textContent).not.toContain('工作区里的同名规则')
})

it('停用按钮把已启用的全局 skill 交给 setEnabled 并切换成已停用', async () => {
  const { container, calls, rowOf, buttonIn } = await mount()
  await act(async () => { buttonIn(rowOf('全局落盘规则'), '停用').click() })
  await act(async () => {})
  expect(calls.find(item => item.name === 'setEnabled')?.args).toEqual(['global:wksp-rules', false])
  const row = rowOf('全局落盘规则')
  expect(row.textContent).toContain('已停用')
  expect(buttonIn(row, '启用')).toBeTruthy()
})
