import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// 这个测试只驱动 tools/uninstaller/bin/KEWU-Uninstaller.exe 的无人值守模式：
// fixture 全部在 os.tmpdir() 里现造现删，APPDATA / TEMP 通过环境变量重定向到 fixture，
// 自启项指向专门的一次性测试注册表键（afterEach 删除），所以绝不碰真实的
// %APPDATA%\dsh-launcher、%USERPROFILE%\.dsh 和用户正在运行的启动器。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exePath = path.join(repoRoot, 'tools', 'uninstaller', 'bin', 'KEWU-Uninstaller.exe')
const binaryExists = existsSync(exePath)
const isWindows = process.platform === 'win32'
const canRun = isWindows && binaryExists

if (!canRun) {
  console.warn(
    isWindows
      ? `[uninstaller] 跳过 EXE 测试：没有找到 ${exePath}。先运行 powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-uninstaller.ps1 再跑测试。`
      : '[uninstaller] 跳过 EXE 测试：KEWU-Uninstaller.exe 只能在 Windows 上构建和运行。',
  )
}

interface PlanItem {
  id: string
  label: string
  path: string
  kind: 'file' | 'directory' | 'registry'
  sizeBytes: number
  action: 'delete' | 'keep'
  reason: string
  defaultChecked: boolean
}

interface Plan {
  exePath: string
  dataDir: string
  items: PlanItem[]
  alwaysKeep: { label: string; path: string; reason: string }[]
  runningProcesses?: string[]
}

const testRunKey = 'HKCU\\Software\\KEWU-Uninstaller-Test\\Run'
const testRunValue = 'electron.app.DSH-launcher-KEWU'

let workDir = ''
let launcherDir = ''
let fixtureTempDir = ''
let fixtureAppData = ''
// 真正的 EXE 会被复制进 fixture 再运行：一是让 uninstall-log.txt 落在 fixture 里（不污染 bin/），
// 二是本机沙箱只允许子进程改动它自己所在临时根下的文件，跨根（D:\仓库 → C:\Temp）的
// --plan 写文件和删除都会被拒成 UnauthorizedAccessException。
let exeUnderTest = ''

function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APPDATA: fixtureAppData,
    TEMP: fixtureTempDir,
    TMP: fixtureTempDir,
    KEWU_UNINSTALLER_RUN_KEY: testRunKey,
  }
}

function reg(args: string[]): number | null {
  const result = spawnSync('reg', args, { encoding: 'utf8', windowsHide: true })
  return result.status
}

function createTestRunValue(): boolean {
  const status = reg(['add', testRunKey, '/v', testRunValue, '/t', 'REG_SZ', '/d', path.join(launcherDir, 'FakeLauncher.exe'), '/f'])
  return status === 0
}

function testRunValueExists(): boolean {
  return reg(['query', testRunKey, '/v', testRunValue]) === 0
}

function removeTestRunKey(): void {
  reg(['delete', 'HKCU\\Software\\KEWU-Uninstaller-Test', '/f'])
}

function runPlanFile(): Plan {
  const planFile = path.join(workDir, 'plan.json')
  const result = spawnSync(exeUnderTest, ['--dir', launcherDir, '--plan', planFile], {
    encoding: 'utf8',
    env: childEnv(),
    timeout: 120_000,
    windowsHide: true,
  })
  expect(result.status, `--plan 应以 0 退出（stderr: ${result.stderr ?? ''}）`).toBe(0)
  expect(existsSync(planFile), '--plan 应写出 JSON 文件').toBe(true)
  return JSON.parse(readFileSync(planFile, 'utf8')) as Plan
}

function runHeadless(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(exeUnderTest, args, { encoding: 'utf8', env: childEnv(), timeout: 120_000, windowsHide: true })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function waitForPid(pid: number): boolean {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true })
    if ((probe.stdout ?? '').includes(String(pid))) return true
    spawnSync(process.platform === 'win32' ? 'timeout' : 'sleep', ['/t', '1'], { encoding: 'utf8' })
  }
  return false
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'kewu-uninstaller-'))
  launcherDir = path.join(workDir, 'launcher')
  fixtureTempDir = path.join(workDir, 'temp')
  fixtureAppData = path.join(workDir, 'appdata')
  mkdirSync(launcherDir, { recursive: true })
  mkdirSync(fixtureTempDir, { recursive: true })
  mkdirSync(fixtureAppData, { recursive: true })
  exeUnderTest = path.join(workDir, 'KEWU-Uninstaller.exe')
  copyFileSync(exePath, exeUnderTest)
})

afterEach(() => {
  removeTestRunKey()
  if (workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 5 })
})

describe.skipIf(!canRun)('KEWU Uninstaller EXE', () => {
  it('--plan 列出 exe/data/pointer/temp-residue，并保持 data 默认不勾选', { timeout: 120_000 }, () => {
    const fakeExe = path.join(launcherDir, 'FakeLauncher.exe')
    writeFileSync(fakeExe, 'x')
    writeFileSync(path.join(launcherDir, 'launcher-storage.json'), '{}')
    mkdirSync(path.join(launcherDir, 'launcher-data', 'sub'), { recursive: true })
    writeFileSync(path.join(launcherDir, 'launcher-data', 'sub', 'blob.bin'), '0123456789')
    mkdirSync(path.join(fixtureTempDir, '3Lsynthetic'), { recursive: true })
    writeFileSync(path.join(fixtureTempDir, '3Lsynthetic', 'junk.bin'), 'yy')

    const plan = runPlanFile()
    const find = (id: string): PlanItem | undefined => plan.items.find((item) => item.id === id)

    expect(plan.exePath).toBe(fakeExe)
    expect(plan.dataDir).toBe(path.join(launcherDir, 'launcher-data'))

    expect(find('exe')).toMatchObject({ action: 'delete', defaultChecked: true, kind: 'file' })
    expect(find('data')).toMatchObject({ action: 'keep', defaultChecked: false, kind: 'directory' })
    expect(find('pointer')).toMatchObject({ action: 'delete', defaultChecked: true, kind: 'file' })

    const residue = find('temp-residue-3lsynthetic')
    expect(residue, 'fixture 里的 3L* 目录应出现在计划里').toBeDefined()
    expect(residue).toMatchObject({ action: 'delete', defaultChecked: true, kind: 'directory' })
    expect(residue?.sizeBytes ?? 0).toBeGreaterThan(0)

    const keepPaths = plan.alwaysKeep.map((item) => item.path.toLowerCase())
    expect(keepPaths.some((value) => value.endsWith('\\dsh-launcher')), '始终保留区应包含 %APPDATA%\\dsh-launcher').toBe(true)
    expect(keepPaths.some((value) => value.endsWith('\\.dsh')), '始终保留区应包含 %USERPROFILE%\\.dsh').toBe(true)
    for (const item of plan.alwaysKeep) expect(item.reason.length).toBeGreaterThan(0)
    for (const item of plan.items) {
      if (item.action === 'keep') expect(item.reason.length, `keep 条目 ${item.id} 必须带 reason`).toBeGreaterThan(0)
    }
  })

  it('3L 目录里正在运行的进程会把该条目改成 keep 并给出原因', { timeout: 120_000 }, () => {
    const residueDir = path.join(fixtureTempDir, '3Lguarded')
    mkdirSync(residueDir, { recursive: true })
    const pingCopy = path.join(residueDir, 'ping.exe')
    copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'ping.exe'), pingCopy)

    const child = spawn(pingCopy, ['-n', '60', '127.0.0.1'], { cwd: residueDir, windowsHide: true, stdio: 'ignore' })
    const pid = child.pid
    try {
      expect(pid, '拷贝出来的 ping.exe 应该启动成功').toBeTypeOf('number')
      expect(waitForPid(pid as number), '等待 ping.exe 进入运行状态').toBe(true)

      const plan = runPlanFile()
      const item = plan.items.find((entry) => entry.id === 'temp-residue-3lguarded')
      expect(item, '被占用的 3L 目录仍应列出').toBeDefined()
      expect(item?.action).toBe('keep')
      expect(item?.defaultChecked).toBe(false)
      expect((item?.reason ?? '').length).toBeGreaterThan(0)
    } finally {
      child.kill()
      spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true })
    }
  })

  it('--run --yes 只删默认项，数据目录要 --delete-data 才删', { timeout: 120_000 }, () => {
    const fakeExe = path.join(launcherDir, 'FakeLauncher.exe')
    writeFileSync(fakeExe, 'x')
    const pointerFile = path.join(launcherDir, 'launcher-storage.json')
    writeFileSync(pointerFile, '{}')
    const dataDir = path.join(launcherDir, 'launcher-data')
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, 'blob.bin'), 'blob')
    const residueDir = path.join(fixtureTempDir, '3Lsynthetic')
    mkdirSync(residueDir, { recursive: true })
    writeFileSync(path.join(residueDir, 'junk.bin'), 'yy')
    const installedData = path.join(fixtureAppData, 'DSH-launcher-KEWU')
    mkdirSync(installedData, { recursive: true })
    writeFileSync(path.join(installedData, 'inst.bin'), 'inst')
    const hasRunValue = createTestRunValue()

    const first = runHeadless(['--dir', launcherDir, '--run', '--yes'])
    expect(first.status, `--run --yes 应以 0 退出（stdout: ${first.stdout} stderr: ${first.stderr}）`).toBe(0)
    expect(existsSync(fakeExe), '启动器主程序应被删除').toBe(false)
    expect(existsSync(pointerFile), '数据目录指针文件应被删除').toBe(false)
    expect(existsSync(residueDir), '自解压残留应被删除').toBe(false)
    expect(existsSync(dataDir), '默认不删本版数据目录').toBe(true)
    expect(existsSync(installedData), '默认不删安装版数据目录').toBe(true)
    if (hasRunValue) expect(testRunValueExists(), '自启项应被删除').toBe(false)

    const second = runHeadless(['--dir', launcherDir, '--run', '--yes', '--delete-data'])
    expect(second.status, `--run --yes --delete-data 应以 0 退出（stdout: ${second.stdout} stderr: ${second.stderr}）`).toBe(0)
    expect(existsSync(dataDir), '--delete-data 应删除本版数据目录').toBe(false)
    expect(existsSync(installedData), '--delete-data 应删除安装版数据目录').toBe(false)
  })

  // 真实用户的 launcher-data 里有 dsh-runtime\node_modules\.pnpm\... 这种超过 260 字符的路径，
  // .NET 的 DirectoryInfo / File.Delete 会在计划阶段就抛 PathTooLongException，卸载直接失败（2026-11-08 用户实测）。
  it('数据目录里有超过 260 字符的深路径时，--plan 能算出大小、--delete-data 能删净', { timeout: 180_000 }, () => {
    const fakeExe = path.join(launcherDir, 'FakeLauncher.exe')
    writeFileSync(fakeExe, 'x')
    const dataDir = path.join(launcherDir, 'launcher-data')
    let deep = path.join(dataDir, 'dsh-runtime')
    mkdirSync(deep, { recursive: true })
    const segment = 'nested-dependency-folder-name-that-is-long'
    for (let level = 0; level < 6; level += 1) deep = path.join(deep, segment)
    mkdirSync(deep, { recursive: true })
    const deepFile = path.join(deep, 'index.js')
    writeFileSync(deepFile, 'deep')
    expect(deepFile.length, '夹具必须真的超过 260 个字符').toBeGreaterThan(260)

    const plan = runPlanFile()
    const dataItem = plan.items.find((item) => item.id === 'data')
    expect(dataItem?.sizeBytes, '深路径也要能算出大小，而不是 0').toBeGreaterThan(0)

    const result = runHeadless(['--dir', launcherDir, '--run', '--yes', '--delete-data'])
    expect(result.status, `--delete-data 应以 0 退出（stdout: ${result.stdout} stderr: ${result.stderr}）`).toBe(0)
    expect(existsSync(dataDir), '含深路径的数据目录应被整棵删除').toBe(false)
  })
  it('缺 --yes 时拒绝执行（退出码 2）且不删任何东西', { timeout: 120_000 }, () => {
    const fakeExe = path.join(launcherDir, 'FakeLauncher.exe')
    writeFileSync(fakeExe, 'x')
    const pointerFile = path.join(launcherDir, 'launcher-storage.json')
    writeFileSync(pointerFile, '{}')

    const result = runHeadless(['--dir', launcherDir, '--run'])
    expect(result.status, '缺 --yes 应返回 2').toBe(2)
    expect(existsSync(fakeExe)).toBe(true)
    expect(existsSync(pointerFile)).toBe(true)
  })

  // 交付物是同目录三个文件：DSH-launcher-KEWU-Portable/VERSION.exe、DSH-launcher-KEWU-Setup/VERSION.exe、KEWU-Uninstaller/VERSION.exe。
  // 卸载器必须按"完整路径排除自身 + 名字含 uninstall/setup 一律排除 + 名字像启动器的优先"来挑主程序，
  // 否则字母顺序会让安装包或卸载器自己顶上。
  it('同目录有安装包与卸载器时，选中的是启动器主程序', { timeout: 120_000 }, () => {
    const realLauncher = path.join(launcherDir, 'DSH Launcher.exe')
    const setupExe = path.join(launcherDir, 'DSH-launcher-KEWU-Setup-1.0.4.exe')
    const uninstallerExe = path.join(launcherDir, 'KEWU-Uninstaller-1.0.4.exe')
    writeFileSync(realLauncher, 'launcher')
    writeFileSync(setupExe, 'setup')
    writeFileSync(uninstallerExe, 'uninstaller')

    const plan = runPlanFile()
    const exeItem = plan.items.find((item) => item.id === 'exe')

    expect(plan.exePath, '应选中启动器主程序，而不是安装包或卸载器').toBe(realLauncher)
    expect(exeItem, '应出现 exe 条目').toBeDefined()
    expect(exeItem?.path, 'exe 条目的 path 必须指向启动器主程序').toBe(realLauncher)
    expect(exeItem).toMatchObject({ action: 'delete', defaultChecked: true, kind: 'file' })

    // --plan 只扫描：三个文件一个都不该被动过。
    for (const name of ['DSH Launcher.exe', 'DSH-launcher-KEWU-Setup-1.0.4.exe', 'KEWU-Uninstaller-1.0.4.exe']) {
      expect(existsSync(path.join(launcherDir, name)), name + ' 不应被 --plan 动过').toBe(true)
    }
  })

  it('目录里只有安装包与卸载器时不选任何 exe，--plan 仍以 0 退出', { timeout: 120_000 }, () => {
    const setupExe = path.join(launcherDir, 'DSH-launcher-KEWU-Setup-1.0.4.exe')
    const uninstallerExe = path.join(launcherDir, 'KEWU-Uninstaller-1.0.4.exe')
    writeFileSync(setupExe, 'setup')
    writeFileSync(uninstallerExe, 'uninstaller')

    const plan = runPlanFile()
    const exeItem = plan.items.find((item) => item.id === 'exe')

    expect(plan.exePath, '没有启动器主程序时应返回空串').toBe('')
    if (exeItem) expect(exeItem.action, 'exe 条目若存在必须保持 keep').toBe('keep')
    expect(existsSync(setupExe), '安装包绝不能被当成主程序').toBe(true)
    expect(existsSync(uninstallerExe), '卸载器自身也不该被选中').toBe(true)
  })
})

// 只在源码层面断言，不依赖 Windows：防止有人把停靠布局改回按宽度手算坐标。
describe('uninstaller form layout guard', () => {
  it('窗体关闭自动缩放，右侧控件用停靠布局', () => {
    const source = readFileSync(path.join(repoRoot, 'tools', 'uninstaller', 'src', 'UninstallerForm.cs'), 'utf8')
    expect(source).toContain('AutoScaleMode.None')
    expect(source).not.toContain('AutoScaleMode.Dpi')
    expect(source).toContain('new FlowLayoutPanel()')
    expect(source).toContain('Dock = DockStyle.Right')
  })
})
