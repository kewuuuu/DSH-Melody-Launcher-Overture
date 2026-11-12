// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { LauncherApiProvider } from '../../api/client'
import type { LauncherApi, UninstallPlan, UninstallRunOptions, UninstallScriptResult } from '../../types'
import { UninstallPanel } from './UninstallPanel'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  document.body.innerHTML = ''
})

/** 数据目录 1.20 GB / 42 个文件；旧版数据 3.25 GB / 9124 个文件；合计 1.29 GB 删、5.55 GB 留。 */
const plan: UninstallPlan = {
  executablePath: 'C:\\demo\\DSH-Launcher.exe',
  installDir: 'C:\\demo',
  dataDir: 'C:\\demo\\launcher-data',
  items: [
    { id: 'program', label: '启动器程序', path: 'C:\\demo\\DSH-Launcher.exe', kind: 'file', sizeBytes: 92589873, fileCount: 1, action: 'delete' },
    { id: 'data', label: '本版数据目录', path: 'C:\\demo\\launcher-data', kind: 'directory', sizeBytes: 1288490188, fileCount: 42, action: 'delete' },
    { id: 'legacy', label: '旧版启动器数据', path: 'C:\\Users\\demo\\AppData\\Roaming\\dsh-launcher', kind: 'directory', sizeBytes: 3489660928, fileCount: 9124, action: 'keep', reason: '不是这个版本创建的数据，一律不动' },
    { id: 'dsh-home', label: 'DSH 家目录', path: 'C:\\Users\\demo\\.dsh', kind: 'directory', sizeBytes: 2469606195, fileCount: 512, action: 'keep', reason: '用户的 DSH 数据，卸载不碰' },
  ],
  deleteBytes: 92589873 + 1288490188,
  keepBytes: 3489660928 + 2469606195,
  warnings: ['安装目录里还有别的文件，程序目录只删自己那几个文件。'],
}

function makeApi(options: {
  plan?: () => Promise<UninstallPlan>
  exportScript?: () => Promise<UninstallScriptResult | null>
  run?: (options: UninstallRunOptions) => Promise<{ started: boolean }>
} = {}) {
  const uninstall = {
    plan: vi.fn(options.plan ?? (async () => plan)),
    exportScript: vi.fn(options.exportScript ?? (async () => null)),
    run: vi.fn(options.run ?? (async () => ({ started: true }))),
  }
  const openPath = vi.fn(async () => undefined)
  return { api: { uninstall, openPath } as unknown as LauncherApi, uninstall, openPath }
}

async function mount(api: LauncherApi): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(<LauncherApiProvider value={api}><UninstallPanel /></LauncherApiProvider>)
  })
  await act(async () => {})
  return container
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(item => item.textContent?.includes(label))
  expect(found, '按钮不存在：' + label).toBeTruthy()
  return found as HTMLButtonElement
}

async function click(container: HTMLElement, label: string) {
  const found = button(container, label)
  await act(async () => { found.click() })
  await act(async () => {})
}

/** 新语义：扫描由用户点出来，所以每个要看计划的用例都先点一次。 */
async function mountAndScan(api: LauncherApi): Promise<HTMLElement> {
  const container = await mount(api)
  await click(container, '扫描本版内容')
  return container
}

it('挂载时不调用 plan，只给一句说明和「扫描本版内容」入口', async () => {
  const { api, uninstall } = makeApi()
  const container = await mount(api)
  expect(uninstall.plan).not.toHaveBeenCalled()
  const text = container.textContent ?? ''
  expect(text).toContain('清理与卸载')
  expect(text).toContain('扫描本版内容')
  expect(text).toContain('不会自动开始')
  expect(text).not.toContain('将被删除')
  expect(container.querySelector('.uninstall-row')).toBeNull()
  expect(container.querySelector('.error-banner')).toBeNull()
})

it('点击扫描才调用 plan，扫描完成后渲染两组、大小与 warnings', async () => {
  const { api, uninstall } = makeApi()
  const container = await mountAndScan(api)
  expect(uninstall.plan).toHaveBeenCalledTimes(1)
  const text = container.textContent ?? ''
  expect(text).toContain('将被删除')
  expect(text).toContain('1.20 GB')
  expect(text).toContain('42 个文件')
  expect(text).toContain('3.25 GB')
  expect(text).toContain('9124 个文件')
  expect(text).toContain('1.29 GB')
  expect(text).toContain('5.55 GB')
  expect(container.querySelector('[role="status"]')?.textContent).toContain('安装目录里还有别的文件')
})

it('扫描中按钮禁用并显示「正在扫描…」，完成后恢复成「重新扫描」', async () => {
  let release: ((value: UninstallPlan) => void) | null = null
  const { api } = makeApi({ plan: () => new Promise<UninstallPlan>(resolve => { release = resolve }) })
  const container = await mount(api)
  const scanButton = button(container, '扫描本版内容')
  await act(async () => { scanButton.click() })
  const pending = button(container, '正在扫描…')
  expect(pending.disabled).toBe(true)
  expect(pending.getAttribute('aria-busy')).toBe('true')
  expect(container.textContent).not.toContain('将被删除')
  await act(async () => { release!(plan) })
  expect(container.textContent).toContain('将被删除')
  expect(button(container, '重新扫描').disabled).toBe(false)
})

it('「重新扫描」保留上次结果，再调用一次 plan', async () => {
  const { api, uninstall } = makeApi()
  const container = await mountAndScan(api)
  await click(container, '重新扫描')
  expect(uninstall.plan).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('将被删除')
  expect(container.querySelectorAll('.uninstall-row').length).toBe(4)
})

it('扫描失败显示错误条，重试会再扫一次', async () => {
  let calls = 0
  const { api, uninstall } = makeApi({
    plan: async () => {
      calls += 1
      if (calls === 1) throw new Error('主进程忙')
      return plan
    },
  })
  const container = await mountAndScan(api)
  expect(container.querySelector('.error-banner')?.textContent).toContain('主进程忙')
  await click(container, '重试')
  expect(uninstall.plan).toHaveBeenCalledTimes(2)
  expect(container.querySelector('.error-banner')).toBeNull()
  expect(container.textContent).toContain('将被删除')
})

it('保留行显示保留原因，删除行不带原因', async () => {
  const container = await mountAndScan(makeApi().api)
  const rows = Array.from(container.querySelectorAll('.uninstall-row'))
  const legacy = rows.find(row => row.textContent?.includes('旧版启动器数据'))
  expect(legacy?.textContent).toContain('不是这个版本创建的数据，一律不动')
  const program = rows.find(row => row.textContent?.includes('启动器程序'))
  expect(program?.querySelector('.uninstall-row-reason')).toBeNull()
})

it('生成卸载脚本被取消（返回 null）时什么都不显示，也不报错', async () => {
  const { api, uninstall } = makeApi()
  const container = await mountAndScan(api)
  await click(container, '生成卸载脚本')
  expect(uninstall.exportScript).toHaveBeenCalledTimes(1)
  expect(container.querySelector('.error-banner')).toBeNull()
  expect(container.textContent).not.toContain('打开所在文件夹')
})

it('生成脚本成功后显示脚本路径，并能打开所在文件夹', async () => {
  const { api, openPath } = makeApi({ exportScript: async () => ({ scriptPath: 'C:\\Users\\demo\\Desktop\\uninstall-dsh.ps1', commandPath: 'powershell.exe' }) })
  const container = await mountAndScan(api)
  await click(container, '生成卸载脚本')
  expect(container.textContent).toContain('uninstall-dsh.ps1')
  await click(container, '打开所在文件夹')
  expect(openPath).toHaveBeenCalledWith('C:\\Users\\demo\\Desktop')
})

it('第一次点击只是展开确认行，不调用 run', async () => {
  const { api, uninstall } = makeApi()
  const container = await mountAndScan(api)
  await click(container, '立即卸载（保留数据）')
  expect(uninstall.run).not.toHaveBeenCalled()
  expect(container.textContent).toContain('不可恢复')
})

it('确认后调用 run：删本版数据时 deleteData 为 true，并提示正在退出', async () => {
  const { api, uninstall } = makeApi()
  const container = await mountAndScan(api)
  await click(container, '立即卸载并删除本版数据')
  expect(uninstall.run).not.toHaveBeenCalled()
  await click(container, '确认删除')
  expect(uninstall.run).toHaveBeenCalledTimes(1)
  expect(uninstall.run).toHaveBeenCalledWith({ deleteData: true })
  expect(container.textContent).toContain('正在退出，卸载脚本会在后台完成删除')
})

it('保留数据那条的确认行传 deleteData: false', async () => {
  const { api, uninstall } = makeApi()
  const container = await mountAndScan(api)
  await click(container, '立即卸载（保留数据）')
  await click(container, '确认删除')
  expect(uninstall.run).toHaveBeenCalledWith({ deleteData: false })
})
