import { useCallback, useEffect, useRef, useState } from 'react'
import { errorText } from '../lib/format'

type OperationProgress = {
  operationId?: string
  cancellable?: boolean
  phase: string
  message: string
}

export function isInstallTerminal(phase: string): boolean {
  return phase === 'complete' || phase === 'error'
}

interface ActiveInstall<P> {
  matches: (progress: P) => boolean
  progress: P
  cancelling: boolean
  cancelError: string | null
}

export function useInstallOperation<P extends OperationProgress>(cancelInstall: (operationId: string) => Promise<void>) {
  const active = useRef<ActiveInstall<P> | null>(null)
  const retiredIds = useRef<string[]>([])
  const [view, setView] = useState<{ progress: P | null; busy: boolean; cancelling: boolean; cancelError: string | null }>({
    progress: null, busy: false, cancelling: false, cancelError: null,
  })
  const frame = useRef<{ timer: ReturnType<typeof setTimeout> | null; lastFlush: number }>({ timer: null, lastFlush: 0 })

  const updateView = useCallback((immediate = true) => {
    const flush = () => {
      const current = active.current
      frame.current.timer = null
      frame.current.lastFlush = Date.now()
      if (!current) return
      const { progress, cancelling, cancelError } = current
      setView({ progress, busy: true, cancelling, cancelError })
    }
    const elapsed = Date.now() - frame.current.lastFlush
    if (immediate || elapsed >= 120) {
      if (frame.current.timer !== null) clearTimeout(frame.current.timer)
      flush()
    } else if (frame.current.timer === null) {
      frame.current.timer = setTimeout(flush, 120 - elapsed)
    }
  }, [])

  useEffect(() => () => {
    if (frame.current.timer !== null) clearTimeout(frame.current.timer)
    frame.current.timer = null
    active.current = null
  }, [])

  const begin = useCallback((initial: P, matches: (progress: P) => boolean) => {
    if (active.current) return null
    const operation = { matches, progress: initial, cancelling: false, cancelError: null }
    active.current = operation
    updateView()
    return (failure?: string) => {
      if (active.current !== operation) return
      active.current = null
      if (frame.current.timer !== null) clearTimeout(frame.current.timer)
      frame.current.timer = null
      const id = operation.progress.operationId
      if (id) retiredIds.current = [...retiredIds.current.slice(-31), id]
      const progress = failure
        ? { ...operation.progress, phase: 'error', message: operation.progress.phase === 'error' ? operation.progress.message : failure, cancellable: false }
        : null
      setView({ progress, busy: false, cancelling: false, cancelError: null })
    }
  }, [updateView])

  const acceptProgress = useCallback((progress: P) => {
    const operation = active.current
    if (!operation?.matches(progress) || isInstallTerminal(operation.progress.phase)) return false
    const previous = operation.progress
    const id = progress.operationId
    if ((id && retiredIds.current.includes(id)) || (previous.operationId && previous.operationId !== id)) return false
    if (id && !previous.operationId && isInstallTerminal(progress.phase)) return false
    operation.progress = progress
    if (isInstallTerminal(progress.phase)) operation.cancelling = false
    updateView(previous.phase !== progress.phase || previous.cancellable !== progress.cancellable || previous.operationId !== id)
    return true
  }, [updateView])

  const cancel = useCallback(async () => {
    const operation = active.current
    if (!operation || operation.cancelling) return
    const { operationId, phase, cancellable } = operation.progress
    if (!operationId || cancellable !== true || isInstallTerminal(phase)) return
    operation.cancelling = true
    operation.cancelError = null
    updateView()
    try {
      await cancelInstall(operationId)
    } catch (error) {
      if (active.current !== operation || isInstallTerminal(operation.progress.phase)) return
      operation.cancelling = false
      operation.cancelError = errorText(error)
      updateView()
    }
  }, [cancelInstall, updateView])

  return { ...view, begin, acceptProgress, cancel }
}
