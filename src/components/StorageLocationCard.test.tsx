// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LauncherApiProvider } from '../api/client'
import type { LauncherApi, StorageState } from '../types'
import { StorageLocationCard } from './StorageLocationCard'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })

type Call = { kind: 'get' | 'choose' | 'reset' | 'relaunch'; arg?: string }

function storageState(overrides: Partial<StorageState> = {}): StorageState {
  return {
    dataDir: 'D:\\launcher-data',
    source: 'portable',
    portableDir: 'D:\\launcher-data',
    pointerFile: null,
    legacy: { dataDir: 'C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher', hasData: false },
    restartRequired: false,
    warning: null,
    ...overrides,
  }
}

/** 用假的 window.launcher（LauncherApiProvider 注入）挂载区块，记录每次调用的入参。 */
async function mount(initial: StorageState, results: { choose?: StorageState | null; reset?: StorageState } = {}) {
  const calls: Call[] = []
  const api = {
    storage: {
      get: async () => { calls.push({ kind: 'get' }); return initial },
      choose: async (defaultPath?: string) => {
        calls.push({ kind: 'choose', arg: defaultPath })
        return results.choose ?? null
      },
      reset: async () => { calls.push({ kind: 'reset' }); return results.reset ?? initial },
      relaunch: async () => { calls.push({ kind: 'relaunch' }) },
    },
  } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => { root.render(<LauncherApiProvider value={api}><StorageLocationCard /></LauncherApiProvider>) })
  await act(async () => {})
  const path = () => container.querySelector('.storage-location-path code')?.textContent
  const findButton = (label: string) => {
    const found = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes(label))
    expect(found, '按钮不存在：' + label).toBeTruthy()
    return found as HTMLButtonElement
  }
  const click = async (label: string) => {
    await act(async () => { findButton(label).click() })
    await act(async () => {})
  }
  return { container, calls, path, findButton, click }
}

it('便携来源显示 EXE 同级说明与当前路径', async () => {
  const { container, path } = await mount(storageState({ source: 'portable', dataDir: 'D:\\launcher-data' }))
  expect(path()).toBe('D:\\launcher-data')
  expect(container.textContent).toContain('EXE 同级的 launcher-data（便携版默认）')
  expect(container.textContent).not.toContain('接管旧版数据')
})

it('pointer 来源显示 launcher-storage.json 说明与指针文件路径', async () => {
  const { container, path } = await mount(storageState({
    source: 'pointer',
    dataDir: 'E:\\dsh-data',
    pointerFile: 'D:\\DSH Launcher\\launcher-storage.json',
  }))
  expect(path()).toBe('E:\\dsh-data')
  expect(container.textContent).toContain('来自 launcher-storage.json')
  expect(container.textContent).toContain('D:\\DSH Launcher\\launcher-storage.json')
})

it('restartRequired 时出现重启提示与按钮，点击调用 relaunch', async () => {
  const { container, calls, click } = await mount(storageState({ restartRequired: true }))
  expect(container.querySelector('.storage-location-restart')).not.toBeNull()
  expect(container.textContent).toContain('重启启动器之后才会生效')
  await click('立即重启启动器')
  expect(calls.some(call => call.kind === 'relaunch')).toBe(true)
})

it('legacy.hasData 为 true 时出现接管按钮，点击把旧目录传给 choose', async () => {
  const legacyDir = 'C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher'
  const { container, calls, click } = await mount(storageState({ legacy: { dataDir: legacyDir, hasData: true } }))
  expect(container.textContent).toContain('接管旧版数据')
  await click('接管旧版数据')
  const takeover = calls.find(call => call.kind === 'choose')
  expect(takeover?.arg).toBe(legacyDir)
})

it('warning 非空时以警告样式渲染', async () => {
  const { container } = await mount(storageState({ warning: 'launcher-storage.json 无法解析，已回退到 EXE 同级的 launcher-data。' }))
  const warning = container.querySelector('.storage-location-warning')
  expect(warning).not.toBeNull()
  expect(warning!.getAttribute('role')).toBe('alert')
  expect(warning!.textContent).toContain('无法解析')
})

it('选择文件夹后采用返回的状态并提示重启', async () => {
  const chosen = storageState({ dataDir: 'E:\\dsh-data', source: 'pointer', restartRequired: true })
  const { container, calls, path, click } = await mount(storageState(), { choose: chosen })
  await click('选择文件夹')
  expect(calls.some(call => call.kind === 'choose' && call.arg === undefined)).toBe(true)
  expect(path()).toBe('E:\\dsh-data')
  expect(container.querySelector('.storage-location-restart')).not.toBeNull()
})

it('选择对话框取消（choose 返回 null）时界面状态不变', async () => {
  const { container, calls, path, click } = await mount(storageState({ dataDir: 'D:\\launcher-data' }), { choose: null })
  await click('选择文件夹')
  expect(calls.some(call => call.kind === 'choose')).toBe(true)
  expect(path()).toBe('D:\\launcher-data')
  expect(container.querySelector('.storage-location-restart')).toBeNull()
})

it('恢复默认位置调用 reset 并采用返回的状态', async () => {
  const resetState = storageState({ dataDir: 'D:\\launcher-data', source: 'portable', restartRequired: true })
  const { container, calls, path, click } = await mount(storageState({ dataDir: 'E:\\my-data', source: 'pointer' }), { reset: resetState })
  await click('恢复默认位置')
  expect(calls.some(call => call.kind === 'reset')).toBe(true)
  expect(path()).toBe('D:\\launcher-data')
  expect(container.querySelector('.storage-location-restart')).not.toBeNull()
})
