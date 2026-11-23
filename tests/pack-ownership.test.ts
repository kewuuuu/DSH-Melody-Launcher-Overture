import { fork, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import koffi from 'koffi'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPackIdentity, matchesPackIdentity, readProcessIdentity, tryClaimPackOwnership, verifyProcessIdentity } from '../electron/pack-ownership'

const roots: string[] = []
const children: ChildProcess[] = []
const require = createRequire(import.meta.url)
const contender = fileURLToPath(new URL('./fixtures/pack-ownership-contender.ts', import.meta.url))
const runner = path.join(path.dirname(require.resolve('vite-node/package.json')), 'dist', 'cli.mjs')

async function exitContender(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exit = once(child, 'exit')
  if (child.connected) child.send('exit')
  await exit
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(exitContender))
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function createHome(): Promise<string> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'launcher-ownership-'))
  roots.push(home)
  await mkdir(path.join(home, 'profiles', 'Alpha'), { recursive: true })
  await mkdir(path.join(home, 'profiles', 'Beta'))
  return home
}

async function startContender(home: string, profile: string): Promise<ChildProcess> {
  const child = fork(runner, [contender, home, profile], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  children.push(child)
  const [message] = await once(child, 'message')
  expect(message).toBe('ready')
  return child
}

async function raceClaims(children: ChildProcess[]): Promise<unknown[]> {
  return Promise.all(children.map(async child => {
    const result = once(child, 'message')
    child.send('claim')
    const [status] = await result
    return status
  }))
}

describe.skipIf(process.platform !== 'win32')('Windows pack ownership', () => {
  it('canonicalizes junction and case aliases, and compares both metadata paths', async () => {
    const home = await createHome()
    const other = await createHome()
    const alias = path.join(other, 'alias')
    await symlink(home, alias, 'junction')
    const expected = await canonicalPackIdentity(home, 'Alpha')
    expect(await canonicalPackIdentity(alias, 'alpha')).toEqual(expected)
    expect(matchesPackIdentity(expected, JSON.parse(JSON.stringify(expected)))).toBe(true)
    expect(matchesPackIdentity(expected, { ...expected, homePath: other })).toBe(false)
    expect(matchesPackIdentity(expected, await canonicalPackIdentity(home, 'Beta'))).toBe(false)
    expect(tryClaimPackOwnership({ ...expected }).status).toBe('unavailable')
    await expect(canonicalPackIdentity(home, '../Alpha')).rejects.toThrow()
    await expect(canonicalPackIdentity(home, 'Missing')).rejects.toThrow()
  })

  it('holds independent claims and only releases the handle belonging to each holder', async () => {
    const home = await createHome()
    const other = await createHome()
    const [alpha, beta, otherAlpha] = await Promise.all([
      canonicalPackIdentity(home, 'Alpha'), canonicalPackIdentity(home, 'Beta'), canonicalPackIdentity(other, 'Alpha'),
    ])
    const claims = [alpha, beta, otherAlpha].map(tryClaimPackOwnership)
    try {
      expect(claims.map(claim => claim.status)).toEqual(['claimed', 'claimed', 'claimed'])
      const first = claims[0]
      if (first.status !== 'claimed') throw new Error('Expected first ownership claim')
      expect(tryClaimPackOwnership(alpha).status).toBe('busy')
      first.release()
      const replacement = tryClaimPackOwnership(alpha)
      claims.push(replacement)
      expect(replacement.status).toBe('claimed')
      first.release()
      expect(tryClaimPackOwnership(alpha).status).toBe('busy')
    } finally {
      for (const claim of claims) if (claim.status === 'claimed') claim.release()
    }
  })

  it('lets exactly one process claim each round, including after the owner exits without release', async () => {
    const home = await createHome()
    const other = await createHome()
    const alias = path.join(other, 'alias')
    await symlink(home, alias, 'junction')
    const pair = () => Promise.all([startContender(home, 'Alpha'), startContender(alias, 'alpha')])
    const initial = await pair()
    const statuses = await raceClaims(initial)
    expect([...statuses].sort()).toEqual(['busy', 'claimed'])
    const owner = initial[statuses.indexOf('claimed')]
    const identity = readProcessIdentity(owner.pid!)
    expect(identity.status).toBe('alive')
    if (identity.status !== 'alive') throw new Error('Missing contender process identity')
    expect(verifyProcessIdentity(identity.identity)).toBe('match')
    await exitContender(owner)
    expect(readProcessIdentity(owner.pid!).status).toBe('absent')
    expect(verifyProcessIdentity(identity.identity)).toBe('absent')
    expect((await raceClaims(await pair())).sort()).toEqual(['busy', 'claimed'])
  }, 30_000)

  it('blocks another process while the holder renames and replaces the profile directory', async () => {
    const home = await createHome()
    const pack = await canonicalPackIdentity(home, 'Alpha')
    const claim = tryClaimPackOwnership(pack)
    if (claim.status !== 'claimed') throw new Error('Expected ownership claim')
    try {
      const retired = path.join(home, 'profiles', 'Retired')
      await rename(pack.profilePath, retired)
      await mkdir(path.join(home, 'profiles', 'alpha'))
      await expect(readdir(retired)).resolves.toEqual([])
      expect((await readdir(path.join(home, 'profiles'))).sort()).toEqual(['Beta', 'Retired', 'alpha'])
      const child = await startContender(home, 'Alpha')
      expect(await raceClaims([child])).toEqual(['busy'])
      claim.release()
      expect(await raceClaims([child])).toEqual(['claimed'])
    } finally {
      claim.release()
    }
  })

  it('fails closed when Windows denies access to the named claim', async () => {
    const home = await createHome()
    const pack = await canonicalPackIdentity(home, 'Alpha')
    const kernel = koffi.load('kernel32.dll')
    const advapi = koffi.load('advapi32.dll')
    const close = kernel.func('int __stdcall CloseHandle(void *)')
    const convert = advapi.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32_t, _Out_ void **, void *)')
    const free = kernel.func('void * __stdcall LocalFree(void *)')
    const SecurityAttributes = koffi.struct({ length: 'uint32_t', descriptor: 'void *', inherit: 'int' })
    const descriptor = [null]
    expect(convert('D:', 1, descriptor, null)).toBe(1) // Empty DACL denies all access.
    const createWithSecurity = kernel.func('CreateEventExW', 'void *', [koffi.pointer(SecurityAttributes), 'str16', 'uint32_t', 'uint32_t'])
    const key = createHash('sha256').update(pack.profilePath.toLowerCase()).digest('hex')
    try {
      const handle = createWithSecurity({ length: koffi.sizeof(SecurityAttributes), descriptor: descriptor[0], inherit: 0 }, 'Global\\LauncherOverturePackOwner-' + key, 0, 0x100000)
      expect(handle).toBeTruthy()
      try {
        expect(tryClaimPackOwnership(pack)).toEqual({ status: 'unavailable', reason: 'CreateEventExW failed with Windows error 5' })
      } finally {
        if (handle) close(handle)
      }
    } finally {
      free(descriptor[0])
    }
  })

  it('rejects stale creation identity with a live PID, protected processes, and invalid metadata', () => {
    const own = readProcessIdentity(process.pid)
    expect(own.status).toBe('alive')
    if (own.status !== 'alive') throw new Error('Missing current process identity')
    expect(verifyProcessIdentity(JSON.parse(JSON.stringify(own.identity)))).toBe('match')
    expect(verifyProcessIdentity({ ...own.identity, creationFileTime: '1' })).toBe('mismatch')
    expect(verifyProcessIdentity({ ...own.identity, creationFileTime: '18446744073709551616' })).toBe('unavailable')
    expect(verifyProcessIdentity({ pid: 4, creationFileTime: '1' })).toBe('unavailable')
    expect(verifyProcessIdentity({ pid: process.pid })).toBe('unavailable')
  })
})
