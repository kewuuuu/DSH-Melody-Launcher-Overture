import type { LauncherApi, PackStatus, RuntimeState } from '../types'

export interface PackControlConfig {
  portMode: 'auto' | 'fixed'
  port: number
  runAsAdmin: boolean
  autoStart: boolean
  pinnedAt: string | null
  workspace?: string
  launchArgs?: string[]
}
export type ControlledPack = PackStatus & { config: PackControlConfig; runtime: RuntimeState }
export type PackSort = 'name' | 'created' | 'port'
export function sortPacks(packs: ControlledPack[], sort: PackSort, descending: boolean): ControlledPack[] {
  return [...packs].sort((a, b) => {
    if (a.config.pinnedAt || b.config.pinnedAt) {
      if (!a.config.pinnedAt) return 1
      if (!b.config.pinnedAt) return -1
      return a.config.pinnedAt.localeCompare(b.config.pinnedAt) || a.id.localeCompare(b.id)
    }
    const comparison = sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
      : sort === 'created' ? a.installedAt.localeCompare(b.installedAt)
        : (a.runtime.port ?? a.config.port) - (b.runtime.port ?? b.config.port)
    return comparison * (descending ? -1 : 1) || a.id.localeCompare(b.id)
  })
}
export function launcherControl(api: LauncherApi, command: string, packId?: string, args?: Record<string, unknown>): Promise<unknown> {
  const bridge = api as unknown as { launcherControl?: (request: { command: string; packId?: string; args?: Record<string, unknown> }) => Promise<unknown> }
  if (!bridge.launcherControl) return Promise.reject(new Error('当前启动器尚未提供整合包控制接口，请更新启动器。'))
  return bridge.launcherControl({ command, packId, args })
}
