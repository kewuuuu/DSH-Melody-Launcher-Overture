// 空闲自动关机的 IPC 装配：4 个 handler 与 src/constants.ts 的键一一对应。
// 业务逻辑都在 idle-shutdown.ts，这里只做接线，参数一律由服务自己读设置。

import type { IpcMain } from 'electron'
import { IPC } from '../src/constants'
import type { IdleShutdownService } from './idle-shutdown'

export interface IdleShutdownIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  service: IdleShutdownService
}

export function registerIdleShutdownIpc(deps: IdleShutdownIpcDeps): void {
  const { ipcMain, service } = deps

  ipcMain.removeHandler(IPC.idleShutdownGet)
  ipcMain.handle(IPC.idleShutdownGet, async () => service.get())

  ipcMain.removeHandler(IPC.idleShutdownArm)
  ipcMain.handle(IPC.idleShutdownArm, async () => service.arm())

  ipcMain.removeHandler(IPC.idleShutdownDisarm)
  ipcMain.handle(IPC.idleShutdownDisarm, async () => service.disarm())

  ipcMain.removeHandler(IPC.idleShutdownCancel)
  ipcMain.handle(IPC.idleShutdownCancel, async () => service.cancel())
}
