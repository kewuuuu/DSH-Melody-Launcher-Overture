// 对话自动续接的 IPC 装配：3 个 handler 与 src/constants.ts 的键一一对应。
// preload 直接传 id 字符串（retry(id) / discard(id)），list 不带参数。
// 业务逻辑都在 pending-resume.ts，这里只做参数校验与状态汇总。

import type { IpcMain } from 'electron'
import { IPC } from '../src/constants'
import type { PendingResumeQueue } from './pending-resume'

export interface PendingResumesIpcDeps {
  ipcMain: Pick<IpcMain, 'handle' | 'removeHandler'>
  queue: PendingResumeQueue
  /** 取该包当前运行时 base url（含 ?token=…）；没在跑返回 null。 */
  baseUrlOf: (packId: string) => string | null
}

function readId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new Error('缺少续接请求 ID。')
  return id
}

export function registerPendingResumesIpc(deps: PendingResumesIpcDeps): void {
  const { ipcMain, queue } = deps

  ipcMain.removeHandler(IPC.pendingResumesList)
  ipcMain.handle(IPC.pendingResumesList, async (_event, payload?: unknown) => {
    const packId = typeof payload === 'string' ? payload : (payload as { packId?: unknown } | undefined)?.packId
    return queue.list(typeof packId === 'string' && packId.trim() ? packId.trim() : undefined)
  })

  ipcMain.removeHandler(IPC.pendingResumesRetry)
  ipcMain.handle(IPC.pendingResumesRetry, async (_event, payload?: unknown) => {
    const id = readId(payload)
    const entry = (await queue.list()).find(item => item.id === id)
    if (!entry) throw new Error('未找到续接请求：' + id)
    const baseUrl = deps.baseUrlOf(entry.packId)
    if (!baseUrl) {
      const entries = await queue.retry(id)
      return { ok: false, error: '整合包 ' + entry.packId + ' 未在运行，续接请求已保留，待该包启动后再发送。', entries }
    }
    const entries = await queue.retry(id, baseUrl)
    const updated = entries.find(item => item.id === id)
    const sent = updated?.status === 'sent'
    return { ok: sent, error: sent ? null : (updated?.error ?? '续接消息未能发送。'), entries }
  })

  ipcMain.removeHandler(IPC.pendingResumesDiscard)
  ipcMain.handle(IPC.pendingResumesDiscard, async (_event, payload?: unknown) => queue.discard(readId(payload)))
}
