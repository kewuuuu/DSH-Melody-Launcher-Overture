import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'
import { normalizeVersion } from './dsh-release'
import type { ProcessIdentity } from './pack-ownership'
import { parseExactResume, type ExactResumeInput } from './pending-resume'

export const UPDATE_CONTINUATION_FLAG = '--update-continuation='
const HANDOFF_LIFETIME_MS = 30 * 60_000

export interface PreservedRuntime extends ProcessIdentity {
  port: number
}

export interface UpdateContinuation {
  operationId: string
  resume: ExactResumeInput
  runtime: PreservedRuntime
  handoff: { toVersion: string; expiresAt: number } | null
}

export function isUpdateOperationId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
}

export function samePreservedRuntime(first: PreservedRuntime, second: PreservedRuntime | undefined): boolean {
  return second !== undefined && first.pid === second.pid && first.creationFileTime === second.creationFileTime && first.port === second.port
}

export function armUpdateContinuation(entry: UpdateContinuation, toVersion: string, now: number): UpdateContinuation {
  return { ...entry, handoff: { toVersion: normalizeVersion(toVersion), expiresAt: now + HANDOFF_LIFETIME_MS } }
}

function continuationPath(userData: string): string {
  return path.join(userData, 'launcher-update', 'session-continuation.json')
}

export async function saveUpdateContinuation(userData: string, entry: UpdateContinuation): Promise<void> {
  await writeFileAtomic(continuationPath(userData), JSON.stringify(entry), { mode: 0o600 })
}

export async function clearUpdateContinuation(userData: string): Promise<void> {
  await rm(continuationPath(userData), { force: true })
}

const claiming = new Set<string>()

async function claimUpdateContinuation(userData: string, operationId: string): Promise<UpdateContinuation | null> {
  const file = continuationPath(userData)
  if (claiming.has(file)) return null
  claiming.add(file)
  try {
    const entry = JSON.parse(await readFile(file, 'utf8')) as UpdateContinuation
    if (entry?.operationId !== operationId) return null
    // Claim before the POST so interruption or an uncertain response cannot trigger a duplicate.
    await clearUpdateContinuation(userData)
    return entry
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || error instanceof SyntaxError) return null
    throw error
  } finally {
    claiming.delete(file)
  }
}

export async function consumeUpdateContinuation(options: {
  userData: string
  argv: readonly string[]
  version: string
  reconciled: boolean
  findRuntime: (packId: string) => Promise<{ identity: PreservedRuntime; url: string } | null>
  deliver: (resume: ExactResumeInput & { requestId: string; baseUrl: string }) => Promise<void>
  now?: () => number
}): Promise<boolean> {
  const flags = options.argv.filter(value => value.startsWith(UPDATE_CONTINUATION_FLAG))
  if (flags.length !== 1 || !options.argv.includes('--adopt-running-packs')) return false
  const operationId = flags[0].slice(UPDATE_CONTINUATION_FLAG.length)
  if (!isUpdateOperationId(operationId)) return false
  const entry = await claimUpdateContinuation(options.userData, operationId)
  if (!entry || !options.reconciled || !entry.handoff || entry.handoff.toVersion !== normalizeVersion(options.version)
    || !Number.isFinite(entry.handoff.expiresAt) || entry.handoff.expiresAt <= (options.now ?? Date.now)()
    || !entry.runtime || !Number.isSafeInteger(entry.runtime.pid) || entry.runtime.pid < 1
    || !Number.isSafeInteger(entry.runtime.port) || entry.runtime.port < 1 || entry.runtime.port > 65535
    || typeof entry.runtime.creationFileTime !== 'string' || !/^[1-9][0-9]{0,19}$/.test(entry.runtime.creationFileTime)) return false
  const resume = parseExactResume(entry.resume)
  const runtime = await options.findRuntime(resume.packId)
  if (!runtime || !samePreservedRuntime(entry.runtime, runtime.identity)) return false
  await options.deliver({ ...resume, requestId: operationId, baseUrl: runtime.url })
  return true
}
