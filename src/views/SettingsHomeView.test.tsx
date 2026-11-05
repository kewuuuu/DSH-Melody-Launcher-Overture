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
