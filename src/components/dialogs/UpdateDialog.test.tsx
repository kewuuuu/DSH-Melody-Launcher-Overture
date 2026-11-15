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

function render(status: LauncherUpdateStatus) {
  const onDownload = vi.fn()
  const onApply = vi.fn()
  const onClose = vi.fn()
  const api = { openExternal: vi.fn(async () => undefined) } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(<LauncherApiProvider value={api}><UpdateDialog status={status} progress={null} busy={false} onDownload={onDownload} onApply={onApply} onClose={onClose} /></LauncherApiProvider>)
  })
  return { container, onDownload, onClose }
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
