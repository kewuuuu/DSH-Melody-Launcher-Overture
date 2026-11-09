import { useCallback, useEffect, useRef, useState } from 'react'
import { useLauncherApi } from '../api/client'
import { launcherControl, type ControlledPack } from '../lib/pack-control'

export function usePackControl() {
  const api = useLauncherApi()
  const [packs, setPacks] = useState<ControlledPack[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** 按整合包分开的行内错误：停止未托管实例失败只脏这一行，不顶掉整页的错误条。 */
  const [inlineErrors, setInlineErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string[]>([])
  const locks = useRef(new Set<string>())
  const refresh = useCallback(async () => {
    try {
      const result = await launcherControl(api, 'pack.list') as { packs: ControlledPack[] }
      setPacks(result.packs)
      setError(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }, [api])
  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 4000)
    return () => window.clearInterval(timer)
  }, [refresh])
  const run = useCallback(async (command: string, packId: string, args?: Record<string, unknown>, options?: { inlineError?: boolean }) => {
    if (locks.current.has(packId)) return false
    locks.current.add(packId)
    setBusy([...locks.current])
    setInlineErrors(current => {
      if (!(packId in current)) return current
      const next = { ...current }
      delete next[packId]
      return next
    })
    try {
      await launcherControl(api, command, packId, args)
      await refresh()
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (options?.inlineError) setInlineErrors(current => ({ ...current, [packId]: message }))
      else setError(message)
      return false
    }
    finally { locks.current.delete(packId); setBusy([...locks.current]) }
  }, [api, refresh])
  return { packs, loading, error, inlineErrors, busy, refresh, run }
}
