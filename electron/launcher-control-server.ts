import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface LauncherControlRequest {
  command: string
  packId?: string
  args?: Record<string, unknown>
}
export const LAUNCHER_CONTROL_FILENAME = 'launcher-control.json'
export const MAX_CONTROL_PAYLOAD = 64 * 1024

export async function createLauncherControlServer(options: {
  userData: string
  execute: (request: LauncherControlRequest) => Promise<unknown>
}): Promise<{ close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex')
  const endpointPath = path.join(options.userData, LAUNCHER_CONTROL_FILENAME)
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      if (res.destroyed || res.writableEnded) return
      let body: string
      try { body = JSON.stringify(value) } catch { status = 500; body = JSON.stringify({ ok: false, error: { code: 'SERIALIZATION_ERROR', message: 'Control result is not JSON serializable' } }) }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'close' })
      res.end(body)
    }
    const reject = (status: number, code: string, message: string) => reply(status, { ok: false, error: { code, message } })
    const supplied = Buffer.from(req.headers.authorization || '')
    const expected = Buffer.from('Bearer ' + token)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reject(401, 'UNAUTHORIZED', 'Launcher authentication failed'); req.resume(); return }
    if (req.headers.origin) { reject(403, 'FORBIDDEN_ORIGIN', 'Browser origins are not accepted'); req.resume(); return }
    if (req.method !== 'POST' || req.url !== '/control') { reject(404, 'NOT_FOUND', 'Use POST /control'); req.resume(); return }
    let size = 0
    const chunks: Buffer[] = []
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_CONTROL_PAYLOAD) { reject(413, 'PAYLOAD_TOO_LARGE', 'Control payload exceeds 64 KiB'); return }
        chunks.push(Buffer.from(chunk))
      }
      let request: LauncherControlRequest
      try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { reject(400, 'INVALID_JSON', 'Control payload must be JSON'); return }
      if (!request || typeof request !== 'object' || Array.isArray(request)
        || typeof request.command !== 'string' || !/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/.test(request.command)
        || (request.packId !== undefined && (typeof request.packId !== 'string' || !request.packId.trim()))
        || (request.args !== undefined && (!request.args || typeof request.args !== 'object' || Array.isArray(request.args)))) {
        reject(400, 'INVALID_REQUEST', 'Expected command, optional packId and object args'); return
      }
      if (/^pack\.(start|stop|restart|config\.(get|set))$/.test(request.command) && !request.packId) { reject(400, 'PACK_ID_REQUIRED', 'An explicit packId is required'); return }
      try { reply(200, { ok: true, result: await options.execute(request) ?? null }) }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'COMMAND_FAILED'
        reject(422, code, message.split(token).join('[redacted]'))
      }
    } catch { reject(400, 'REQUEST_FAILED', 'Could not read control request') }
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() }) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not bind launcher control')
  const metadata = JSON.stringify({ version: 1, url: 'http://127.0.0.1:' + address.port + '/control', token, pid: process.pid })
  const temporary = endpointPath + '.' + randomBytes(8).toString('hex') + '.tmp'
  try {
    await mkdir(options.userData, { recursive: true })
    await writeFile(temporary, metadata, { mode: 0o600, flag: 'wx' })
    await rename(temporary, endpointPath)
  } catch (error) { await rm(temporary, { force: true }); await new Promise<void>(resolve => server.close(() => resolve())); throw error }
  let closing: Promise<void> | undefined
  return { close() {
    closing ??= (async () => {
      await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections() })
      try { const current = JSON.parse(await readFile(endpointPath, 'utf8')); if (current.token === token) await rm(endpointPath, { force: true }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })()
    return closing
  } }
}
