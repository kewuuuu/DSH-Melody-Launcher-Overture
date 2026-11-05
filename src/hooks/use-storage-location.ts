import { useCallback, useEffect, useRef, useState } from 'react'
import { useLauncherApi } from '../api/client'
import type { StorageState } from '../types'

export type StorageLocationBusy = 'load' | 'choose' | 'reset' | 'relaunch' | null

export interface StorageLocationController {
  state: StorageState | null
  error: string | null
  busy: StorageLocationBusy
  reload: () => void
  choose: () => Promise<void>
  /** 把数据目录指向旧版默认目录 %APPDATA%\dsh-launcher（等价于 choose(legacy.dataDir)）。 */
  takeOverLegacy: () => Promise<void>
  reset: () => Promise<void>
  relaunch: () => Promise<void>
}

/** 设置页「存储位置」区块的数据源：读 storage.get()，并把三枚动作包成不会抛的回调。 */
export function useStorageLocation(): StorageLocationController {
  const api = useLauncherApi()
  const [state, setState] = useState<StorageState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<StorageLocationBusy>(null)
  // 卸载之后不再回写状态：切换目录要等用户读完对话框，这段时间组件可能已经不在了。
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const fail = useCallback((cause: unknown) => {
    if (!mounted.current) return
    setError(cause instanceof Error ? cause.message : '数据目录操作失败，请稍后重试。')
  }, [])

  const reload = useCallback(() => {
    setBusy('load')
    setError(null)
    api.storage.get()
      .then(next => { if (mounted.current) setState(next) })
      .catch(fail)
      .finally(() => { if (mounted.current) setBusy(null) })
  }, [api, fail])

  useEffect(() => { reload() }, [reload])

  const chooseWith = useCallback(async (defaultPath?: string) => {
    setBusy('choose')
    setError(null)
    try {
      const next = await api.storage.choose(defaultPath)
      // 用户在对话框里取消：返回 null，界面保持原样。
      if (next && mounted.current) setState(next)
    } catch (cause) {
      fail(cause)
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [api, fail])

  const choose = useCallback(() => chooseWith(), [chooseWith])

  const takeOverLegacy = useCallback(() => chooseWith(state?.legacy.dataDir), [chooseWith, state])

  const reset = useCallback(async () => {
    setBusy('reset')
    setError(null)
    try {
      const next = await api.storage.reset()
      if (mounted.current) setState(next)
    } catch (cause) {
      fail(cause)
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [api, fail])

  const relaunch = useCallback(async () => {
    setBusy('relaunch')
    setError(null)
    try {
      await api.storage.relaunch()
    } catch (cause) {
      fail(cause)
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [api, fail])

  return { state, error, busy, reload, choose, takeOverLegacy, reset, relaunch }
}
