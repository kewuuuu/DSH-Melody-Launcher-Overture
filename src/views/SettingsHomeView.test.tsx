// @vitest-environment jsdom
import { act, useState } from 'react'
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

/** 自动保存的防抖窗口是 600ms：等 700ms，让计时器、写盘与状态更新都走完。 */
const settle = async (ms = 700) => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
}

interface MountOptions {
  overrides?: Partial<AppSettings>
  /** onSave 的返回：false = 主进程拒绝；挂起的 Promise 用来测「写盘途中」。 */
  saveHandler?: (next: AppSettings) => boolean | Promise<boolean>
  /** 保存成功后把 payload 当成新的已保存设置回灌，模拟真实 App 里 settings prop 跟着更新。 */
  echoSettings?: boolean
}

/** 挂载整页设置：外观与 API 库都会去读接口，存储位置卡片读 storage。 */
async function mount(options: MountOptions = {}) {
  const saved: AppSettings[] = []
  const previews: Array<AppearanceSettings | null> = []
  const saveHandler = options.saveHandler ?? (() => true)
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

  // 用一层 state 包住 settings：写盘成功后把它当新的 prop 传回去，跟 App 的真实行为一致。
  function Harness() {
    const [settings, setSettings] = useState(() => baseSettings(options.overrides))
    return <SettingsHomeView
      settings={settings}
      busy={false}
      onSave={async next => {
        saved.push(next)
        const ok = await saveHandler(next)
        if (ok && options.echoSettings) setSettings(next)
        return ok
      }}
      onPreview={next => previews.push(next)}
      onCheckUpdate={() => {}}
      onOpenPath={() => {}}
      onOpenDshFolder={() => {}}
    />
  }

  await act(async () => {
    root.render(<LauncherApiProvider value={api}><Harness /></LauncherApiProvider>)
  })
  await act(async () => {})
  const button = (label: string) => {
    const found = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes(label))
    expect(found, '按钮不存在：' + label).toBeTruthy()
    return found as HTMLButtonElement
  }
  /** 卸载这一页：顺手把它从 afterEach 的待卸列表里摘掉，免得同一个 root 卸两次。 */
  const unmount = async () => {
    const index = roots.indexOf(root)
    if (index >= 0) roots.splice(index, 1)
    await act(async () => root.unmount())
  }
  return { container, saved, previews, root, button, unmount }
}

const statusLine = (container: HTMLElement) => container.querySelector('.settings-home-actions-hint')

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

it('页面上没有「保存设置 / 取消更改」按钮，底部只留一行自动保存状态', async () => {
  const { container } = await mount()
  const labels = Array.from(container.querySelectorAll('button')).map(item => item.textContent ?? '')
  expect(labels.some(item => item.includes('保存设置')), '不该再有保存按钮').toBe(false)
  expect(labels.some(item => item.includes('取消更改')), '不该再有取消按钮').toBe(false)
  expect(container.textContent).toContain('改完即自动保存')
  expect(statusLine(container)?.getAttribute('role')).toBe('status')
  expect(statusLine(container)?.getAttribute('aria-live')).toBe('polite')
})

it('改一个字段、不点任何按钮就自动写盘，状态变成「已自动保存 · 刚刚」', async () => {
  const { container, saved } = await mount()
  await act(async () => { stopPacksBox(container).click() })
  // 防抖窗口内一个字节都还没写。
  expect(saved).toHaveLength(0)
  expect(statusLine(container)?.textContent).toContain('正在自动保存')
  await settle()
  expect(saved).toHaveLength(1)
  expect(saved[0].shutdownStopPacks).toBe(false)
  expect(statusLine(container)?.textContent).toContain('已自动保存')
  expect(statusLine(container)?.textContent).toContain('刚刚')
})

it('连续改两个字段只写一次盘：防抖把同一批改动合并成一次 onSave', async () => {
  const { container, saved } = await mount()
  await act(async () => { stopPacksBox(container).click() })
  await settle(200)
  await act(async () => { shutdownBox(container).click() })
  expect(saved).toHaveLength(0)
  await settle()
  expect(saved).toHaveLength(1)
  expect(saved[0].shutdownStopPacks).toBe(false)
  expect(saved[0].shutdownWhenIdle).toBe(true)
})

it('保存失败时显示中文错误、草稿一个字不丢，点「重试保存」就再写一次', async () => {
  let attempts = 0
  const { container, saved, button } = await mount({
    saveHandler: () => { attempts += 1; return attempts > 1 },
  })
  await act(async () => { stopPacksBox(container).click() })
  await settle()
  expect(saved).toHaveLength(1)
  const alert = container.querySelector('.settings-save-error')
  expect(alert?.getAttribute('role')).toBe('alert')
  expect(alert?.textContent).toContain('自动保存失败')
  // 草稿还在：复选框仍是用户点过的那个值，不是磁盘上的旧值。
  expect(stopPacksBox(container).checked).toBe(false)
  expect(statusLine(container)?.textContent).toContain('自动保存失败')
  await act(async () => { button('重试保存').click() })
  await settle(20)
  expect(saved).toHaveLength(2)
  expect(saved[1].shutdownStopPacks).toBe(false)
  expect(container.querySelector('.settings-save-error')).toBeNull()
  expect(statusLine(container)?.textContent).toContain('已自动保存')
})

it('写盘回来的设置不会冲掉正在输入的草稿，攒下的改动随后补写一次', async () => {
  let release: ((ok: boolean) => void) | null = null
  let calls = 0
  const { container, saved } = await mount({
    echoSettings: true,
    saveHandler: () => {
      calls += 1
      if (calls === 1) return new Promise<boolean>(resolve => { release = resolve })
      return true
    },
  })
  const input = fieldInput(container, '工作区')
  await act(async () => { setInputValue(input, 'D:\\a') })
  await settle()
  expect(saved).toHaveLength(1)
  // 写盘还没回来，用户继续敲了两个字符。
  await act(async () => { setInputValue(input, 'D:\\ab') })
  await act(async () => { release!(true) })
  await settle(20)
  expect(fieldInput(container, '工作区').value).toBe('D:\\ab')
  expect(saved).toHaveLength(2)
  expect(saved[1].workspace).toBe('D:\\ab')
})

it('没落盘就离开设置页：卸载时立刻 flush，改动不丢', async () => {
  const { container, saved, unmount } = await mount()
  await act(async () => { stopPacksBox(container).click() })
  expect(saved).toHaveLength(0)
  await unmount()
  expect(saved).toHaveLength(1)
  expect(saved[0].shutdownStopPacks).toBe(false)
})

it('路径类输入不逐字符写盘：连打三次只写一次，最后落的是完整内容', async () => {
  const { container, saved } = await mount()
  const input = fieldInput(container, '工作区')
  await act(async () => { setInputValue(input, 'D:\\w') })
  await settle(120)
  await act(async () => { setInputValue(input, 'D:\\wo') })
  await settle(120)
  await act(async () => { setInputValue(input, 'D:\\work2') })
  // 打字期间一次都没写盘。
  expect(saved).toHaveLength(0)
  await settle()
  expect(saved).toHaveLength(1)
  expect(saved[0].workspace).toBe('D:\\work2')
})

const loginBox = (container: HTMLElement) => container.querySelector('input[aria-label="随 Windows 登录启动"]') as HTMLInputElement
const loginStatus = (container: HTMLElement) => container.querySelector('.login-item-row .settings-field-status')

it('勾选开机自启立即调用 onSave（不等防抖），成功后在行内显示已写入登录项', async () => {
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
  const { container, saved } = await mount({ overrides: { launchAtLogin: true } })
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
  const { container, saved } = await mount({ saveHandler: () => false })
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
  const { container, saved } = await mount({ saveHandler: () => new Promise<boolean>(resolve => { release = resolve }) })
  const box = loginBox(container)
  await act(async () => { box.click() })
  expect(box.disabled).toBe(true)
  await act(async () => { box.click() })
  expect(saved).toHaveLength(1)
  await act(async () => { release!(true) })
  expect(box.disabled).toBe(false)
  expect(saved).toHaveLength(1)
})

const ELEVATED_STOP_LABEL = '停止提权整合包时允许弹出一次管理员权限请求'
const elevatedStopBox = (container: HTMLElement) => container.querySelector('input[aria-label="' + ELEVATED_STOP_LABEL + '"]') as HTMLInputElement

it('默认允许弹一次提权停止请求，关闭后显示为未勾选', async () => {
  const byDefault = await mount()
  expect(elevatedStopBox(byDefault.container).checked).toBe(true)
  expect(byDefault.container.textContent).toContain('在监督进程不在时只能靠提权结束')
  const turnedOff = await mount({ overrides: { elevatedStopPrompt: false } })
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

/** 路径/镜像这类没有 aria-label 的字段：按 label.form-field 里的第一个 span 认。 */
function fieldInput(container: HTMLElement, label: string): HTMLInputElement {
  const field = Array.from(container.querySelectorAll('label.form-field')).find(item => item.querySelector('span')?.textContent === label)
  expect(field, '字段不存在：' + label).toBeTruthy()
  return field!.querySelector('input') as HTMLInputElement
}

it('四个关机字段按已保存设置回填，默认是关闭 + 10 + 10 + 勾选停止整合包', async () => {
  const custom = await mount({ overrides: { shutdownWhenIdle: true, shutdownIdleMinutes: 25, shutdownGraceMinutes: 0, shutdownStopPacks: false } })
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

it('分钟数越界只在行内报错、不进自动保存；合法值与两个开关合成一次写盘', async () => {
  const { container, saved } = await mount()
  await act(async () => { setInputValue(idleInput(container), '2000') })
  await act(async () => { setInputValue(graceInput(container), '61') })
  const errors = Array.from(container.querySelectorAll('.settings-field-error'))
  expect(errors.every(item => item.getAttribute('role') === 'alert')).toBe(true)
  expect(errors.map(item => item.textContent).join('|')).toContain('1–1440')
  expect(errors.map(item => item.textContent).join('|')).toContain('0–60')
  await settle()
  expect(saved).toHaveLength(0)

  await act(async () => { setInputValue(idleInput(container), '45') })
  await act(async () => { setInputValue(graceInput(container), '0') })
  expect(container.querySelectorAll('.settings-field-error')).toHaveLength(0)
  await act(async () => { shutdownBox(container).click() })
  await act(async () => { stopPacksBox(container).click() })
  await settle()
  expect(saved).toHaveLength(1)
  expect(saved[0].shutdownIdleMinutes).toBe(45)
  expect(saved[0].shutdownGraceMinutes).toBe(0)
  expect(saved[0].shutdownWhenIdle).toBe(true)
  expect(saved[0].shutdownStopPacks).toBe(false)
  expect(container.textContent).toContain('不等待，立即关机')
})

it('勾掉提权停止提示后，自动写盘的草稿里 elevatedStopPrompt 为 false', async () => {
  const { container, saved } = await mount()
  const box = elevatedStopBox(container)
  await act(async () => { box.click() })
  expect(box.checked).toBe(false)
  await settle()
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

it('Windows 下勾选「启动器启动时请求管理员权限」不立即保存，防抖后 onSave 收到 launchElevated: true', async () => {
  const restore = setUserAgent(WINDOWS_UA)
  try {
    const { container, saved } = await mount()
    const box = elevatedLaunchBox(container)
    expect(box.disabled).toBe(false)
    expect(box.checked).toBe(false)
    expect(container.textContent).toContain('下次启动启动器时生效')
    expect(container.textContent).toContain('UAC')
    await act(async () => { box.click() })
    expect(box.checked).toBe(true)
    expect(saved).toHaveLength(0)
    await settle()
    expect(saved).toHaveLength(1)
    expect(saved[0].launchElevated).toBe(true)
  } finally {
    restore()
  }
})

it('非 Windows 时该开关禁用，并说明仅 Windows 支持', async () => {
  const restore = setUserAgent(LINUX_UA)
  try {
    const { container, saved } = await mount()
    const box = elevatedLaunchBox(container)
    expect(box.disabled).toBe(true)
    expect(container.textContent).toContain('仅 Windows 支持')
    await act(async () => { box.click() })
    expect(box.checked).toBe(false)
    await settle()
    // 没改动就没东西要写。
    expect(saved).toHaveLength(0)
  } finally {
    restore()
  }
})
