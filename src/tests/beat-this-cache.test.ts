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
    expect(await h.store.savedBytes()).toBe(0)
    expect(h.fetcher).not.toHaveBeenCalled()
    const progress = vi.fn()
    await h.store.download(new AbortController().signal, progress)
    expect(await h.store.has()).toBe(true)
    expect(await h.store.savedBytes()).toBe(5)
    expect(new Uint8Array((await h.store.read())!)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    expect(progress).toHaveBeenLastCalledWith(5, 5)
    expect(h.fetcher).toHaveBeenCalledTimes(2)
    await h.store.clear()
    expect(await h.store.has()).toBe(false)
  })
  it('rejects damaged parts while retaining verified parts for an explicit retry', async () => {
    for (const bytes of [new Uint8Array([4]), new Uint8Array([9, 9]), new Uint8Array([4, 5, 6])]) {
      const h = harness()
      h.fetcher.mockImplementation(
        async (url) => new Response(String(url).includes('part-0') ? chunks[0] : bytes),
      )
      await expect(h.store.download(new AbortController().signal, () => {})).rejects.toThrow(/文件/)
      expect(await h.store.has()).toBe(false)
      expect(h.entries.size).toBe(1)
      expect(await h.store.savedBytes()).toBe(3)
      h.fetcher.mockClear()
      h.fetcher.mockImplementation(async () => new Response(chunks[1]))
      const progress = vi.fn()
      await h.store.download(new AbortController().signal, progress)
      expect(h.fetcher).toHaveBeenCalledOnce()
      expect(String(h.fetcher.mock.calls[0]![0])).toContain('part-1')
      expect(progress.mock.calls[0]).toEqual([3, 3])
      expect(await h.store.has()).toBe(true)
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
    expect(h.entries.size).toBe(1)
  })
  it('repairs only the corrupt cached part and counts later valid parts before fetching', async () => {
    const h = harness()
    await h.store.download(new AbortController().signal, () => {})
    h.entries.set(
      new URL(bundle.parts[0]!.url, window.location.href).href,
      new Response(new Uint8Array([9, 9, 9])),
    )
    h.fetcher.mockClear()
    const progress = vi.fn()
    await h.store.download(new AbortController().signal, progress)
    expect(progress.mock.calls[0]).toEqual([2, 2])
    expect(h.fetcher).toHaveBeenCalledOnce()
    expect(String(h.fetcher.mock.calls[0]![0])).toContain('part-0')
    expect(new Uint8Array((await h.store.read())!)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })
  it('removes a marker published during cancellation but keeps all verified parts', async () => {
    const h = harness()
    const controller = new AbortController()
    h.cache.put.mockImplementation(async (url, response) => {
      h.entries.set(url, response.clone())
      if (url.includes('complete-')) controller.abort()
    })
    await expect(h.store.download(controller.signal, () => {})).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(await h.store.has()).toBe(false)
    expect(h.entries.size).toBe(2)
    h.fetcher.mockClear()
    h.cache.put.mockImplementation(async (url, response) => {
      h.entries.set(url, response.clone())
    })
    await h.store.download(new AbortController().signal, () => {})
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(await h.store.has()).toBe(true)
  })
  it('rolls back transient stream progress and clears saved parts only on explicit removal', async () => {
    const h = harness()
    const controller = new AbortController()
    h.fetcher.mockImplementation(async (url) =>
      String(url).includes('part-0')
        ? new Response(chunks[0])
        : new Response(
            new ReadableStream({
              start(stream) {
                stream.enqueue(new Uint8Array([4]))
              },
              pull() {
                controller.abort()
              },
            }),
          ),
    )
    const progress = vi.fn()
    await expect(h.store.download(controller.signal, progress)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(progress).toHaveBeenLastCalledWith(3, 3)
    expect(h.entries.size).toBe(1)
    expect(h.storage.delete).not.toHaveBeenCalled()
    await h.store.clear()
    expect(h.entries.size).toBe(0)
    expect(h.storage.delete).toHaveBeenCalledOnce()
  })
  it('serializes explicit deletion after a pending part commit without resurrecting data', async () => {
    const h = harness()
    let finish!: () => void
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    const controller = new AbortController()
    h.cache.put.mockImplementationOnce(async (url, response) => {
      await gate
      h.entries.set(url, response.clone())
    })
    const downloading = h.store.download(controller.signal, () => {})
    const rejected = expect(downloading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(h.cache.put).toHaveBeenCalledOnce())
    controller.abort()
    const removing = h.store.clear()
    finish()
    await rejected
    await removing
    expect(h.entries.size).toBe(0)
    expect(await h.store.has()).toBe(false)
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
  it('can cancel while a response body stalls without discarding earlier parts', async () => {
    const h = harness()
    const controller = new AbortController()
    const cancel = vi.fn()
    h.fetcher.mockImplementation(async (url) =>
      String(url).includes('part-0')
        ? new Response(chunks[0])
        : new Response(new ReadableStream({ cancel })),
    )
    const pending = h.store.download(controller.signal, () => {})
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(h.fetcher).toHaveBeenCalledTimes(2))
    controller.abort()
    await rejection
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.entries.size).toBe(1)
    expect(await h.store.has()).toBe(false)
  })
  it('does not mark complete when the final marker fails and resumes without another download', async () => {
    const h = harness()
    h.cache.put.mockImplementation(async (url, response) => {
      if (url.includes('complete-')) throw new DOMException('Full', 'QuotaExceededError')
      h.entries.set(url, response.clone())
    })
    await expect(h.store.download(new AbortController().signal, () => {})).rejects.toThrow(
      '存储空间不足',
    )
    expect(await h.store.has()).toBe(false)
    expect(await h.store.savedBytes()).toBe(5)
    h.cache.put.mockImplementation(async (url, response) => {
      h.entries.set(url, response.clone())
    })
    h.fetcher.mockClear()
    await h.store.download(new AbortController().signal, () => {})
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(await h.store.has()).toBe(true)
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
