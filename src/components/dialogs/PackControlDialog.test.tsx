// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LauncherApiProvider } from '../../api/client'
import type { ControlledPack } from '../../lib/pack-control'
import type { LauncherApi, PackApiGrantState } from '../../types'
import { PackControlDialog } from './PackControlDialog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })

const pack: ControlledPack = {
  id: 'pack-a',
  name: '工作包',
  description: '测试用的整合包',
  version: '1.0.0',
  dshVersion: null,
  source: 'local',
  enabled: true,
  state: 'complete',
  plugins: [],
  installedAt: '2026-01-01T00:00:00.000Z',
  config: { portMode: 'auto', port: 3080, runAsAdmin: false, autoStart: false, pinnedAt: null },
  runtime: { running: true, pid: 4242, startedAt: null, url: null, port: 3080 },
} as unknown as ControlledPack

const openaiEntry = {
  route: 'library-openai',
  displayName: 'OpenAI 官方',
  baseUrl: 'https://api.openai.com/v1',
  protocol: 'openai-completions' as const,
  modelIds: ['gpt-5', 'gpt-5-mini'],
  hasApiKey: true,
}

function grantState(overrides: Partial<PackApiGrantState> = {}): PackApiGrantState {
  return { packId: 'pack-a', enabled: [], available: [openaiEntry], restartRequired: false, error: null, ...overrides }
}

/** 假的 packApis 接口：记录每次 get/set 的 packId，set 会写回状态。 */
async function mount(
  initial: PackApiGrantState,
  setImpl?: (packId: string, route: string, enabled: boolean) => Promise<PackApiGrantState>,
  options: { pack?: ControlledPack; onUpgradeVersion?: (version: string) => Promise<boolean> } = {},
) {
  const gets: string[] = []
  const sets: Array<{ packId: string; route: string; enabled: boolean }> = []
  const renames: Array<[string, string]> = []
  const opened: string[] = []
  let state = initial
  const api = {
    renamePack: async (packId: string, name: string) => { renames.push([packId, name]); return { ...(options.pack ?? pack), name } },
    openPath: async (path: string) => { opened.push(path) },
    packApis: {
      get: async (packId: string) => { gets.push(packId); return state },
      set: async (packId: string, route: string, enabled: boolean) => {
        sets.push({ packId, route, enabled })
        if (setImpl) { state = await setImpl(packId, route, enabled); return state }
        state = { ...state, enabled: enabled ? [...state.enabled, route] : state.enabled.filter(item => item !== route), restartRequired: true }
        return state
      },
    },
  } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<LauncherApiProvider value={api}>
      <PackControlDialog
        pack={options.pack ?? pack}
        installedDshVersions={['1.0', '1.1']}
        onUpgradeVersion={options.onUpgradeVersion ?? (async () => true)}
        busy={false}
        onClose={() => {}}
        onSave={async () => true}
        onRefresh={async () => {}}
        onExport={() => {}}
        onImportSessions={() => {}}
        onCloneVersion={() => {}}
      />
    </LauncherApiProvider>)
  })
  await act(async () => {})
  const openTab = async (label: string) => {
    const found = Array.from(container.querySelectorAll('.pack-config-tabs button')).find(item => item.textContent === label)
    expect(found, label + ' 子页按钮不存在').toBeTruthy()
    await act(async () => { (found as HTMLButtonElement).click() })
    await act(async () => {})
  }
  const openApiTab = () => openTab('API')
  const openSettingsTab = () => openTab('启动设置')
  return { container, gets, sets, renames, opened, openTab, openApiTab, openSettingsTab }
}

const buttonByText = (container: HTMLElement, text: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === text) as HTMLButtonElement | undefined

it('API 子页只按当前整合包的 packId 读取与授予，库内条目带来源标记', async () => {
  const { container, gets, sets, openApiTab } = await mount(grantState())
  await openApiTab()
  expect(gets).toEqual(['pack-a'])
  const row = container.querySelector('.pack-resource-row')
  expect(row?.className).toContain('is-shared')
  expect(row?.textContent).toContain('来自启动器 API 库 · library-openai')
  expect(row?.textContent).toContain('2 个模型')
  const box = container.querySelector('input[aria-label="授予 library-openai"]') as HTMLInputElement
  expect(box).toBeTruthy()
  expect(box.checked).toBe(false)
  await act(async () => { box.click() })
  await act(async () => {})
  expect(sets).toEqual([{ packId: 'pack-a', route: 'library-openai', enabled: true }])
  expect((container.querySelector('input[aria-label="授予 library-openai"]') as HTMLInputElement).checked).toBe(true)
})

it('授予后 restartRequired 时提示重启后生效', async () => {
  const { container, openApiTab } = await mount(grantState())
  await openApiTab()
  expect(container.textContent).not.toContain('该包正在运行，重启后生效。')
  const box = container.querySelector('input[aria-label="授予 library-openai"]') as HTMLInputElement
  await act(async () => { box.click() })
  await act(async () => {})
  const notice = Array.from(container.querySelectorAll('[role="status"]')).find(item => item.textContent?.includes('该包正在运行，重启后生效。'))
  expect(notice).toBeTruthy()
})

it('授予失败时以 role=alert 显示中文错误', async () => {
  const { container, openApiTab } = await mount(grantState(), async () => { throw new Error('授予失败：该包正在运行。') })
  await openApiTab()
  const box = container.querySelector('input[aria-label="授予 library-openai"]') as HTMLInputElement
  await act(async () => { box.click() })
  await act(async () => {})
  const alert = container.querySelector('.pack-error')
  expect(alert?.getAttribute('role')).toBe('alert')
  expect(alert?.textContent).toContain('授予失败：该包正在运行。')
})

it('接口返回的 error 直接显示，库为空时引导去设置里添加', async () => {
  const { container, openApiTab } = await mount(grantState({ available: [], error: '启动器 API 库读取失败。' }))
  await openApiTab()
  const alert = container.querySelector('.pack-error')
  expect(alert?.getAttribute('role')).toBe('alert')
  expect(alert?.textContent).toContain('启动器 API 库读取失败。')
  expect(container.textContent).toContain('「设置 → API 库」')
})

it('运行中时「切换版本」按钮禁用并提示先停止', async () => {
  const { container, openSettingsTab } = await mount(grantState())
  await openSettingsTab()
  expect(container.textContent).toContain('只能升级不能降级；切换后插件可能需要重新安装。')
  const hint = Array.from(container.querySelectorAll('[role="status"]')).find(item => item.textContent?.includes('整合包正在运行，停止后才能切换版本。'))
  expect(hint, '运行中提示缺失').toBeTruthy()
  const switchButton = buttonByText(container, '切换版本')
  expect(switchButton, '「切换版本」按钮不存在').toBeTruthy()
  expect(switchButton!.disabled).toBe(true)
})

it('停止后切换版本会带着目标版本升级并提示已切换', async () => {
  const calls: string[] = []
  const stopped = { ...pack, runtime: { running: false, pid: null, startedAt: null, url: null, port: 3080 } } as unknown as ControlledPack
  const { container, openSettingsTab } = await mount(grantState(), undefined, {
    pack: stopped,
    onUpgradeVersion: async (version: string) => { calls.push(version); return true },
  })
  await openSettingsTab()
  const select = container.querySelector('select[aria-label="目标 DSH 版本"]') as HTMLSelectElement
  expect(Array.from(select.options).map(option => option.value)).toEqual(['1.0', '1.1'])
  const switchButton = buttonByText(container, '切换版本')
  expect(switchButton!.disabled).toBe(false)
  await act(async () => { switchButton!.click() })
  await act(async () => {})
  expect(calls).toEqual(['1.0'])
  expect(container.textContent).toContain('已切换到 DSH 1.0，下次启动生效。')
})

/** 运行时记录的 homePath 只有主进程会下发，测试里按它的真实形状补上。 */
const packAt = (homePath: string | null): ControlledPack => ({ ...pack, homePath }) as unknown as ControlledPack

function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

it('「改名」行内输入后 Enter 提交，调用 renamePack 并显示新名字', async () => {
  const { container, renames } = await mount(grantState(), undefined, { pack: packAt('D:\\packs\\pack-a') })
  const rename = buttonByText(container, '改名')
  expect(rename, '「改名」按钮不存在').toBeTruthy()
  await act(async () => { rename!.click() })
  const input = container.querySelector('input[aria-label="整合包名称"]') as HTMLInputElement
  expect(input, '行内输入框不存在').toBeTruthy()
  await act(async () => { typeInto(input, '  新名字  ') })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await act(async () => {})
  expect(renames).toEqual([['pack-a', '新名字']])
  expect(container.textContent).toContain('整合包配置 · 新名字')
  expect(container.querySelector('input[aria-label="整合包名称"]')).toBeNull()
})

it('改名输入按 Esc 取消，不发请求', async () => {
  const { container, renames } = await mount(grantState(), undefined, { pack: packAt('D:\\packs\\pack-a') })
  await act(async () => { buttonByText(container, '改名')!.click() })
  const input = container.querySelector('input[aria-label="整合包名称"]') as HTMLInputElement
  await act(async () => { typeInto(input, '改了一半') })
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  expect(renames).toHaveLength(0)
  expect(container.querySelector('input[aria-label="整合包名称"]')).toBeNull()
  expect(container.textContent).toContain('整合包配置 · 工作包')
})

it('「打开文件夹」调用 openPath(pack.homePath)，homePath 为空时禁用并给出 title', async () => {
  const withPath = await mount(grantState(), undefined, { pack: packAt('D:\\packs\\pack-a') })
  const openButton = buttonByText(withPath.container, '打开文件夹')
  expect(openButton, '「打开文件夹」按钮不存在').toBeTruthy()
  expect(openButton!.disabled).toBe(false)
  await act(async () => { openButton!.click() })
  await act(async () => {})
  expect(withPath.opened).toEqual(['D:\\packs\\pack-a'])

  const withoutPath = await mount(grantState(), undefined, { pack: packAt(null) })
  const disabled = buttonByText(withoutPath.container, '打开文件夹')!
  expect(disabled.disabled).toBe(true)
  expect(disabled.getAttribute('title')).toContain('没有记录安装目录')
  await act(async () => { disabled.click() })
  expect(withoutPath.opened).toHaveLength(0)
})

it('运行中时插件与技能子页顶部提示下次启动生效，且不阻塞安装', async () => {
  for (const label of ['插件', '技能']) {
    const { container, openTab } = await mount(grantState(), undefined, { pack: packAt('D:\\packs\\pack-a') })
    await openTab(label)
    const notice = container.querySelector('.pack-runtime-notice')
    expect(notice, label + ' 子页缺少运行中提示').toBeTruthy()
    expect(notice!.textContent).toContain('整合包正在运行：这里的开关与安装会在下次启动时生效。')
    expect(buttonByText(container, '安装' + label)!.disabled).toBe(false)
  }
})

it('库为空且无错误时只显示引导文案', async () => {
  const { container, openApiTab } = await mount(grantState({ available: [] }))
  await openApiTab()
  expect(container.querySelector('.pack-error')).toBeNull()
  expect(container.textContent).toContain('启动器 API 库还是空的')
})
