// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../../api/client'
import type { LauncherApi, LauncherUpdateStatus } from '../../types'
import { UpdateDialog } from './UpdateDialog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.innerHTML = ''
})

const upToDate: LauncherUpdateStatus = {
  state: 'up-to-date',
  localVersion: '1.1.3',
  remoteVersion: '1.1.3',
  releaseUrl: 'https://github.com/kewuuuu/DSH-Melody-Launcher-Overture/releases/tag/v1.1.3',
  assetName: null,
  assetSize: null,
  checkedAt: '2026-11-15T13:00:00.000Z',
  message: '当前启动器已是最新版本。',
}

const available: LauncherUpdateStatus = { ...upToDate, state: 'update-available', remoteVersion: '1.2.0', assetName: 'DSH-launcher-KEWU-Setup-1.2.0.exe', message: '发现新版本 1.2.0。' }

function render(status: LauncherUpdateStatus, busy = false) {
  const onDownload = vi.fn()
  const onApply = vi.fn()
  const onClose = vi.fn()
  const api = { openExternal: vi.fn(async () => undefined) } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<LauncherApiProvider value={api}><UpdateDialog status={status} progress={null} busy={busy} onDownload={onDownload} onApply={onApply} onClose={onClose} /></LauncherApiProvider>)
  })
  return { container, onDownload, onClose, openExternal: api.openExternal }
}

it('offers no download button when the local version already matches the release', () => {
  const { container, onDownload, onClose } = render(upToDate)
  // 同版本号还给「下载更新」，点下去只有一句「没有可下载的更新」。
  expect(container.textContent).not.toContain('下载更新')
  expect(container.textContent).toContain('启动器已是最新版本')
  const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes('知道了'))
  expect(button).toBeTruthy()
  act(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(onDownload).not.toHaveBeenCalled()
})

it('still offers the download button when a newer release exists', () => {
  const { container, onDownload } = render(available)
  const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes('下载更新'))
  expect(button).toBeTruthy()
  act(() => button!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(onDownload).toHaveBeenCalledTimes(1)
})


it('offers retry and the Release page when an installer download fails', () => {
  const { container, onDownload, openExternal } = render({ ...available, state: 'error' })
  const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('footer button'))
  act(() => buttons.find(button => button.textContent?.includes('重试下载'))!.click())
  act(() => buttons.find(button => button.textContent?.includes('去 Release 页'))!.click())
  expect(onDownload).toHaveBeenCalledTimes(1)
  expect(openExternal).toHaveBeenCalledWith(available.releaseUrl)
})

it('offers the Release page without retry if the release has no installer asset', () => {
  const { container } = render({ ...available, state: 'error', assetName: null })
  expect(container.querySelector('footer')?.textContent).toContain('去 Release 页')
  expect(container.querySelector('footer')?.textContent).not.toContain('重试下载')
})

it('keeps its backdrop non-dismissable and allows Escape when idle', () => {
  const { container, onClose } = render(available)
  act(() => container.querySelector('.modal-backdrop')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
  expect(onClose).not.toHaveBeenCalled()
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('blocks Escape and close buttons during a background download', () => {
  const { container, onClose } = render({ ...available, state: 'downloading' })
  const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭更新窗口"]')!
  const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>('footer button')).find(button => button.textContent?.includes('暂不'))!
  expect(close.disabled && cancel.disabled).toBe(true)
  act(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(onClose).not.toHaveBeenCalled()
})
