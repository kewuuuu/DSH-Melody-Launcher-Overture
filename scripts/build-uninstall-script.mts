// 把 electron/uninstall-script.ts 里的模板写成仓库里的 tools/uninstall-kewu.ps1。
// 仓库那份是离线版（必须显式传 -ExePath），测试会断言它与模板逐字一致。
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildUninstallScript, UNINSTALL_SCRIPT_BOM } from '../electron/uninstall-script'

const target = path.resolve('tools/uninstall-kewu.ps1')
const text = buildUninstallScript({ executablePath: '', dataDir: '' })
await writeFile(target, UNINSTALL_SCRIPT_BOM + text, 'utf8')
console.log('written ' + target)
