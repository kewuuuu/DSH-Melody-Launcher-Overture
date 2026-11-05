import type { AppSettings } from '../src/types'

/** 系统登录项的注册参数（与 Electron 的 LoginItemSettings 同形，便于单测断言）。 */
export interface LoginItemSettings {
  openAtLogin: boolean
  path: string
  args: string[]
}

export interface LoginItemTarget {
  /** 当前进程的可执行文件；开发态就是 electron.exe。 */
  executablePath: string
  /** 便携版 EXE 自身路径；存在时优先注册它，否则退回当前进程。 */
  portableExecutablePath?: string
}

/** 登录自启只带 --background：启动即隐藏到托盘，不弹主窗口。 */
export const LOGIN_ITEM_ARGS = ['--background']

/**
 * 登录项参数：路径优先用便携版 EXE，因为进程路径在便携版里指向解包后的临时目录。
 */
export function loginItemSettings(enabled: boolean, target: LoginItemTarget): LoginItemSettings {
  return {
    openAtLogin: enabled === true,
    path: target.portableExecutablePath || target.executablePath,
    args: [...LOGIN_ITEM_ARGS],
  }
}

/** 设置里的自启开关：缺省即关，只有显式 true 才算开启。 */
export function launchAtLoginEnabled(settings: Pick<AppSettings, 'launchAtLogin'> | null | undefined): boolean {
  return settings?.launchAtLogin === true
}

/**
 * 按当前设置把登录项校正一次，返回最终应用的开关。
 * 保存设置后调用即刻生效；启动时调用则保证「缺省关」能清掉上一次装留下的旧注册项。
 */
export function syncLaunchAtLogin(
  settings: Pick<AppSettings, 'launchAtLogin'> | null | undefined,
  apply: (enabled: boolean) => void,
): boolean {
  const enabled = launchAtLoginEnabled(settings)
  apply(enabled)
  return enabled
}
