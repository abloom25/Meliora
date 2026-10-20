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
  async function validate(data: ArrayBuffer, part: BeatThisAssetPart): Promise<void> {
    if (data.byteLength !== part.bytes) throw new Error('模型文件不完整，请重新下载')
    const subtle = options.subtle ?? globalThis.crypto?.subtle
    if (!subtle) throw new Error('此浏览器无法校验模型，请使用 HTTPS 或本机地址访问')
    const digest = new Uint8Array(await subtle.digest('SHA-256', data))
    if (Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('') !== part.sha256)
      throw new Error('模型文件校验失败，请删除后重新下载')
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
  async function download(signal: AbortSignal, onProgress: (bytes: number) => void): Promise<void> {
    return write(async () => {
      signal.throwIfAborted()
      const cache = await storage().open(cacheName)
      // A marker is written only after all parts have passed their pinned hashes.
      await cache.delete(marker)
      let receivedTotal = 0
      try {
        for (const part of bundle.parts) {
          signal.throwIfAborted()
          const controller = new AbortController()
          const abort = (): void => controller.abort(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          const timer = window.setTimeout(() => controller.abort(), 120_000)
          try {
            const response = await (options.fetcher ?? globalThis.fetch)(url(part), {
              signal: controller.signal,
              cache: 'no-store',
              credentials: 'same-origin',
            })
            if (!response.ok || response.status === 206) throw new Error('模型下载失败，请重试')
            const buffer = new Uint8Array(part.bytes)
            let received = 0
            if (response.body) {
              const reader = response.body.getReader()
              try {
                for (;;) {
                  controller.signal.throwIfAborted()
                  const { done, value } = await reader.read()
                  if (done) break
                  if (received + value.byteLength > part.bytes)
                    throw new Error('模型文件大小不正确，请重试')
                  buffer.set(value, received)
                  received += value.byteLength
                  onProgress(receivedTotal + received)
                }
              } finally {
                await reader.cancel().catch(() => {})
                reader.releaseLock()
              }
            } else {
              const bytes = await response.arrayBuffer()
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
              new Response(buffer, { headers: { 'Content-Type': 'application/octet-stream' } }),
            )
            controller.signal.throwIfAborted()
            receivedTotal += received
            onProgress(receivedTotal)
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
        await storage()
          .delete(cacheName)
          .catch(() => {})
        if (error instanceof DOMException && error.name === 'QuotaExceededError')
          throw new Error('浏览器存储空间不足，请清理空间后重试', { cause: error })
        throw error
      }
    })
  }
  async function clear(): Promise<void> {
    await write(() => storage().delete(cacheName))
  }
  return { has, read, download, clear }
}
