// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LauncherApiProvider } from '../api/client'
import type { LauncherApi, LauncherApiEntry, LauncherApiEntryInput } from '../types'
import { ApiLibraryCard } from './ApiLibraryCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })

const openaiEntry: LauncherApiEntry = {
  route: 'library-openai',
  displayName: 'OpenAI 官方',
  baseUrl: 'https://api.openai.com/v1',
  protocol: 'openai-completions',
  modelIds: ['gpt-5', 'gpt-5-mini'],
  hasApiKey: true,
}

/** 假的 API 库：维护内存条目并记录每次 save/remove 的入参。 */
async function mount(initial: LauncherApiEntry[]) {
  const entries = { current: initial }
  const saves: LauncherApiEntryInput[] = []
  const removes: string[] = []
  const api = {
    apiLibrary: {
      list: async () => entries.current,
      save: async (input: LauncherApiEntryInput) => {
        saves.push(input)
        const previous = entries.current.find(item => item.route === (input.originalRoute ?? input.route))
        entries.current = [
          ...entries.current.filter(item => item.route !== (input.originalRoute ?? input.route) && item.route !== input.route),
          {
            route: input.route,
            displayName: input.displayName,
            baseUrl: input.baseUrl,
            protocol: input.protocol,
            modelIds: input.modelIds,
            hasApiKey: Boolean(input.apiKey) || Boolean(previous?.hasApiKey),
          },
        ]
        return entries.current
      },
      remove: async (route: string) => {
        removes.push(route)
        entries.current = entries.current.filter(item => item.route !== route)
        return entries.current
      },
    },
  } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<LauncherApiProvider value={api}><ApiLibraryCard /></LauncherApiProvider>) })
  await act(async () => {})
  const button = (label: string) => {
    const found = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes(label))
    expect(found, '按钮不存在：' + label).toBeTruthy()
    return found as HTMLButtonElement
  }
  const click = async (label: string) => {
    await act(async () => { button(label).click() })
    await act(async () => {})
  }
  const field = (label: string) => {
    const found = Array.from(container.querySelectorAll('label.form-field')).find(item => item.querySelector('span')?.textContent === label)
    expect(found, '字段不存在：' + label).toBeTruthy()
    return found!.querySelector('input, select') as HTMLInputElement
  }
  const fill = async (label: string, value: string) => {
    const input = field(label)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  return { container, saves, removes, button, click, field, fill }
}

it('空态给出引导文案，新增时把表单内容交给 save 且不下发空密钥', async () => {
  const { container, saves, click, fill } = await mount([])
  expect(container.textContent).toContain('还没有登记任何 API')
  await click('新增 API')
  await fill('显示名称', 'OpenAI 官方')
  await fill('路由', 'library-openai')
  await fill('Base URL', 'https://api.openai.com/v1')
  await fill('模型 ID', 'gpt-5, gpt-5-mini')
  await click('添加到 API 库')
  expect(saves).toHaveLength(1)
  expect(saves[0].route).toBe('library-openai')
  expect(saves[0].modelIds).toEqual(['gpt-5', 'gpt-5-mini'])
  expect('apiKey' in saves[0]).toBe(false)
  expect('originalRoute' in saves[0]).toBe(false)
  expect(container.textContent).toContain('2 个模型')
  expect(container.textContent).toContain('无需鉴权')
})

it('路由不合规时用中文提示拦住提交', async () => {
  const { container, saves, click, fill } = await mount([])
  await click('新增 API')
  await fill('显示名称', 'OpenAI 官方')
  await fill('路由', 'Library_OpenAI')
  await fill('Base URL', 'https://api.openai.com/v1')
  await fill('模型 ID', 'gpt-5')
  await click('添加到 API 库')
  expect(saves).toHaveLength(0)
  const alert = container.querySelector('.api-library-error')
  expect(alert?.getAttribute('role')).toBe('alert')
  expect(alert?.textContent).toContain('路由只能用小写字母、数字和单个连字符')
})

it('编辑时密钥留空即保留原密钥，密码框不回显明文', async () => {
  const { container, saves, click, fill } = await mount([openaiEntry])
  await click('编辑')
  const key = Array.from(container.querySelectorAll('input')).find(item => item.type === 'password') as HTMLInputElement
  expect(key).toBeTruthy()
  expect(key.value).toBe('')
  expect(container.textContent).not.toContain('sk-')
  await fill('显示名称', 'OpenAI 官方（内网代理）')
  await click('保存修改')
  expect(saves).toHaveLength(1)
  expect(saves[0].originalRoute).toBe('library-openai')
  expect('apiKey' in saves[0]).toBe(false)
  expect(saves[0].displayName).toBe('OpenAI 官方（内网代理）')
  expect(container.textContent).toContain('已保存密钥')
})

it('删除需要二次确认，确认后调用 remove 并回到空态', async () => {
  const { container, removes, click } = await mount([openaiEntry])
  const trash = container.querySelector('button[aria-label="删除 OpenAI 官方"]') as HTMLButtonElement
  expect(trash).toBeTruthy()
  await act(async () => { trash.click() })
  await act(async () => {})
  expect(removes).toHaveLength(0)
  expect(container.textContent).toContain('确认删除')
  await click('确认删除')
  expect(removes).toEqual(['library-openai'])
  expect(container.textContent).toContain('还没有登记任何 API')
})
