import type { BeatThisAssetPart } from '../../core/analysis/beat-this-models'

export interface BeatThisAssetBundle {
  version: string
  parts: readonly BeatThisAssetPart[]
}

/** User-owned downloads. Checking or reading the cache never makes a network request. */
export function createBeatThisAssetStore(
  bundle: BeatThisAssetBundle,
  options: { fetcher?: typeof fetch; cacheStorage?: CacheStorage; subtle?: SubtleCrypto } = {},
) {
  const cacheName = `meliora-beat-this-${bundle.version}`
  const marker = new URL(`/models/beat-this/complete-${bundle.version}`, window.location.href).href
  let writes: Promise<unknown> = Promise.resolve()
  function storage(): CacheStorage {
    const cache = options.cacheStorage ?? globalThis.caches
    if (!cache) throw new Error('此浏览器无法保存模型，请使用 HTTPS 或本机地址访问')
    return cache
  }
  const url = (part: BeatThisAssetPart): string => new URL(part.url, window.location.href).href
  function write<T>(task: () => Promise<T>): Promise<T> {
    const result = writes.then(task, task)
    writes = result.catch(() => {})
    return result
  }
  function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  async function validate(data: ArrayBuffer, part: BeatThisAssetPart): Promise<void> {
    if (data.byteLength !== part.bytes) throw new Error('模型文件不完整，请重新下载')
    const subtle = options.subtle ?? globalThis.crypto?.subtle
    if (!subtle) throw new Error('此浏览器无法校验模型，请使用 HTTPS 或本机地址访问')
    const digest = new Uint8Array(await subtle.digest('SHA-256', data))
    if (Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('') !== part.sha256)
      throw new Error('模型文件校验失败，请重试下载修复')
  }
  async function has(): Promise<boolean> {
    try {
      const cache = await storage().open(cacheName)
      if (!(await cache.match(marker))) return false
      for (const part of bundle.parts) if (!(await cache.match(url(part)))) return false
      return true
    } catch {
      return false
    }
  }
  /** Cheap UI inventory. Every reused body is still hash-checked by download/read. */
  async function savedBytes(): Promise<number> {
    try {
      const cache = await storage().open(cacheName)
      let bytes = 0
      for (const part of bundle.parts) {
        const response = await cache.match(url(part))
        if (
          response?.headers.get('X-Meliora-SHA256') === part.sha256 &&
          response.headers.get('Content-Length') === String(part.bytes)
        )
          bytes += part.bytes
      }
      return bytes
    } catch {
      return 0
    }
  }
  async function read(signal?: AbortSignal): Promise<ArrayBuffer | null> {
    signal?.throwIfAborted()
    const cache = await storage().open(cacheName)
    if (!(await cache.match(marker))) return null
    const result = new Uint8Array(bundle.parts.reduce((total, part) => total + part.bytes, 0))
    let offset = 0
    for (const part of bundle.parts) {
      signal?.throwIfAborted()
      const response = await cache.match(url(part))
      if (!response) return null
      const bytes = await response.arrayBuffer()
      await validate(bytes, part)
      signal?.throwIfAborted()
      result.set(new Uint8Array(bytes), offset)
      offset += bytes.byteLength
    }
    return result.buffer
  }
  async function download(
    signal: AbortSignal,
    onProgress: (bytes: number, savedBytes: number) => void,
  ): Promise<void> {
    return write(async () => {
      signal.throwIfAborted()
      const cache = await storage().open(cacheName)
      // A marker is written only after all parts have passed their pinned hashes.
      await cache.delete(marker)
      let receivedTotal = 0
      try {
        const saved = new Set<BeatThisAssetPart>()
        // Recheck pinned hashes on every explicit retry. Never trust stale cache metadata.
        for (const part of bundle.parts) {
          signal.throwIfAborted()
          const response = await cache.match(url(part))
          if (!response) continue
          try {
            await validate(await response.arrayBuffer(), part)
            saved.add(part)
            receivedTotal += part.bytes
          } catch {
            signal.throwIfAborted()
            await cache.delete(url(part))
          }
        }
        onProgress(receivedTotal, receivedTotal)
        for (const part of bundle.parts) {
          signal.throwIfAborted()
          if (saved.has(part)) continue
          const controller = new AbortController()
          const abort = (): void => controller.abort(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          const timer = window.setTimeout(() => controller.abort(), 120_000)
          try {
            const response = await abortable(
              (options.fetcher ?? globalThis.fetch)(url(part), {
                signal: controller.signal,
                cache: 'no-store',
                credentials: 'same-origin',
              }),
              controller.signal,
            )
            if (!response.ok || response.status === 206) throw new Error('模型下载失败，请重试')
            const buffer = new Uint8Array(part.bytes)
            let received = 0
            if (response.body) {
              const reader = response.body.getReader()
              try {
                for (;;) {
                  controller.signal.throwIfAborted()
                  const { done, value } = await abortable(reader.read(), controller.signal)
                  if (done) break
                  if (received + value.byteLength > part.bytes)
                    throw new Error('模型文件大小不正确，请重试')
                  buffer.set(value, received)
                  received += value.byteLength
                  onProgress(receivedTotal + received, receivedTotal)
                }
              } finally {
                void reader.cancel().catch(() => {})
                reader.releaseLock()
              }
            } else {
              const bytes = await abortable(response.arrayBuffer(), controller.signal)
              if (bytes.byteLength !== part.bytes) throw new Error('模型文件不完整，请重试')
              buffer.set(new Uint8Array(bytes))
              received = bytes.byteLength
            }
            controller.signal.throwIfAborted()
            if (received !== part.bytes) throw new Error('模型文件不完整，请重试')
            await validate(buffer.buffer, part)
            controller.signal.throwIfAborted()
            await cache.put(
              url(part),
              new Response(buffer, {
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'Content-Length': String(part.bytes),
                  'X-Meliora-SHA256': part.sha256,
                },
              }),
            )
            receivedTotal += received
            onProgress(receivedTotal, receivedTotal)
            controller.signal.throwIfAborted()
          } catch (error) {
            if (controller.signal.aborted && !signal.aborted)
              throw new Error('模型下载超时，请检查网络后重试', { cause: error })
            throw error
          } finally {
            window.clearTimeout(timer)
            signal.removeEventListener('abort', abort)
          }
        }
        signal.throwIfAborted()
        await cache.put(marker, new Response(bundle.version))
        signal.throwIfAborted()
      } catch (error) {
        // Cache.put is atomic per entry. Completed verified parts survive cancellation;
        // only the commit marker is removed, including aborts during marker publication.
        await cache.delete(marker).catch(() => {})
        onProgress(receivedTotal, receivedTotal)
        if (error instanceof DOMException && error.name === 'QuotaExceededError')
          throw new Error('浏览器存储空间不足，请清理空间后重试', { cause: error })
        throw error
      }
    })
  }
  async function clear(): Promise<void> {
    await write(() => storage().delete(cacheName))
  }
  return { has, savedBytes, read, download, clear }
}
