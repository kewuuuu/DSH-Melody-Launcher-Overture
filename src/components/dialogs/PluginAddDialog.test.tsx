// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../../api/client'
import type { InstallProgress, LauncherApi } from '../../types'
import { PluginAddDialog } from './PluginAddDialog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

it('shows only matching npm progress and waits for cancellation before allowing another install', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  let listener: (progress: InstallProgress) => void
  let rejectInstall!: (error: Error) => void
  let settleRetry!: () => void
  const installPluginFromNpm = vi.fn()
    .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectInstall = reject }))
    .mockImplementationOnce(() => new Promise<void>(resolve => { settleRetry = resolve }))
  const cancelInstall = vi.fn().mockResolvedValue(undefined)
  const onClose = vi.fn()
  const onInstalled = vi.fn()
  const api = {
    installPluginFromNpm, cancelInstall,
    onInstallProgress: (fn: typeof listener) => { listener = fn; return () => {} },
  } as unknown as LauncherApi
  const button = (label: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === label)
  const emit = (progress: Partial<InstallProgress>) => act(async () => listener({
    repository: 'npm:@scope/example', kind: 'plugin', phase: 'downloading',
    message: '正在下载插件及依赖', percent: 40, operationId: 'example', cancellable: true, ...progress,
  }))
  try {
    await act(async () => root.render(<LauncherApiProvider value={api}><PluginAddDialog profileName="测试包" onClose={onClose} onInstalled={onInstalled} /></LauncherApiProvider>))
    const input = container.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '@scope/example@1.2.3')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('安装')!.click())
    expect(installPluginFromNpm).toHaveBeenCalledExactlyOnceWith({ packageName: '@scope/example', version: '1.2.3' })
    await emit({ repository: 'npm:@scope/other', operationId: 'other' })
    expect(button('取消安装')).toBeUndefined()
    await emit({})
    expect(container.textContent).toContain('正在下载插件及依赖')
    await act(async () => button('取消安装')!.click())
    expect(button('正在取消安装…')?.disabled).toBe(true)
    expect(cancelInstall).toHaveBeenCalledExactlyOnceWith('example')
    expect(button('安装')?.disabled).toBe(true)
    await emit({ phase: 'error', message: '已取消安装。', cancellable: false })
    await act(async () => rejectInstall(new Error('已取消安装。')))
    expect(container.textContent).toContain('已取消安装。')
    expect(onClose).not.toHaveBeenCalled()
    expect(button('安装')?.disabled).toBe(false)
    await act(async () => button('安装')!.click())
    await emit({ phase: 'configuring', message: '正在写入插件配置', operationId: 'retry', cancellable: false })
    expect(container.textContent).toContain('正在写入插件配置')
    expect(button('取消安装')).toBeUndefined()
    await act(async () => settleRetry())
    expect(onInstalled).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
