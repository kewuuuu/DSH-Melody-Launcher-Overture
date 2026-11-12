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
/** saveHandler 决定 onSave 的返回：返回 false 或一直挂起的 Promise 用来测失败/保存中。 */
async function mount(
  overrides: Partial<AppSettings> = {},
  saveHandler: (next: AppSettings) => boolean | Promise<boolean> = () => true,
) {
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
        onSave={async next => { saved.push(next); return saveHandler(next) }}
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

const loginBox = (container: HTMLElement) => container.querySelector('input[aria-label="随 Windows 登录启动"]') as HTMLInputElement
const loginStatus = (container: HTMLElement) => container.querySelector('.login-item-row .settings-field-status')

it('勾选开机自启立即调用 onSave（不等底部保存），成功后在行内显示已写入登录项', async () => {
  const { container, saved } = await mount()
  const box = loginBox(container)
  expect(box.checked).toBe(false)
  await act(async () => { box.click() })
  await act(async () => {})
  expect(saved).toHaveLength(1)
  expect(saved[0].launchAtLogin).toBe(true)
  expect(saved[0].launchArgs).toEqual(['--port', '3080'])
  expect(box.checked).toBe(true)
  const status = loginStatus(container)
  expect(status?.getAttribute('role')).toBe('status')
  expect(status?.textContent).toContain('已写入登录项')
})

it('取消勾选也立即 onSave，行内显示已移除登录项', async () => {
  const { container, saved } = await mount({ launchAtLogin: true })
  const box = loginBox(container)
  expect(box.checked).toBe(true)
  await act(async () => { box.click() })
  await act(async () => {})
  expect(saved).toHaveLength(1)
  expect(saved[0].launchAtLogin).toBe(false)
  expect(box.checked).toBe(false)
  expect(loginStatus(container)?.textContent).toContain('已移除登录项')
})

it('自启保存失败时复选框回滚到点击前的值，并显示 role=alert 的错误', async () => {
  const { container, saved } = await mount({}, () => false)
  const box = loginBox(container)
  await act(async () => { box.click() })
  await act(async () => {})
  expect(saved).toHaveLength(1)
  expect(box.checked).toBe(false)
  const alert = container.querySelector('.login-item-row .settings-field-error')
  expect(alert?.getAttribute('role')).toBe('alert')
  expect(alert?.textContent).toContain('登录项没有写入')
  expect(loginStatus(container)).toBeNull()
})

it('保存进行中复选框禁用，连点不会发第二次 onSave', async () => {
  let release: ((ok: boolean) => void) | null = null
  const { container, saved } = await mount({}, () => new Promise<boolean>(resolve => { release = resolve }))
  const box = loginBox(container)
  await act(async () => { box.click() })
  expect(box.disabled).toBe(true)
  await act(async () => { box.click() })
  expect(saved).toHaveLength(1)
  await act(async () => { release!(true) })
  expect(box.disabled).toBe(false)
  expect(saved).toHaveLength(1)
})

it('取消更改把草稿恢复成已保存的设置（用只走草稿的关机开关验证）', async () => {
  const { container, saved, button } = await mount()
  const box = shutdownBox(container)
  await act(async () => { box.click() })
  expect(box.checked).toBe(true)
  await act(async () => { button('取消更改').click() })
  await act(async () => {})
  expect(shutdownBox(container).checked).toBe(false)
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
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const ELEVATED_LAUNCH_LABEL = '启动器启动时请求管理员权限'
const elevatedLaunchBox = (container: HTMLElement) => container.querySelector('input[aria-label="' + ELEVATED_LAUNCH_LABEL + '"]') as HTMLInputElement

/** 这一项按 navigator.userAgent 判断平台；临时换成指定 UA，返回恢复函数。 */
function setUserAgent(value: string): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent')
  Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true })
  return () => {
    if (descriptor) Object.defineProperty(window.navigator, 'userAgent', descriptor)
    else delete (window.navigator as unknown as Record<string, unknown>).userAgent
  }
}

it('Windows 下勾选「启动器启动时请求管理员权限」不立即保存，点保存后 onSave 收到 launchElevated: true', async () => {
  const restore = setUserAgent(WINDOWS_UA)
  try {
    const { container, saved, button } = await mount()
    const box = elevatedLaunchBox(container)
    expect(box.disabled).toBe(false)
    expect(box.checked).toBe(false)
    expect(container.textContent).toContain('下次启动启动器时生效')
    expect(container.textContent).toContain('UAC')
    await act(async () => { box.click() })
    expect(box.checked).toBe(true)
    expect(saved).toHaveLength(0)
    await act(async () => { button('保存设置').click() })
    await act(async () => {})
    expect(saved).toHaveLength(1)
    expect(saved[0].launchElevated).toBe(true)
  } finally {
    restore()
  }
})

it('非 Windows 时该开关禁用，并说明仅 Windows 支持', async () => {
  const restore = setUserAgent(LINUX_UA)
  try {
    const { container, saved, button } = await mount()
    const box = elevatedLaunchBox(container)
    expect(box.disabled).toBe(true)
    expect(container.textContent).toContain('仅 Windows 支持')
    await act(async () => { box.click() })
    expect(box.checked).toBe(false)
    await act(async () => { button('保存设置').click() })
    await act(async () => {})
    expect(saved[0].launchElevated).toBeUndefined()
  } finally {
    restore()
  }
})
