import type { MessageBoxOptions } from 'electron'
import type { AppSettings } from '../src/types'
import { resolvePackExitChoice } from './pack-exit-policy'

export function assertLegacyRuntimePreservable(active: boolean): void {
  if (active) throw new Error('仍有旧版运行实例，请先停止该实例，再保留整合包退出或更新。')
}

export async function prepareUserQuit(deps: {
  policy: AppSettings['packExitPolicy']
  isPackRunning: () => boolean
  isLegacyRuntimeBusy: () => boolean
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>
  stopLegacyRuntime: () => Promise<void>
  shutdownPacks: (mode: 'stop' | 'keep') => Promise<void>
}): Promise<false | void> {
  const choice = await resolvePackExitChoice(deps.policy, deps.isLegacyRuntimeBusy() || deps.isPackRunning(), deps.showMessageBox)
  if (choice === 'cancel') return false
  if (choice === 'stop') await deps.stopLegacyRuntime()
  else assertLegacyRuntimePreservable(deps.isLegacyRuntimeBusy())
  await deps.shutdownPacks(choice)
}
