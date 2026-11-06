// 备份区的 IPC 装配：7 个 handler 与 src/constants.ts 里的备份键一一对应。
// 这里只做参数校验与错误透传（错误文案在引擎里已经是中文），业务逻辑都在 backups.ts。
// electron/ipc.ts 是父级契约持有的文件，所以这里导出 registerBackupsIpc(deps) 交给它装配；
// 顺带把引擎登记成删除 hook 的默认引擎，三条删除链路才能「先备份、再删除」。

import type { IpcMain } from 'electron'
import { IPC } from '../src/constants'
import type { BackupOpKind } from '../src/types'
import {
  createBackupEngine,
  setDefaultBackupEngine,
  type BackupArchiveTool,
  type BackupCreateInput,
  type BackupEngine,
} from './backups'

export interface BackupIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  /** 启动器 userData 目录（备份区、索引、容量配置都在它下面）。 */
  root: string
  isPackRunning?: (packId: string) => boolean
  packLabel?: (packId: string) => string | null
  packForPath?: (target: string) => string | null
  /** 在文件管理器里定位备份压缩包（shell.showItemInFolder 之类）。 */
  revealPath?: (target: string) => Promise<void> | void
  tools?: BackupArchiveTool
  now?: () => number
}

function readId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error('备份标识无效。')
  return id
}

function readCreateInput(raw: unknown): BackupCreateInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('备份参数无效。')
  const input = raw as Record<string, unknown>
  const paths = Array.isArray(input.paths) ? input.paths : null
  if (!paths || paths.length === 0 || paths.some(item => typeof item !== 'string')) throw new Error('备份路径无效。')
  const label = typeof input.label === 'string' ? input.label.trim() : ''
  if (!label) throw new Error('备份名称不能为空。')
  const op = typeof input.op === 'string' ? (input.op as BackupOpKind) : undefined
  const packId = typeof input.packId === 'string' && input.packId.trim() ? input.packId.trim() : undefined
  return { paths: paths as string[], label, ...(op ? { op } : {}), ...(packId ? { packId } : {}) }
}

/** 注册备份区的 7 个 IPC handler，并返回建好的引擎（同一条引擎会被删除 hook 复用）。 */
export function registerBackupsIpc(deps: BackupIpcDeps): BackupEngine {
  const engine = createBackupEngine({
    root: deps.root,
    ...(deps.isPackRunning ? { isPackRunning: deps.isPackRunning } : {}),
    ...(deps.packLabel ? { packLabel: deps.packLabel } : {}),
    ...(deps.packForPath ? { packForPath: deps.packForPath } : {}),
    ...(deps.tools ? { tools: deps.tools } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  })
  setDefaultBackupEngine(engine)

  deps.ipcMain.handle(IPC.backupsList, async () => engine.list())

  deps.ipcMain.handle(IPC.backupsCreate, async (_event, raw: unknown) => {
    await engine.create(readCreateInput(raw))
    return engine.list()
  })

  deps.ipcMain.handle(IPC.backupsRestore, async (_event, id: unknown) => engine.restore(readId(id)))

  deps.ipcMain.handle(IPC.backupsRemove, async (_event, id: unknown) => engine.remove(readId(id)))

  deps.ipcMain.handle(IPC.backupsSetLocked, async (_event, raw: unknown) => {
    const payload = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    return engine.setLocked(readId(payload.id), Boolean(payload.locked))
  })

  deps.ipcMain.handle(IPC.backupsSetLimit, async (_event, bytes: unknown) => {
    return engine.setLimit(typeof bytes === 'number' ? bytes : Number.NaN)
  })

  deps.ipcMain.handle(IPC.backupsReveal, async (_event, id: unknown) => {
    const target = await engine.archivePath(readId(id))
    await deps.revealPath?.(target)
  })

  return engine
}
