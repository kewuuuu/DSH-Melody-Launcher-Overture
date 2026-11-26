// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import App from './App'
import { DSH_REPOSITORY } from './constants'
import { demoApi } from './demo-api'
import type { InstallProgress, LauncherApi, RepositoryInstallResult } from './types'

vi.mock('./api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('./api/client')>()
  return { ...actual, resolveLauncherApi: () => window.launcher }
})

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('shows scoped DSH stages and cancellation on the pack overview and the versions tab', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let listener: (progress: InstallProgress) => void
  let rejectUpdate!: (error: Error) => void
  let rejectVersion!: (error: Error) => void
  const installPlugin = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectUpdate = reject }))
  const installDshVersion = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectVersion = reject }))
  const cancelInstall = vi.fn().mockResolvedValue(undefined)
  window.launcher = {
    ...demoApi, installPlugin, installDshVersion, cancelInstall,
    detectDshInstallation: async () => ({ installed: true, version: '0.1.5-rc.1', executable: 'demo-dsh.exe', source: 'launcher' }),
    onInstallProgress: fn => { listener = fn; return () => {} },
  } satisfies LauncherApi
  const button = (label: string, scope: ParentNode = container) => Array.from(scope.querySelectorAll('button')).find(item => item.textContent === label)
  const click = async (label: string, scope?: ParentNode) => {
    const target = button(label, scope)
    expect(target).toBeDefined()
    await act(async () => target!.click())
  }
  const emit = (repository: string, operationId: string, progress: Partial<InstallProgress> = {}) => act(async () => listener({
    kind: 'dsh', repository, operationId, phase: 'downloading', percent: 40, message: '正在下载 DSH 及依赖', cancellable: true, ...progress,
  }))
  try {
    await act(async () => root.render(<App />))
    await click('整合包')
    const overview = container.querySelector('.packs-runtime')!
    await click('更新 DSH', overview)
    expect(installPlugin).toHaveBeenCalledExactlyOnceWith(DSH_REPOSITORY)
    await emit(DSH_REPOSITORY, 'update')
    expect(overview.textContent).toContain('正在下载 DSH 及依赖')
    expect(button('安装中…', overview)?.disabled).toBe(true)
    await click('取消安装', overview)
    expect(cancelInstall).toHaveBeenCalledExactlyOnceWith('update')
    expect(button('正在取消安装…', overview)?.disabled).toBe(true)
    await emit(DSH_REPOSITORY, 'update', { phase: 'error', message: '已取消安装。', cancellable: false })
    await act(async () => rejectUpdate(new Error('已取消安装。')))
    expect(overview.textContent).toContain('已取消安装。')

    await click('DSH版本')
    const row = container.querySelector('[title^="DSH 0.1.5-rc.2 ·"]')!
    await click('下载', row)
    expect(installDshVersion).toHaveBeenCalledExactlyOnceWith('0.1.5-rc.2')
    await emit(DSH_REPOSITORY, 'update', { phase: 'error', message: '过期的更新事件', cancellable: false })
    expect(button('取消安装')).toBeUndefined()
    expect(overview.querySelector('.install-stage')).toBeNull()
    await emit('0.1.5-rc.2', 'version')
    expect(container.textContent).not.toContain('过期的更新事件')
    const versionStage = Array.from(container.querySelectorAll('.install-stage')).find(stage => stage.textContent?.includes('正在下载 DSH 及依赖'))!
    await click('取消安装', versionStage)
    expect(cancelInstall).toHaveBeenLastCalledWith('version')
    await emit('0.1.5-rc.2', 'version', { phase: 'configuring', message: '正在写入 DSH 版本', cancellable: false })
    expect(versionStage.textContent).toContain('正在写入 DSH 版本')
    expect(button('取消安装', versionStage)).toBeUndefined()
    await act(async () => rejectVersion(new Error('已取消安装。')))
    expect(button('下载', row)?.disabled).toBe(false)
  } finally {
    await act(async () => root.unmount())
    delete window.launcher
    container.remove()
  }
})

it('首页更新完成后立即在 DSH 版本页显示新安装版本', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const before = await demoApi.readRuntimeEnvironment()
  const version = '0.2.2-rc.5'
  const item = {
    version, root: 'C:\\test-runtime', executable: 'C:\\test-runtime\\dsh.cmd',
    source: 'launcher' as const, selected: true, removable: true,
  }
  const after = { ...before, dshSelectedVersion: version, dshInstalled: [...before.dshInstalled, item] }
  const installation = { installed: true, version, executable: item.executable, source: 'launcher' as const }
  const result: RepositoryInstallResult = {
    kind: 'dsh',
    settings: { ...await demoApi.getSettings(), dshVersion: version, launchExecutable: item.executable },
    profile: await demoApi.readProfile(),
    dshInstallation: installation,
  }
  const readRuntimeEnvironment = vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after)
  const installPlugin = vi.fn().mockResolvedValue(result)
  window.launcher = {
    ...demoApi, readRuntimeEnvironment, installPlugin,
    detectDshInstallation: async () => ({ installed: true, version: '0.2.1-rc.3', executable: 'demo-dsh.exe', source: 'launcher' }),
  } satisfies LauncherApi
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)
    expect(button).toBeDefined()
    await act(async () => button!.click())
  }
  try {
    await act(async () => root.render(<App />))
    expect(readRuntimeEnvironment).toHaveBeenCalledTimes(1)
    await click('整合包')
    await click('更新 DSH')
    expect(installPlugin).toHaveBeenCalledExactlyOnceWith(DSH_REPOSITORY)
    await click('DSH版本')
    const installed = Array.from(container.querySelectorAll('.settings-panel')).find(panel => panel.textContent?.includes('已安装版本'))!
    expect(installed.textContent).toContain(version)
    expect(readRuntimeEnvironment).toHaveBeenCalledTimes(2)
  } finally {
    await act(async () => root.unmount())
    delete window.launcher
    container.remove()
  }
})
