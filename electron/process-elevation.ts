import { execFile } from 'node:child_process'

/**
 * 判断启动器自己是不是以管理员身份运行。
 * 只有提权过的进程才能让子进程直接继承管理员令牌，所以这个判断决定要不要再弹 UAC。
 */
const PROBE_SCRIPT = [
  'Add-Type -MemberDefinition ' + "'" + '[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetCurrentProcess(); [DllImport("kernel32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token); [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int infoClass, out int value, int length, out int returned); [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle); public static bool IsElevated() { IntPtr token; int value; int returned; if (!OpenProcessToken(GetCurrentProcess(), 8, out token)) return false; try { if (!GetTokenInformation(token, 20, out value, 4, out returned)) return false; } finally { CloseHandle(token); } return value != 0; }' + "'" + ' -Name Elevation -Namespace Kewu | Out-Null',
  '[Console]::Out.Write([Kewu.Elevation]::IsElevated())',
].join('\n')

let cached: Promise<boolean> | null = null
let warned = false

/** PowerShell 只回 True/False；多出来的警告行跳过，取最后一行有效答案。 */
export function parseElevationProbe(output: string): boolean | null {
  const lines = output.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  const last = lines[lines.length - 1]
  if (last === undefined) return null
  if (/^true$/i.test(last)) return true
  if (/^false$/i.test(last)) return false
  return null
}

function runProbe(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT], { windowsHide: true, timeout: 20_000 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
}

export async function isProcessElevated(): Promise<boolean> {
  // 非 Windows 没有 UAC 这一层，按未提权处理，调用方自然回落到原有路径。
  if (process.platform !== 'win32') return false
  if (cached) return cached
  cached = runProbe()
    .then(output => parseElevationProbe(output) ?? false)
    .catch(error => {
      // 探针失败不等于提权：宁可弹一次 UAC，也不要让普通权限的进程假装自己是管理员。
      if (!warned) {
        warned = true
        console.warn('[process-elevation] 检测管理员权限失败，按未提权处理：', error instanceof Error ? error.message : String(error))
      }
      return false
    })
  return cached
}

/** 测试用：清掉结果与告警去重标记，下一次调用会重新探测。 */
export function resetProcessElevationCache(): void {
  cached = null
  warned = false
}
