/**
 * 启动器插件的 IPC 装配：list / refresh / openFolder 三个 handler 对应 src/constants.ts 的
 * launcherPlugins* 键。业务逻辑全在 launcher-plugins.ts，这里只负责建服务与转发。
 *
 * openFolder 的目录创建由注入的回调负责（main.ts 那边建好再打开），这一层不替它建。
 */
import type { IpcMain } from 'electron'
import { IPC } from '../src/constants'
import type { LauncherPluginsState } from '../src/types'
import { createLauncherPluginsService, type LauncherPluginsService } from './launcher-plugins'

export interface LauncherPluginsIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  /** 插件根目录（<userData>/launcher-plugins）。 */
  directory: string
  openFolder: (directory: string) => Promise<void> | void
}

function register(
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>,
  channel: string,
  handler: (...args: unknown[]) => unknown,
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, handler)
}

export function registerLauncherPluginsIpc(deps: LauncherPluginsIpcDeps): LauncherPluginsService {
  const service = createLauncherPluginsService({ directory: deps.directory })

  register(deps.ipcMain, IPC.launcherPluginsList, async (): Promise<LauncherPluginsState> => service.list())
  register(deps.ipcMain, IPC.launcherPluginsRefresh, async (): Promise<LauncherPluginsState> => service.refresh())
  register(deps.ipcMain, IPC.launcherPluginsOpenFolder, async (): Promise<void> => {
    await deps.openFolder(service.directory)
  })

  return service
}
