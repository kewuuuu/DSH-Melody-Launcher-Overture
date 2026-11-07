// 卸载相关的 IPC 注册。父级在装配时把它和仓储 IPC 一起挂到 main.ts 上。

import { IPC } from '../src/constants'
import type { UninstallRunOptions } from '../src/types'
import { defaultDialogDirectory } from './storage-root'
import type { UninstallService } from './uninstall'

/** 只声明用得到的 ipcMain 能力，方便单测替身。 */
export interface UninstallIpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
  removeHandler(channel: string): void
}

export interface UninstallDialogOptions {
  title?: string
  defaultPath?: string
  properties: Array<'openDirectory' | 'createDirectory'>
}

export interface UninstallDialogLike {
  showOpenDialog(
    options: UninstallDialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }> | { canceled: boolean; filePaths: string[] }
}

export interface UninstallIpcDeps {
  ipcMain: UninstallIpcMainLike
  service: UninstallService
  /** 本版数据目录，只用来把选目录对话框默认指到它那里。 */
  dataDir: string
  /** 选目录对话框，缺省用 electron 的 dialog（仅在真正导出的那一刻才加载）。 */
  dialog?: UninstallDialogLike
  /** helper 已经拉起来之后的回调：父级在这里 app.quit()。 */
  onStarted?: (result: { started: boolean }) => void
}

async function resolveDialog(deps: UninstallIpcDeps): Promise<UninstallDialogLike | null> {
  if (deps.dialog) return deps.dialog
  try {
    const electron = await import('electron')
    return electron.dialog as unknown as UninstallDialogLike
  } catch {
    return null
  }
}

/**
 * 注册三个 IPC：uninstall:plan / uninstall:script / uninstall:run。
 * 导出脚本时用户取消选目录就返回 null，前端据此当作「什么也没发生」。
 */
export function registerUninstallIpc(deps: UninstallIpcDeps): void {
  const { ipcMain, service } = deps

  ipcMain.handle(IPC.uninstallPlan, async () => service.plan())

  ipcMain.handle(IPC.uninstallScript, async () => {
    const dialog = await resolveDialog(deps)
    if (!dialog) throw new Error('无法打开选择目录对话框：当前环境没有可用的 electron dialog')
    const defaultPath = defaultDialogDirectory(deps.dataDir)
    const picked = await dialog.showOpenDialog({
      title: '选择卸载脚本的导出目录',
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    })
    if (picked.canceled) return null
    const outDir = picked.filePaths[0]
    if (!outDir) return null
    return service.exportScript(outDir)
  })

  ipcMain.handle(IPC.uninstallRun, async (_event, options?: unknown) => {
    const input = (options ?? {}) as Partial<UninstallRunOptions>
    const result = await service.run({ deleteData: input.deleteData === true })
    deps.onStarted?.(result)
    return result
  })
}
