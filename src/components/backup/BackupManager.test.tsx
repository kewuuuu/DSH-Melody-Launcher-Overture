// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LauncherApiProvider } from '../../api/client'
import type { BackupEntry, BackupOverview, LauncherApi } from '../../types'
import { BackupManager, formatBackupTime, formatBytes, limitInputToBytes } from './BackupManager'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })

const entry = (overrides: Partial<BackupEntry> = {}): BackupEntry => ({
  id: 'b1',
  op: 'pack.delete',
  label: '旧整合包 demo',
  createdAt: new Date(2026, 0, 2, 3, 4).getTime(),
  sizeBytes: 1536,
  fileCount: 3,
  locked: false,
  origin: ['D:\\DSH_HOME\\profiles\\demo'],
  archivePath: 'D:\\launcher-data\\backups\\b1.zip',
  ...overrides,
})

const overview = (entries: BackupEntry[], limitBytes = 2 * 1024 ** 3): BackupOverview => ({
  entries,
  totalBytes: entries.reduce((sum, item) => sum + item.sizeBytes, 0),
  limitBytes,
  directory: 'D:\\launcher-data\\backups',
})

type Call = { name: string; args: unknown[] }
type MountOptions = { restore?: (id: string) => Promise<BackupOverview> }

/** 按原生 setter 改值：React 接管了 value 属性，直接赋值不会触发 onChange。 */
function setControlValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element) as object, 'value')?.set
  setter?.call(element, value)
}

async function mount(seed: BackupOverview, options: MountOptions = {}) {
  const calls: Call[] = []
  let current = seed
  const update = (change: (value: BackupOverview) => BackupOverview) => { current = change(current); return current }
  const backups = {
    list: async () => { calls.push({ name: 'list', args: [] }); return current },
    create: async (input: unknown) => { calls.push({ name: 'create', args: [input] }); return current },
    restore: async (id: string) => {
      calls.push({ name: 'restore', args: [id] })
      if (options.restore) return options.restore(id)
      return update(value => ({ ...value, entries: value.entries.filter(item => item.id !== id) }))
    },
    remove: async (id: string) => {
      calls.push({ name: 'remove', args: [id] })
      return update(value => ({ ...value, entries: value.entries.filter(item => item.id !== id) }))
    },
    setLocked: async (id: string, locked: boolean) => {
      calls.push({ name: 'setLocked', args: [id, locked] })
      return update(value => ({ ...value, entries: value.entries.map(item => (item.id === id ? { ...item, locked } : item)) }))
    },
    setLimit: async (bytes: number) => {
      calls.push({ name: 'setLimit', args: [bytes] })
      return update(value => ({ ...value, limitBytes: bytes }))
    },
    reveal: async (id: string) => { calls.push({ name: 'reveal', args: [id] }) },
  }
  const api = { backups } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<LauncherApiProvider value={api}>
      <BackupManager packDir="D:\\DSH_HOME\\profiles\\demo" packId="demo" />
    </LauncherApiProvider>)
  })
  await act(async () => {})
  const findButton = (label: string) => {
    const found = Array.from(container.querySelectorAll('button'))
      .find(item => (item.textContent ?? '').replace(/\s+/g, '') === label)
    expect(found, '按钮不存在：' + label).toBeTruthy()
    return found as HTMLButtonElement
  }
  return { container, calls, findButton }
}

it('按时间、来源、名称、大小、锁定渲染备份表格', async () => {
  const { container } = await mount(overview([entry()]))
  const headers = Array.from(container.querySelectorAll('th')).map(item => item.textContent)
  expect(headers).toEqual(['时间', '来源', '名称', '大小', '锁定', '操作'])
  expect(container.textContent).toContain('2026-01-02 03:04')
  expect(formatBackupTime(entry().createdAt)).toBe('2026-01-02 03:04')
  expect(container.textContent).toContain('整合包删除')
  expect(container.textContent).toContain('旧整合包 demo')
  expect(container.textContent).toContain('3 个文件')
  expect(container.textContent).toContain(formatBytes(1536))
  expect(container.textContent).toContain('未锁定')
  expect(container.textContent).toContain('已用 1.50 KB / 上限 2.00 GB')
})

it('锁定按钮调用 setLocked，返回的清单让行切换到已锁定', async () => {
  const { container, calls, findButton } = await mount(overview([entry()]))
  await act(async () => { findButton('锁定').click() })
  await act(async () => {})
  expect(calls.filter(item => item.name === 'setLocked')[0]?.args).toEqual(['b1', true])
  expect(container.textContent).toContain('已锁定')
  expect(findButton('解锁')).toBeTruthy()
})

it('恢复要两步确认，第一步不调用 restore', async () => {
  const { container, calls, findButton } = await mount(overview([entry()]))
  await act(async () => { findButton('恢复').click() })
  expect(container.textContent).toContain('恢复会覆盖当前文件')
  expect(calls.some(item => item.name === 'restore')).toBe(false)
  await act(async () => { findButton('确认恢复').click() })
  await act(async () => {})
  expect(calls.find(item => item.name === 'restore')?.args).toEqual(['b1'])
  expect(container.textContent).toContain('备份区还是空的')
})

it('后端拒绝恢复时原样显示主进程的错误', async () => {
  const { container, findButton } = await mount(overview([entry()]), {
    restore: async () => { throw new Error('整合包正在运行，无法恢复。') },
  })
  await act(async () => { findButton('恢复').click() })
  await act(async () => { findButton('确认恢复').click() })
  await act(async () => {})
  const alert = container.querySelector('[role="alert"]')
  expect(alert?.textContent).toContain('整合包正在运行，无法恢复。')
})

it('容量上限按 GB 换算成字节：2 GB → 2147483648', async () => {
  const { container, calls, findButton } = await mount(overview([], 0))
  await act(async () => { findButton('设置上限').click() })
  const input = container.querySelector('input[aria-label="备份上限数值"]') as HTMLInputElement
  const unit = container.querySelector('select[aria-label="备份上限单位"]') as HTMLSelectElement
  expect(input).toBeTruthy()
  expect(unit).toBeTruthy()
  await act(async () => {
    setControlValue(input, '2')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    setControlValue(unit, 'GB')
    unit.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => { findButton('保存上限').click() })
  await act(async () => {})
  expect(calls.find(item => item.name === 'setLimit')?.args).toEqual([2147483648])
  expect(limitInputToBytes('2', 'GB')).toBe(2147483648)
  expect(limitInputToBytes('512', 'MB')).toBe(536870912)
  expect(limitInputToBytes('0', 'GB')).toBe(0)
  expect(limitInputToBytes('', 'GB')).toBeNull()
})
