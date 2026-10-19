import { createHash, webcrypto } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createBeatThisAssetStore } from '../platform/web/beat-this-cache'

const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]
const bundle = {
  version: 'test',
  parts: chunks.map((bytes, i) => ({
    url: `/models/beat-this/part-${i}.bin`,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  })),
}
function harness() {
  const entries = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (url: string) => entries.get(url)?.clone()),
    put: vi.fn(async (url: string, response: Response) => {
      entries.set(url, response.clone())
    }),
    delete: vi.fn(async (url: string) => entries.delete(url)),
  }
  const storage = {
    open: vi.fn(async () => cache),
    delete: vi.fn(async () => {
      entries.clear()
      return true
    }),
  }
  const fetcher = vi.fn<typeof fetch>(
    async (url) => new Response(chunks[String(url).includes('part-0') ? 0 : 1]),
  )
  const store = createBeatThisAssetStore(bundle, {
    fetcher,
    cacheStorage: storage as unknown as CacheStorage,
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
  })
  return { entries, cache, storage, fetcher, store }
}
describe('Beat This static model bundle cache', () => {
  it('never fetches implicitly and assembles verified parts only after a complete download', async () => {
    const h = harness()
    expect(await h.store.has()).toBe(false)
    expect(await h.store.read()).toBeNull()
    expect(h.fetcher).not.toHaveBeenCalled()
    const progress = vi.fn()
    await h.store.download(new AbortController().signal, progress)
    expect(await h.store.has()).toBe(true)
    expect(new Uint8Array((await h.store.read())!)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(progress).toHaveBeenLastCalledWith(5)
    expect(h.fetcher).toHaveBeenCalledTimes(2)
    await h.store.clear()
    expect(await h.store.has()).toBe(false)
  })
  it('does not accept truncated, corrupt or oversized data and removes all partial parts', async () => {
    for (const bytes of [new Uint8Array([4]), new Uint8Array([9, 9]), new Uint8Array([4, 5, 6])]) {
      const h = harness()
      h.fetcher.mockImplementation(
        async (url) => new Response(String(url).includes('part-0') ? chunks[0] : bytes),
      )
      await expect(h.store.download(new AbortController().signal, () => {})).rejects.toThrow(/文件/)
      expect(await h.store.has()).toBe(false)
      expect(h.entries.size).toBe(0)
    }
  })
  it('does not resurrect a model when cancelled while Cache.put is pending', async () => {
    const h = harness()
    const controller = new AbortController()
    h.cache.put.mockImplementationOnce(async (url, response) => {
      h.entries.set(url, response)
      controller.abort()
    })
    await expect(h.store.download(controller.signal, () => {})).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(await h.store.has()).toBe(false)
    expect(h.entries.size).toBe(0)
  })
  it('rejects a tampered cache and never redownloads it during playback', async () => {
    const h = harness()
    await h.store.download(new AbortController().signal, () => {})
    h.entries.set(
      new URL(bundle.parts[1]!.url, window.location.href).href,
      new Response(new Uint8Array([9, 9])),
    )
    await expect(h.store.read()).rejects.toThrow(/校验失败/)
    expect(h.fetcher).toHaveBeenCalledTimes(2)
  })
  it('does not consider an evicted part a complete cache', async () => {
    const h = harness()
    await h.store.download(new AbortController().signal, () => {})
    h.entries.delete(new URL(bundle.parts[0]!.url, window.location.href).href)
    expect(await h.store.has()).toBe(false)
    expect(await h.store.read()).toBeNull()
    expect(h.fetcher).toHaveBeenCalledTimes(2)
  })
})
