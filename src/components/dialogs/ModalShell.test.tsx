// @vitest-environment jsdom
import { act, StrictMode, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ModalShell } from './ModalShell'
import { PackInstallDialog, type PackInstallDialogProps } from './PackInstallDialog'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.innerHTML = ''
})

function render(ui: ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  const rerender = (next: ReactElement) => act(() => root.render(<StrictMode>{next}</StrictMode>))
  rerender(ui)
  return { container, rerender }
}

const press = (key: string, shiftKey = false) => act(() => {
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }))
})
const backdrop = (panel: Element) => act(() => {
  panel.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
})

it('traps Tab in the topmost modal and restores focus in order', () => {
  function Harness() {
    const [firstOpen, setFirstOpen] = useState(false)
    const [secondOpen, setSecondOpen] = useState(false)
    return <>
      <button id="open-first" onClick={() => setFirstOpen(true)}>Open first</button>
      {firstOpen && <ModalShell titleId="first-modal" title="First" className="first" onClose={() => setFirstOpen(false)}>
        <button id="open-second" onClick={() => setSecondOpen(true)}>Open second</button>
      </ModalShell>}
      {secondOpen && <ModalShell titleId="second-modal" title="Second" className="second" onClose={() => setSecondOpen(false)}>
        <input data-modal-autofocus />
        <button id="last">Last enabled</button>
        <button disabled>Disabled</button>
        <button hidden>Hidden</button>
      </ModalShell>}
    </>
  }
  const { container } = render(<Harness />)
  const firstTrigger = container.querySelector<HTMLButtonElement>('#open-first')!
  firstTrigger.focus()
  act(() => firstTrigger.click())
  const secondTrigger = container.querySelector<HTMLButtonElement>('#open-second')!
  secondTrigger.focus()
  act(() => secondTrigger.click())
  const upper = container.querySelector('.second')!
  const close = upper.querySelector('button')!
  const input = upper.querySelector('input')!
  const last = upper.querySelector<HTMLButtonElement>('#last')!
  expect(document.activeElement).toBe(input)
  firstTrigger.focus()
  expect(document.activeElement).toBe(input)
  last.focus()
  press('Tab')
  expect(document.activeElement).toBe(close)
  press('Tab', true)
  expect(document.activeElement).toBe(last)
  backdrop(container.querySelector('.first')!)
  expect(container.querySelector('.first')).not.toBeNull()
  press('Escape')
  expect(container.querySelector('.second')).toBeNull()
  expect(document.activeElement).toBe(secondTrigger)
  backdrop(container.querySelector('.first')!)
  expect(container.querySelector('.first')).toBeNull()
  expect(document.activeElement).toBe(firstTrigger)
})

it('blocks busy pack install backdrop and Escape, then dismisses after completion', () => {
  const onClose = vi.fn()
  const props: PackInstallDialogProps = {
    phase: 'preview', events: [], result: null, error: null, analysis: null,
    itemProgress: { current: null, done: 0, total: 0, unit: 'component' },
    hasSnapshot: false, busy: true,
    onConfirmImport: vi.fn(), onRollback: vi.fn(), onActivate: vi.fn(), onClose,
  }
  const { container, rerender } = render(<PackInstallDialog {...props} />)
  const panel = container.querySelector('.pack-install-dialog')!
  const close = panel.querySelector<HTMLButtonElement>('header button')!
  expect(close.disabled).toBe(true)
  expect(panel.querySelector<HTMLButtonElement>('footer button.secondary-button')?.disabled).toBe(true)
  backdrop(panel)
  press('Escape')
  expect(onClose).not.toHaveBeenCalled()
  rerender(<PackInstallDialog {...props} phase="done" busy={false} />)
  expect(close.disabled).toBe(false)
  press('Escape')
  backdrop(panel)
  expect(onClose).toHaveBeenCalledTimes(2)
})
