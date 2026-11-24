/**
 * 下载 GitHub Release 资产（如插件的 `.tgz` 安装包）到内存。
 * Node 内置 fetch 会自动跟随 objects.githubusercontent.com 的重定向，
 * 与 skill-install 的 codeload 下载一样流式限速，避免超大资产被打进内存。
 */

function assertHttpsReleaseUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Release 下载地址无效。')
  }
  if (parsed.protocol !== 'https:') throw new Error('Release 下载地址必须是 https 链接。')
}

export async function downloadReleaseAsset(
  url: string,
  maxBytes: number,
  onProgress?: (received: number, total: number | null) => void,
  fetchImpl?: typeof fetch,
  /** 外部中断（断流看门狗/总超时）：abort 后调用方换下一个源。 */
  signal?: AbortSignal,
  idleTimeoutMs?: number,
): Promise<Buffer> {
  assertHttpsReleaseUrl(url)
  const idleController = idleTimeoutMs === undefined ? undefined : new AbortController()
  const downloadSignal = idleController && signal
    ? AbortSignal.any([idleController.signal, signal])
    : idleController?.signal ?? signal
  if (idleController) downloadSignal?.throwIfAborted()
  let timer: ReturnType<typeof setTimeout> | undefined
  const resetIdleTimeout = (): void => {
    if (!idleController) return
    clearTimeout(timer)
    timer = setTimeout(() => idleController.abort(new Error('下载超时，长时间未收到安装包数据。')), idleTimeoutMs)
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let onAbort: (() => void) | undefined
  const aborted = idleController && downloadSignal && new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(downloadSignal.reason)
    downloadSignal.addEventListener('abort', onAbort, { once: true })
  })
  const receive = async (): Promise<Buffer> => {
    const response = await (fetchImpl ?? fetch)(url, {
      headers: { 'User-Agent': 'DSH-Launcher' },
      redirect: 'follow',
      signal: downloadSignal,
    })
    if (idleController && downloadSignal?.aborted) {
      void response.body?.cancel().catch(() => undefined)
      downloadSignal.throwIfAborted()
    }
    // Only the launcher opts into cancelling bodies rejected before reading.
    if (idleController && response.body) reader = response.body.getReader()
    if (!response.ok || !response.body) {
      throw new Error(`下载 Release 资产失败（HTTP ${response.status}）。`)
    }
    const declaredSize = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
      throw new Error('Release 安装包过大，已停止下载。')
    }
    reader ??= response.body.getReader()
    resetIdleTimeout()
    const total = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : null
    const chunks: Uint8Array[] = []
    let received = 0
    while (true) {
      const chunk = await reader.read()
      if (idleController) downloadSignal?.throwIfAborted()
      if (chunk.done) break
      if (idleController && chunk.value.byteLength === 0) continue
      received += chunk.value.byteLength
      if (received > maxBytes) throw new Error('Release 安装包过大，已停止下载。')
      resetIdleTimeout()
      chunks.push(chunk.value)
      onProgress?.(received, total)
    }
    return Buffer.concat(chunks, received)
  }
  resetIdleTimeout()
  try {
    return await (aborted ? Promise.race([receive(), aborted]) : receive())
  } catch (error) {
    const cancelled = reader?.cancel().catch(() => undefined)
    if (!idleController) await cancelled
    throw error
  } finally {
    clearTimeout(timer)
    if (onAbort) downloadSignal?.removeEventListener('abort', onAbort)
    reader?.releaseLock()
  }
}
