// 目录迁移的 IPC 装配：paths:migrate 单个 handler（preload 传 { kind, target }）。
// 只做参数校验，真正的迁移流程在 path-migration.ts。

import type { IpcMain } from 'electron'
import { IPC } from '../src/constants'
import type { MigratablePath, PathMigrationResult } from '../src/types'

export interface PathMigrationIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  migrate: (kind: MigratablePath, target: string) => Promise<PathMigrationResult>
}

export function registerPathMigrationIpc(deps: PathMigrationIpcDeps): void {
  const { ipcMain } = deps
  ipcMain.removeHandler(IPC.pathsMigrate)
  ipcMain.handle(IPC.pathsMigrate, async (_event, payload?: unknown) => {
    const input = (payload ?? {}) as { kind?: unknown; target?: unknown }
    const kind = input.kind
    if (kind !== 'dshHome' && kind !== 'dshInstallPath') {
      throw new Error('不支持的迁移目标：' + String(kind) + '，只能是 dshHome 或 dshInstallPath。')
    }
    const target = typeof input.target === 'string' ? input.target.trim() : ''
    if (!target) throw new Error('迁移目标目录不能为空。')
    return deps.migrate(kind, target)
  })
}
