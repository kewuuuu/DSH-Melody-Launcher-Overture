import { X } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'

interface ModalFocus {
  panel: HTMLElement
  returnTo: HTMLElement | null
}

const openModals: ModalFocus[] = []
const focusableSelector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable]:not([contenteditable="false"])'

function topModal(): ModalFocus | undefined {
  return openModals.reduce<ModalFocus | undefined>((top, modal) =>
    !top || top.panel.compareDocumentPosition(modal.panel) & Node.DOCUMENT_POSITION_FOLLOWING ? modal : top, undefined)
}

function isVisible(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert]')) return false
  if (getComputedStyle(element).visibility !== 'visible') return false
  for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
    if (getComputedStyle(parent).display === 'none') return false
    if (parent instanceof HTMLDetailsElement && !parent.open && parent !== element) {
      const summary = parent.querySelector(':scope > summary')
      if (!summary?.contains(element)) return false
    }
  }
  return true
}

function tabbableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector))
    .filter(element => (element.tabIndex >= 0 || (!element.hasAttribute('tabindex') && element.matches('summary, [contenteditable]')))
      && !element.matches(':disabled') && isVisible(element))
    .sort((left, right) => (left.tabIndex > 0 ? left.tabIndex : Infinity) - (right.tabIndex > 0 ? right.tabIndex : Infinity))
}

function focusInside(panel: HTMLElement) {
  const elements = tabbableElements(panel)
  const target = elements.find(element => element.hasAttribute('data-modal-autofocus')) ?? elements[0] ?? panel
  target.focus()
}

/**
 * 弹窗骨架：遮罩 + section + header（图标 / 标题 / 右上角关闭）+ 内容区 + footer。
 *
 * 抽出来的理由不是省那几行，而是抄写会让每份各自漂移：叉在不在右上角、
 * aria-labelledby 有没有、Escape 通不通、内容区包不包 .modal-content——
 * 之前 7 个弹窗就是 7 个答案。样式契约见 styles.css 的 `.modal > header`。
 */
export interface ModalShellProps {
  /** 同时作为 aria-labelledby 指向的 h2 id，需全应用唯一。 */
  titleId: string
  icon?: ReactNode
  title: ReactNode
  /** 追加在 .modal 上的本弹窗专属类（宽度与内容区覆盖都挂在它下面）。 */
  className: string
  onClose: () => void
  /** 为真时关闭按钮、Escape 和遮罩都不关闭弹窗。 */
  closeDisabled?: boolean
  closeLabel?: string
  headerActions?: ReactNode
  contentClassName?: string
  /** 点遮罩是否关闭。"必须做出选择"的弹窗（更新提示）设 false。 */
  dismissOnBackdrop?: boolean
  footer?: ReactNode
  children: ReactNode
}

export function ModalShell(props: ModalShellProps) {
  const {
    titleId, icon, title, className, onClose, closeDisabled = false, closeLabel = '关闭',
    dismissOnBackdrop = true, headerActions, contentClassName, footer, children,
  } = props
  const panelRef = useRef<HTMLElement>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current!
    const returnTo = document.activeElement
    const entry = { panel, returnTo: returnTo instanceof HTMLElement ? returnTo : null }
    openModals.push(entry)
    if (topModal() === entry) focusInside(panel)

    const onFocusIn = (event: FocusEvent) => {
      if (topModal() === entry && event.target instanceof Node && !panel.contains(event.target)) focusInside(panel)
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      const wasTop = topModal() === entry
      openModals.splice(openModals.indexOf(entry), 1)
      for (const other of openModals) {
        if (panel.contains(other.returnTo)) other.returnTo = entry.returnTo
      }
      if (!wasTop) return
      const next = topModal()
      if (entry.returnTo?.isConnected && (!next || next.panel.contains(entry.returnTo))) entry.returnTo.focus()
      if (next && !next.panel.contains(document.activeElement)) focusInside(next.panel)
    }
  }, [])

  useLayoutEffect(() => {
    const panel = panelRef.current!
    if (topModal()?.panel === panel) {
      const active = document.activeElement
      if (!panel.contains(active) || active?.matches(':disabled')) focusInside(panel)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || topModal()?.panel !== panel) return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!closeDisabled) onClose()
      } else if (event.key === 'Tab') {
        const elements = tabbableElements(panel)
        const index = elements.findIndex(element => element === document.activeElement)
        const edge = event.shiftKey ? 0 : elements.length - 1
        if (index === -1 || index === edge) {
          event.preventDefault()
          const next = (event.shiftKey ? elements.at(-1) : elements[0]) ?? panel
          next.focus()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={event => {
        if (!closeDisabled && dismissOnBackdrop && event.currentTarget === event.target && topModal()?.panel === panelRef.current) onClose()
      }}
    >
      <section ref={panelRef} className={`modal ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header>
          <div>{icon}<h2 id={titleId}>{title}</h2></div>
          <div>{headerActions}<button type="button" className="icon-button" onClick={onClose} disabled={closeDisabled} aria-label={closeLabel}><X size={18} /></button></div>
        </header>
        <div className={contentClassName ? `modal-content ${contentClassName}` : 'modal-content'}>{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  )
}
