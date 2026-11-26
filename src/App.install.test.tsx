// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import App from './App'
import { DSH_REPOSITORY } from './constants'
import { demoApi } from './demo-api'
import type { InstallProgress, LauncherApi } from './types'

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
