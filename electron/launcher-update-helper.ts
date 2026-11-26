import path from 'node:path'
import { isUpdateOperationId } from './update-continuation'

const INVALID_PATH_CHARS = /[\x00-\x1f<>:"|?*]/
const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i

function validPathPart(part: string): boolean {
  return Boolean(part) && !INVALID_PATH_CHARS.test(part) && !/[. ]$/.test(part) && !RESERVED_NAME.test(part)
}

/** NSIS takes the raw remainder after /D= as the directory, including spaces. */
export function buildInstallDirArgument(installDir: string): string {
  const value = installDir.replaceAll('/', '\\')
  const root = path.win32.parse(value).root
  const parts = value.slice(root.length).split('\\')
  const drive = /^[a-z]:\\$/i.test(root)
  const shareParts = root.slice(2).replace(/\\$/, '').split('\\')
  const share = root.startsWith('\\\\') && shareParts.length === 2 && shareParts.every(validPathPart)
  if ((!drive && !share) || !parts.every(validPathPart)) {
    throw new Error('安装目录不是可安全传给安装程序的绝对路径，请手动运行下载好的安装包。')
  }
  return '/D=' + value
}

export function installDirFromExecPath(execPath: string): string {
  const exe = path.win32.basename(execPath)
  if (/[\\/]$/.test(execPath) || !validPathPart(exe) || !exe.toLowerCase().endsWith('.exe')) {
    throw new Error('找不到当前安装目录，已中止更新。')
  }
  const dir = path.win32.dirname(execPath)
  buildInstallDirArgument(dir)
  return dir
}

function validatePid(pid: number): void {
  if (!Number.isInteger(pid) || pid < 1 || pid > 0xffff_ffff) {
    throw new Error('Invalid launcher process ID')
  }
}

/** Launcher and Setup append to the same handoff log beside the installer. */
export function buildApplyLogPath(updateRoot: string, pid: number): string {
  validatePid(pid)
  return path.join(updateRoot, 'handoff-' + pid + '.log')
}

export function buildInstallerArgs(input: {
  pid: number
  installDir: string
  operationId?: string
  useCacheRoot?: boolean
}): string[] {
  validatePid(input.pid)
  const args = ['/S', '--dsh-handoff=' + input.pid]
  if (input.operationId !== undefined) {
    if (!isUpdateOperationId(input.operationId) || input.operationId.length !== 36) {
      throw new Error('Invalid launcher update continuation ID')
    }
    args.push('--dsh-continue=' + input.operationId)
  }
  if (input.useCacheRoot) args.push('--dsh-use-cache-root=1')
  args.push(buildInstallDirArgument(input.installDir))
  return args
}
