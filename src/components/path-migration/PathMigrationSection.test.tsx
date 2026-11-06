// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { LauncherApiProvider } from '../../api/client'
import type { LauncherApi, MigratablePath, PathMigrationResult } from '../../types'
import { PathMigrationSection } from './PathMigrationSection'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => { for (const root of roots.splice(0)) await act(async () => root.unmount()); document.body.innerHTML = '' })

const oldHome = 'D:\\old-place'

type Call = { name: string; args: unknown[] }
type Options = { chosen?: string | null; result?: PathMigrationResult }

async function mount(kind: MigratablePath, options: Options = {}) {
  const calls: Call[] = []
  const migrated: PathMigrationResult[] = []
  const target = options.chosen === undefined ? 'D:\\new-place' : options.chosen
  const api = {
    chooseDirectory: async (requested: string) => {
      calls.push({ name: 'chooseDirectory', args: [requested] })
      return target
    },
    paths: {
      migrate: async (requested: string, destination: string) => {
        calls.push({ name: 'migrate', args: [requested, destination] })
        return options.result ?? {
          kind: requested as MigratablePath,
          current: destination,
          backupId: 'backup-1',
          removedOld: false,
          warning: '仍有整合包在运行，旧目录会在停止后清理。',
        }
      },
    },
  } as unknown as LauncherApi
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<LauncherApiProvider value={api}>
      <PathMigrationSection
        kind={kind}
        label={kind === 'dshHome' ? 'DSH_HOME' : '本体安装目录'}
        current={oldHome}
        onMigrated={item => { migrated.push(item) }}
      />
    </LauncherApiProvider>)
  })
  await act(async () => {})
  const buttonIn = (label: string) => {
    const found = Array.from(container.querySelectorAll('button'))
      .find(item => (item.textContent ?? '').replace(/\s+/g, '') === label)
    expect(found, '按钮不存在：' + label).toBeTruthy()
    return found as HTMLButtonElement
  }
  return { container, calls, migrated, buttonIn }
}

it('DSH_HOME 选目录并二次确认后按 kind 与目标路径迁移，展示结果', async () => {
  const { container, calls, migrated, buttonIn } = await mount('dshHome')
  expect(container.textContent).toContain('D:\\old-place')
  await act(async () => { buttonIn('迁移到…').click() })
  await act(async () => {})
  expect(calls.find(item => item.name === 'chooseDirectory')?.args).toEqual(['dshHome'])
  expect(calls.some(item => item.name === 'migrate')).toBe(false)
  const confirm = container.querySelector('.path-migration-confirm')
  expect(confirm?.textContent).toContain('D:\\new-place')
  expect(confirm?.textContent).toContain('备份')
  await act(async () => { buttonIn('确认迁移').click() })
  await act(async () => {})
  expect(calls.find(item => item.name === 'migrate')?.args).toEqual(['dshHome', 'D:\\new-place'])
  const result = container.querySelector('dl[aria-label="DSH_HOME迁移结果"]')
  expect(result?.textContent).toContain('D:\\new-place')
  expect(result?.textContent).toContain('backup-1')
  expect(result?.textContent).toContain('已保留')
  expect(result?.textContent).toContain('仍有整合包在运行')
  expect(migrated).toHaveLength(1)
  expect(migrated[0].current).toBe('D:\\new-place')
})

it('选择目录被取消时不出现确认块，也不调用 migrate', async () => {
  const { container, calls, buttonIn } = await mount('dshHome', { chosen: null })
  await act(async () => { buttonIn('迁移到…').click() })
  await act(async () => {})
  expect(container.querySelector('.path-migration-confirm')).toBeNull()
  expect(calls.some(item => item.name === 'migrate')).toBe(false)
  expect(container.textContent).not.toContain('确认迁移')
})

it('本体安装目录的迁移按钮传 dshInstallPath', async () => {
  const { calls, buttonIn } = await mount('dshInstallPath')
  await act(async () => { buttonIn('迁移到…').click() })
  await act(async () => {})
  expect(calls.find(item => item.name === 'chooseDirectory')?.args).toEqual(['dshInstallPath'])
  await act(async () => { buttonIn('确认迁移').click() })
  await act(async () => {})
  expect(calls.find(item => item.name === 'migrate')?.args).toEqual(['dshInstallPath', 'D:\\new-place'])
})
