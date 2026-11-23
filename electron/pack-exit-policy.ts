import type { MessageBoxOptions } from 'electron'
import type { AppSettings } from '../src/types'

export type PackExitChoice = 'stop' | 'keep' | 'cancel'

const CANCEL_BUTTON = 2

export async function resolvePackExitChoice(
  policy: AppSettings['packExitPolicy'],
  hasActivePacks: boolean,
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>,
): Promise<PackExitChoice> {
  if (!hasActivePacks) return 'keep'
  if (policy === 'stop') return 'stop'

  const { response } = await showMessageBox({
    type: 'question',
    title: '退出启动器',
    message: '仍有整合包在运行。退出启动器时要如何处理？',
    buttons: ['停止整合包并退出', '保持整合包运行并退出', '取消退出'],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
  })
  if (response === 0) return 'stop'
  if (response === 1) return 'keep'
  return 'cancel'
}
