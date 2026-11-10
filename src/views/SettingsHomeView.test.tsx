// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LauncherApiProvider } from '../api/client'
import type { AppSettings, AppearanceSettings, LauncherApi, LauncherApiEntry, StorageState } from '../types'
import { SettingsHomeView } from './SettingsHomeView'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })

const storageState: StorageState = {
  dataDir: 'D:\\launcher-data',
  source: 'portable',
  portableDir: 'D:\\launcher-data',
  pointerFile: null,
  legacy: { dataDir: 'C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher', hasData: false },
  restartRequired: false,
  warning: null,
}

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    dshInstallPath: 'D:\\DSH',
    dshHome: 'D:\\DSH_HOME',
    workspace: 'D:\\work',
    profileName: 'default',
    launchExecutable: 'dsh',
    launchArgs: ['--port', '3080'],
    webPort: 3080,
    openAfterLaunch: false,
    launchAtLogin: false,
    ...overrides,
  }
}

/** 挂载整页设置：外观与 API 库都会去读接口，存储位置卡片读 storage。 */
async function mount(overrides: Partial<AppSettings> = {}) {
  const saved: AppSettings[] = []
  const previews: Array<AppearanceSettings | null> = []
  const api = {
    storage: {
      get: async () => storageState,
      choose: async () => null,
      reset: async () => storageState,
      relaunch: async () => undefined,
    },
    apiLibrary: {
      list: async () => [] as LauncherApiEntry[],
      save: async () => [] as LauncherApiEntry[],
      remove: async () => [] as LauncherApiEntry[],
    },
    chooseDirectory: async () => null,
    chooseAppearanceImage: async () => null,
  } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<LauncherApiProvider value={api}>
      <SettingsHomeView
        settings={baseSettings(overrides)}
        busy={false}
        onSave={async next => { saved.push(next); return true }}
        onPreview={next => previews.push(next)}
        onCheckUpdate={() => {}}
        onOpenPath={() => {}}
        onOpenDshFolder={() => {}}
      />
    </LauncherApiProvider>)
  })
  await act(async () => {})
  const button = (label: string) => {
    const found = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes(label))
    expect(found, '按钮不存在：' + label).toBeTruthy()
    return found as HTMLButtonElement
  }
  return { container, saved, previews, root, button }
}

it('按外观→启动器→存储位置→API 库→网络→关于的顺序渲染各区块', async () => {
  const { container } = await mount()
  const labels = Array.from(container.querySelectorAll('section[aria-label]')).map(item => item.getAttribute('aria-label'))
  for (const label of ['外观', '启动器', '存储位置', 'API 库', '网络', '关于']) {
    expect(labels, '缺少区块：' + label).toContain(label)
  }
  expect(labels.indexOf('外观')).toBeLessThan(labels.indexOf('启动器'))
  expect(labels.indexOf('启动器')).toBeLessThan(labels.indexOf('存储位置'))
  expect(labels.indexOf('存储位置')).toBeLessThan(labels.indexOf('API 库'))
  expect(labels.indexOf('API 库')).toBeLessThan(labels.indexOf('网络'))
  expect(labels.indexOf('网络')).toBeLessThan(labels.indexOf('关于'))
  expect(container.textContent).toContain('随 Windows 登录启动')
  expect(container.textContent).toContain('启动器图标')
  expect(container.textContent).toContain('启动器版本')
})

it('勾选开机自启后保存，onSave 收到 launchAtLogin: true', async () => {
  const { container, saved, button } = await mount()
  const box = container.querySelector('input[aria-label="随 Windows 登录启动"]') as HTMLInputElement
  expect(box).toBeTruthy()
  expect(box.checked).toBe(false)
  await act(async () => { box.click() })
  await act(async () => { button('保存设置').click() })
  await act(async () => {})
  expect(saved).toHaveLength(1)
  expect(saved[0].launchAtLogin).toBe(true)
  expect(saved[0].launchArgs).toEqual(['--port', '3080'])
})

it('取消更改把草稿恢复成已保存的设置', async () => {
  const { container, saved, button } = await mount()
  const box = container.querySelector('input[aria-label="随 Windows 登录启动"]') as HTMLInputElement
  await act(async () => { box.click() })
  expect(box.checked).toBe(true)
  await act(async () => { button('取消更改').click() })
  await act(async () => {})
  expect((container.querySelector('input[aria-label="随 Windows 登录启动"]') as HTMLInputElement).checked).toBe(false)
  expect(saved).toHaveLength(0)
})
const ELEVATED_STOP_LABEL = '停止提权整合包时允许弹出一次管理员权限请求'
const elevatedStopBox = (container: HTMLElement) => container.querySelector('input[aria-label="' + ELEVATED_STOP_LABEL + '"]') as HTMLInputElement

it('默认允许弹一次提权停止请求，关闭后显示为未勾选', async () => {
  const byDefault = await mount()
  expect(elevatedStopBox(byDefault.container).checked).toBe(true)
  expect(byDefault.container.textContent).toContain('在监督进程不在时只能靠提权结束')
  const turnedOff = await mount({ elevatedStopPrompt: false })
  expect(elevatedStopBox(turnedOff.container).checked).toBe(false)
})

const shutdownBox = (container: HTMLElement) => container.querySelector('input[aria-label="任务完成后自动关机"]') as HTMLInputElement
const idleInput = (container: HTMLElement) => container.querySelector('input[aria-label="空闲判定（分钟）"]') as HTMLInputElement
const graceInput = (container: HTMLElement) => container.querySelector('input[aria-label="关机前等待取消（分钟）"]') as HTMLInputElement
const stopPacksBox = (container: HTMLElement) => container.querySelector('input[aria-label="关机前先停止所有整合包"]') as HTMLInputElement

/** React 19 的 onChange 由原生 input 事件驱动；用原型 setter 绕过 value 追踪器，才能模拟用户真打字。 */
function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

it('四个关机字段按已保存设置回填，默认是关闭 + 10 + 10 + 勾选停止整合包', async () => {
  const custom = await mount({ shutdownWhenIdle: true, shutdownIdleMinutes: 25, shutdownGraceMinutes: 0, shutdownStopPacks: false })
  expect(shutdownBox(custom.container).checked).toBe(true)
  expect(idleInput(custom.container).value).toBe('25')
  expect(graceInput(custom.container).value).toBe('0')
  expect(custom.container.textContent).toContain('不等待，立即关机')
  expect(stopPacksBox(custom.container).checked).toBe(false)

  const defaults = await mount()
  expect(shutdownBox(defaults.container).checked).toBe(false)
  expect(idleInput(defaults.container).value).toBe('10')
  expect(graceInput(defaults.container).value).toBe('10')
  expect(stopPacksBox(defaults.container).checked).toBe(true)
  expect(defaults.container.textContent).not.toContain('不等待，立即关机')
})

it('分钟数越界只在行内报错，不写进草稿；合法值与两个开关照常保存', async () => {
  const { container, saved, button } = await mount()
  await act(async () => { setInputValue(idleInput(container), '2000') })
  await act(async () => { setInputValue(graceInput(container), '61') })
  const errors = Array.from(container.querySelectorAll('.settings-field-error'))
  expect(errors.every(item => item.getAttribute('role') === 'alert')).toBe(true)
  expect(errors.map(item => item.textContent).join('|')).toContain('1–1440')
  expect(errors.map(item => item.textContent).join('|')).toContain('0–60')
  await act(async () => { button('保存设置').click() })
  await act(async () => {})
  expect(saved).toHaveLength(1)
  expect(saved[0].shutdownIdleMinutes).toBeUndefined()
  expect(saved[0].shutdownGraceMinutes).toBeUndefined()

  await act(async () => { setInputValue(idleInput(container), '45') })
  await act(async () => { setInputValue(graceInput(container), '0') })
  expect(container.querySelectorAll('.settings-field-error')).toHaveLength(0)
  await act(async () => { shutdownBox(container).click() })
  await act(async () => { stopPacksBox(container).click() })
  await act(async () => { button('保存设置').click() })
  await act(async () => {})
  expect(saved).toHaveLength(2)
  expect(saved[1].shutdownIdleMinutes).toBe(45)
  expect(saved[1].shutdownGraceMinutes).toBe(0)
  expect(saved[1].shutdownWhenIdle).toBe(true)
  expect(saved[1].shutdownStopPacks).toBe(false)
  expect(container.textContent).toContain('不等待，立即关机')
})

it('勾掉提权停止提示后，保存的草稿里 elevatedStopPrompt 为 false', async () => {
  const { container, saved, button } = await mount()
  const box = elevatedStopBox(container)
  await act(async () => { box.click() })
  expect(box.checked).toBe(false)
  await act(async () => { button('保存设置').click() })
  await act(async () => {})
  expect(saved).toHaveLength(1)
  expect(saved[0].elevatedStopPrompt).toBe(false)
})
