#!/usr/bin/env node
// 发版准备：一条命令做完前置校验、打印三件产物的构建命令，产物齐了再打印可粘贴的交付表
// （文件名 / 字节 / SHA256）。它不执行构建、不 git add/commit/push/tag —— 发版动作由人执行。
//
//   node scripts/release.mjs                 校验工作树 + 打印构建命令（产物已存在则打印交付表）
//   node scripts/release.mjs --notes         生成 docs/release-v<版本>.md 骨架（不覆盖已有文件）
//   node scripts/release.mjs --allow-dirty   工作树有未提交改动时仍然继续
//   node scripts/release.mjs --dir <目录>    指定产物目录（默认 release/b<下一个构建号>）
//   node scripts/release.mjs --help
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_MANIFEST = path.join(repoRoot, 'package.json')
const CONSTANTS_FILE = path.join(repoRoot, 'src', 'constants.ts')

const HELP = `用法：node scripts/release.mjs [选项]

校验工作树是否干净、打印当前版本与三件产物的构建命令（便携版 / 安装包 / 卸载器），
产物就绪后计算 SHA256 并打印可直接粘贴的交付表。脚本自己不会执行构建，也不会
git tag / git push / gh release —— 这些发版动作由人执行。

选项：
  --notes         生成 docs/release-v<版本>.md 骨架；文件已存在时保留原样
  --allow-dirty   工作树有未提交改动时不中止
  --dir <目录>    指定产物目录（默认 release/b<下一个构建号>）
  -h, --help      打印本说明`

function parseArgs(argv) {
  const options = { notes: false, allowDirty: false, dir: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--notes') options.notes = true
    else if (arg === '--allow-dirty') options.allowDirty = true
    else if (arg === '--dir') {
      const value = argv[index + 1]
      if (!value) throw new Error('--dir 需要一个目录参数。')
      options.dir = value
      index += 1
    } else throw new Error(`未知参数：${arg}（用 --help 看用法）`)
  }
  return options
}

function readVersion() {
  const manifest = JSON.parse(readFileSync(PACKAGE_MANIFEST, 'utf8'))
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('package.json 里没有可用的 version。')
  }
  return manifest.version.trim()
}

/** Release 仓库从 src/constants.ts 读，避免脚本里再抄一份仓库名。 */
function readReleaseRepository() {
  const source = readFileSync(CONSTANTS_FILE, 'utf8')
  const matched = /LAUNCHER_RELEASE_REPOSITORY\s*=\s*'([^']+)'/.exec(source)
  return matched ? matched[1] : null
}

/**
 * 默认产物目录。release/b<N> 是仓库里的构建轮次目录（b3…b14）：
 * ① 从大到小找第一个装着「当前版本便携版」的目录 —— 构建完再跑一次本脚本要能认出它，
 *    否则每次都跳到下一个编号，产明明建好了却报「还缺 3 件产物」；
 * ② 一个都没有才用「最大编号 + 1」。
 */
export function resolveOutputDir(version, options = {}) {
  const root = options.root ?? repoRoot
  const releaseRoot = path.join(root, 'release')
  const builds = existsSync(releaseRoot)
    ? readdirSync(releaseRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => /^b(\d+)$/.exec(entry.name))
        .filter(Boolean)
        .map(matched => ({ name: matched[0], number: Number(matched[1]) }))
        .sort((left, right) => right.number - left.number)
    : []
  const portable = `DSH-launcher-KEWU-Portable-${version}.exe`
  for (const build of builds) {
    if (existsSync(path.join(releaseRoot, build.name, portable))) {
      return { dir: path.join('release', build.name), reused: true }
    }
  }
  const next = builds.length > 0 ? builds[0].number + 1 : 1
  return { dir: path.join('release', `b${next}`), reused: false }
}

function gitStatusPorcelain() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })
  if (result.error) throw new Error(`无法执行 git：${result.error.message}`)
  if (result.status !== 0) throw new Error((result.stderr || 'git status 失败。').trim())
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

function artifactList(version) {
  return [
    { label: '便携版', name: `DSH-launcher-KEWU-Portable-${version}.exe` },
    { label: '安装包', name: `DSH-launcher-KEWU-Setup-${version}.exe` },
    { label: '卸载器', name: `DSH-launcher-KEWU-Uninstaller-${version}.exe` },
  ]
}

function buildCommands(version, outputDir) {
  const uninstaller = path.join(outputDir, `DSH-launcher-KEWU-Uninstaller-${version}.exe`)
  return [
    { label: '便携版', command: `npm run package:win -- -c.directories.output=${outputDir}` },
    { label: '安装包', command: `npx electron-builder --win nsis -c.directories.output=${outputDir}` },
    {
      label: '卸载器',
      command: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-uninstaller.ps1 -OutputPath "${uninstaller}"`,
    },
  ]
}

function sha256Of(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toUpperCase()
}

function printDeliveryTable(version, outputDir, repository) {
  const rows = artifactList(version).map(artifact => {
    const filePath = path.join(repoRoot, outputDir, artifact.name)
    return { ...artifact, filePath, bytes: statSync(filePath).size, sha256: sha256Of(filePath) }
  })
  const tag = `v${version}`
  const table = [
    '| 产物 | 文件 | 字节 | SHA256 |',
    '| --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.label} | \`${row.name}\` | ${row.bytes.toLocaleString('en-US')} | \`${row.sha256}\` |`),
  ]
  const upload = repository
    ? `gh release upload ${tag} "${outputDir}"/*.exe --clobber --repo ${repository}`
    : `gh release upload ${tag} "${outputDir}"/*.exe --clobber`
  return { table, upload }
}

function notesSkeleton(version, repository) {
  const repo = repository ?? 'kewuuuu/DSH-Melody-Launcher-Overture'
  return `# v${version} — <一句话标题>

一句话版本：**<这一版最要紧的一件事>**

## 新功能

- 待填写

## 修复

- 待填写

## 升级说明

- 便携版：覆盖旧的 exe 即可。
- 安装版：直接运行 \`DSH-launcher-KEWU-Setup-${version}.exe\` 覆盖安装；也可以在启动器内点「检查更新」，它会下载 Setup 并启动安装程序（需要管理员确认）。
- 自更新与官方整合包的 Release 已迁到 \`${repo}\`。

## 验证

- \`npx tsc --noEmit\` / \`npx vitest run\`：待填写
- 三件产物 SHA256：待填写（\`node scripts/release.mjs\` 会打印）

## 已知限制

- 产物未做代码签名，SmartScreen 拦截时选择「更多信息 → 仍要运行」。
`
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }
  const version = readVersion()
  const repository = readReleaseRepository()

  if (options.notes) {
    const target = path.join(repoRoot, 'docs', `release-v${version}.md`)
    if (existsSync(target)) {
      console.log(`已存在，保持原样：${path.relative(repoRoot, target)}`)
      return
    }
    writeFileSync(target, notesSkeleton(version, repository), 'utf8')
    console.log(`已生成发版说明骨架：${path.relative(repoRoot, target)}`)
    return
  }

  const dirty = gitStatusPorcelain()
  if (dirty.length > 0 && !options.allowDirty) {
    console.error('工作树不干净，先提交或暂存这些改动再发版（确认无碍可加 --allow-dirty）：')
    for (const line of dirty.slice(0, 20)) console.error('  ' + line)
    if (dirty.length > 20) console.error(`  … 另外 ${dirty.length - 20} 条`)
    process.exitCode = 1
    return
  }

  const resolved = options.dir
    ? { dir: options.dir.replace(/[\\/]+$/, ''), reused: false }
    : resolveOutputDir(version, { root: repoRoot })
  const outputDir = resolved.dir
  console.log(`当前版本：${version}`)
  console.log(`发布仓库：${repository ?? '<未从 src/constants.ts 读到 LAUNCHER_RELEASE_REPOSITORY>'}`)
  if (resolved.reused) console.log(`发现已构建的产物目录：${outputDir}（已含 DSH-launcher-KEWU-Portable-${version}.exe）`)
  else console.log(`产物目录：${outputDir}`)
  console.log('')

  const missing = artifactList(version).filter(artifact => !existsSync(path.join(repoRoot, outputDir, artifact.name)))
  if (missing.length > 0) {
    console.log('按顺序执行下面三条构建命令（脚本不代跑）：')
    buildCommands(version, outputDir).forEach((step, index) => {
      console.log(`  ${index + 1}. [${step.label}] ${step.command}`)
    })
    console.log('')
    console.log(`还缺 ${missing.length} 件产物：${missing.map(item => item.name).join('、')}`)
    console.log('构建完成后再跑一次本脚本，即可得到带 SHA256 的交付表。')
    return
  }

  const delivery = printDeliveryTable(version, outputDir, repository)
  console.log('三件产物齐了，直接粘贴：')
  console.log('')
  delivery.table.forEach(line => console.log(line))
  console.log('')
  console.log(`发布（由人执行，脚本不代跑）：${delivery.upload}`)
  console.log(`发版说明骨架：node scripts/release.mjs --notes → docs/release-v${version}.md`)
}

// 被 import（测试）时只导出函数，不执行 CLI。
const invokedDirectly = process.argv[1]
  ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
  : false

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
