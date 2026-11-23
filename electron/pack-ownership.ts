import { createHash } from 'node:crypto'
import { realpath } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import koffi from 'koffi'

export interface PackIdentity {
  readonly homePath: string
  readonly profilePath: string
}

export interface ProcessIdentity {
  readonly pid: number
  readonly creationFileTime: string
}

export type ProcessIdentityRead =
  | { status: 'alive'; identity: ProcessIdentity }
  | { status: 'absent' | 'unavailable' }

export type ProcessIdentityCheck = 'match' | 'mismatch' | 'absent' | 'unavailable'

export type PackOwnershipClaim =
  | { status: 'claimed'; release: () => void }
  | { status: 'busy' }
  | { status: 'unavailable'; reason: string }

const canonicalPath = promisify(realpath.native)
const canonicalIdentities = new WeakSet<PackIdentity>()

export async function canonicalPackIdentity(home: string, profileName: string): Promise<PackIdentity> {
  if (!path.isAbsolute(home) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profileName) || profileName.endsWith('.')) {
    throw new Error('Expected an absolute pack home and a valid profile name')
  }
  const homePath = await canonicalPath(home)
  const profilePath = await canonicalPath(path.join(homePath, 'profiles', profileName))
  if (!(await stat(profilePath)).isDirectory()) throw new Error('Pack profile must be a directory')
  const identity = Object.freeze({ homePath, profilePath })
  canonicalIdentities.add(identity)
  return identity
}

export function matchesPackIdentity(expected: PackIdentity, recorded: unknown): boolean {
  if (!canonicalIdentities.has(expected) || !recorded || typeof recorded !== 'object') return false
  const identity = recorded as Partial<PackIdentity>
  return identity.homePath === expected.homePath && identity.profilePath === expected.profilePath
}

function loadKernel() {
  const lib = koffi.load('kernel32.dll')
  return {
    openProcess: lib.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
    waitForSingleObject: lib.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)'),
    getProcessTimes: lib.func('int __stdcall GetProcessTimes(void *handle, void *creation, void *exit, void *kernel, void *user)'),
    createEvent: lib.func('void * __stdcall CreateEventExW(void *security, str16 name, uint32_t flags, uint32_t access)'),
    setLastError: lib.func('void __stdcall SetLastError(uint32_t code)'),
    closeHandle: lib.func('int __stdcall CloseHandle(void *handle)'),
    lastError: lib.func('uint32_t __stdcall GetLastError()'),
  }
}

let kernel: ReturnType<typeof loadKernel> | undefined
function windowsKernel() {
  if (process.platform !== 'win32') throw new Error('Pack ownership requires Windows')
  return kernel ??= loadKernel()
}

function validPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff
}

export function readProcessIdentity(pid: number): ProcessIdentityRead {
  if (!validPid(pid)) return { status: 'unavailable' }
  try {
    const native = windowsKernel()
    // PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE
    const handle = native.openProcess(0x101000, 0, pid)
    if (!handle) return { status: native.lastError() === 87 ? 'absent' : 'unavailable' }
    try {
      const creation = Buffer.alloc(8)
      if (!native.getProcessTimes(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) {
        return { status: 'unavailable' }
      }
      const wait = native.waitForSingleObject(handle, 0)
      if (wait === 0) return { status: 'absent' }
      const fileTime = creation.readBigUInt64LE()
      if (wait !== 258 || fileTime === 0n) return { status: 'unavailable' }
      return { status: 'alive', identity: { pid, creationFileTime: fileTime.toString() } }
    } finally {
      native.closeHandle(handle)
    }
  } catch {
    return { status: 'unavailable' }
  }
}

export function verifyProcessIdentity(expected: unknown): ProcessIdentityCheck {
  if (!expected || typeof expected !== 'object') return 'unavailable'
  const { pid, creationFileTime } = expected as Partial<ProcessIdentity>
  if (!validPid(pid) || typeof creationFileTime !== 'string' || !/^[1-9][0-9]{0,19}$/.test(creationFileTime) ||
      BigInt(creationFileTime) > 0xffffffffffffffffn) return 'unavailable'
  const current = readProcessIdentity(pid)
  if (current.status !== 'alive') return current.status
  return current.identity.creationFileTime === creationFileTime ? 'match' : 'mismatch'
}

export function tryClaimPackOwnership(identity: PackIdentity): PackOwnershipClaim {
  if (!canonicalIdentities.has(identity)) return { status: 'unavailable', reason: 'Expected a freshly resolved pack identity' }
  try {
    const native = windowsKernel()
    // The event name stays reserved while the holder's non-inheritable handle is open.
    const key = createHash('sha256').update(identity.profilePath.toLowerCase()).digest('hex')
    const name = 'Global\\LauncherOverturePackOwner-' + key
    native.setLastError(0)
    const handle = native.createEvent(null, name, 0, 0x100000) // SYNCHRONIZE
    const error = native.lastError()
    if (!handle) return { status: 'unavailable', reason: 'CreateEventExW failed with Windows error ' + error }
    if (error !== 0) {
      if (!native.closeHandle(handle)) return { status: 'unavailable', reason: 'Could not close the competing pack ownership handle' }
      if (error === 183) return { status: 'busy' }
      return { status: 'unavailable', reason: 'Could not verify pack ownership (Windows error ' + error + ')' }
    }
    let released = false
    return { status: 'claimed', release() {
      if (released) return
      if (!native.closeHandle(handle)) throw new Error('Could not close the pack ownership handle')
      released = true
    } }
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}
