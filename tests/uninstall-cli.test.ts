import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createLauncherControlServer } from '../electron/launcher-control-server'
import { createUninstallPlan } from '../electron/uninstall-plan'
import { createUninstallService } from '../electron/uninstall'

const exec = promisify(execFile)
const cliPath = path.resolve('bin/launcher-control.cjs')

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uninstall-cli-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const userData = path.join(root, 'user-data')
  const installDir = path.join(root, 'app')
  const legacyDataDir = path.join(root, 'appdata', 'dsh-launcher')
  const dshHome = path.join(root, 'home', '.dsh')
  const tempDir = path.join(root, 'temp')
  for (const dir of [userData, installDir, legacyDataDir, dshHome, tempDir]) await mkdir(dir, { recursive: true })
  const executablePath = path.join(installDir, 'DSH Launcher.exe')
  await writeFile(executablePath, 'exe')
  const dataDir = path.join(installDir, 'launcher-data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, 'settings.json'), '{}')
  await writeFile(path.join(legacyDataDir, 'legacy.bin'), 'old')

  const planInput = { executablePath, installDir, dataDir, legacyDataDir, dshHome, tempDir }
  const service = createUninstallService({ plan: planInput, tempDir })
  const runs: unknown[] = []
  const server = await createLauncherControlServer({
    userData,
    execute: async request => {
      if (request.command === 'uninstall.plan') return createUninstallPlan(planInput)
      if (request.command === 'uninstall.script') {
        const out = request.args?.out
        if (typeof out !== 'string') throw new Error('缺少 out')
        return service.exportScript(out, { deleteData: request.args?.keepData !== true })
      }
      if (request.command === 'uninstall.run') {
        runs.push(request.args)
        return { started: true }
      }
      throw new Error('unexpected command: ' + request.command)
    },
  })
  cleanups.push(() => server.close())
  const run = (...args: string[]) =>
    exec(process.execPath, [cliPath, '--user-data', userData, ...args], { timeout: 15000 })
  return { root, run, planInput, runs }
}

describe('uninstall CLI', () => {
  it('uninstall plan --json 退出码 0 并给出完整计划结构', async () => {
    const f = await fixture()
    const result = await f.run('uninstall', 'plan', '--json')
    const plan = JSON.parse(result.stdout)
    expect(plan.executablePath).toBe(f.planInput.executablePath)
    expect(plan.installDir).toBe(f.planInput.installDir)
    expect(plan.dataDir).toBe(f.planInput.dataDir)
    expect(Array.isArray(plan.items)).toBe(true)
    expect(plan.items.map((item: { id: string }) => item.id)).toContain('exe')
    expect(plan.items.map((item: { id: string }) => item.id)).toContain('legacy-data')
    for (const item of plan.items) {
      expect(typeof item.path).toBe('string')
      expect(['file', 'directory', 'registry']).toContain(item.kind)
      expect(['delete', 'keep']).toContain(item.action)
    }
    expect(plan.deleteBytes).toBeGreaterThan(0)
    expect(plan.keepBytes).toBeGreaterThan(0)
    expect(Array.isArray(plan.warnings)).toBe(true)
  })

  it('uninstall plan 不带 --json 时输出缩进 JSON', async () => {
    const f = await fixture()
    const result = await f.run('uninstall', 'plan')
    expect(result.stdout).toContain('\n  "items":')
    expect(JSON.parse(result.stdout).dataDir).toBe(f.planInput.dataDir)
  })

  it('uninstall script 缺 --out 时中文报错并退出 1', async () => {
    const f = await fixture()
    await expect(f.run('uninstall', 'script')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('uninstall script 需要一个导出目录'),
    })
  })

  it('uninstall script --out 写出 ps1 与 cmd，--keep-data 时不含 -DeleteData', async () => {
    const f = await fixture()
    const out = path.join(f.root, 'export')
    const result = JSON.parse((await f.run('uninstall', 'script', '--out', out, '--json')).stdout)
    expect(result.scriptPath).toBe(path.join(out, 'uninstall-kewu.ps1'))
    expect(result.commandPath).toBe(path.join(out, 'uninstall-kewu.cmd'))

    const script = await readFile(result.scriptPath, 'utf8')
    expect(script.charCodeAt(0)).toBe(0xfeff)
    expect(script).toContain(f.planInput.executablePath)
    expect(script).toContain('Get-Process -Id $WaitPid')
    const command = await readFile(result.commandPath, 'utf8')
    expect(command).toContain('%~dp0uninstall-kewu.ps1')
    expect(command).toContain('-DeleteData')

    const keepOut = path.join(f.root, 'export-keep')
    const keepResult = JSON.parse(
      (await f.run('uninstall', 'script', '--out', keepOut, '--keep-data', '--json')).stdout,
    )
    const keepCommand = await readFile(keepResult.commandPath, 'utf8')
    expect(keepCommand).not.toContain('-DeleteData')
  })

  it('uninstall now 缺 --yes 时拒绝执行', async () => {
    const f = await fixture()
    await expect(f.run('uninstall', 'now')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('--yes'),
    })
    expect(f.runs).toEqual([])
  })

  it('uninstall now --yes --keep-data 把确认与保留数据意图交给服务', async () => {
    const f = await fixture()
    const result = JSON.parse((await f.run('uninstall', 'now', '--keep-data', '--yes', '--json')).stdout)
    expect(result).toEqual({ started: true })
    expect(f.runs).toEqual([{ keepData: true, confirm: true }])
    const plain = JSON.parse((await f.run('uninstall', 'now', '--yes', '--json')).stdout)
    expect(plain).toEqual({ started: true })
    expect(f.runs[1]).toEqual({ confirm: true })
  })

  it('未知的 uninstall 子命令给出中文用法', async () => {
    const f = await fixture()
    await expect(f.run('uninstall')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('uninstall plan'),
    })
  })
})
