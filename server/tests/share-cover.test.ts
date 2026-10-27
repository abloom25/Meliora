import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeShareCoverUrl, shareCoverFallbackUrl } from '../../shared/share-cover'

const artwork = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000004e59jN2wjYN1.jpg'
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70])
const image = (): Response => new Response(jpeg, { headers: { 'Content-Type': 'image/jpeg' } })
const request = (url = artwork, options?: RequestInit): Request =>
  new Request(`https://meliora.test/api/cover?url=${encodeURIComponent(url)}`, options)
let getCover: typeof import('../core/cover-handler').getShareCover
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

beforeEach(async () => {
  vi.resetModules()
  getCover = (await import('../core/cover-handler')).getShareCover
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => image())
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('share artwork URL policy', () => {
  it('accepts only supported public static artwork and builds same-origin fallbacks', () => {
    expect(normalizeShareCoverUrl(artwork + '#fragment')).toBe(artwork)
    expect(
      normalizeShareCoverUrl('https://p2.music.126.net/abc_-=/12345.jpg?param=300y300'),
    ).not.toBeNull()
    expect(shareCoverFallbackUrl(artwork)).toBe(`/api/cover?url=${encodeURIComponent(artwork)}`)
    expect(shareCoverFallbackUrl(artwork, true)).toContain('/__meliora-dev/cover?')
  })
  it.each([
    'http://y.gtimg.cn/music/photo_new/a.jpg',
    'https://y.gtimg.cn.attacker.test/music/photo_new/a.jpg',
    'https://y.gtimg.cn@127.0.0.1/music/photo_new/a.jpg',
    'https://user:pass@y.gtimg.cn/music/photo_new/a.jpg',
    'https://y.gtimg.cn:123/music/photo_new/a.jpg',
    'https://y.gtimg.cn/music/photo_new/../../api',
    'https://y.gtimg.cn/music/photo_new/a.svg',
    'https://y.gtimg.cn/music/photo_new/%2f%2flocalhost.jpg',
    'https://127.0.0.1/cover.jpg',
    '/cover.jpg',
    'data:image/png;base64,abc',
    'https://p2.music.126.net/abc_/12345.svg',
  ])('rejects unsupported target %s before fetching', async (url) => {
    expect(shareCoverFallbackUrl(url)).toBeNull()
    expect((await getCover(request(url))).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('bounded artwork relay', () => {
  it('returns verified image bytes, strips caller credentials, and reuses completed cached data', async () => {
    // TTL assertions need a fixed clock: even 1 ms of scheduling floors the age to 86399.
    vi.useFakeTimers({ toFake: ['Date'] })
    const result = await getCover(
      request(artwork, { headers: { Cookie: 'secret', Authorization: 'secret' } }),
    )
    expect(result.status).toBe(200)
    expect(result.headers.get('Content-Type')).toBe('image/jpeg')
    expect(result.headers.get('Cache-Control')).toContain('public, max-age=86400')
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(jpeg)
    const options = fetchMock.mock.calls[0]![1]!
    expect(options.redirect).toBe('manual')
    expect(options.headers).toEqual({ Accept: 'image/jpeg, image/png, image/webp' })
    const cached = await getCover(request())
    expect(cached.headers.get('X-Cover-Cache')).toBe('HIT')
    expect(new Uint8Array(await cached.arrayBuffer())).toEqual(jpeg)
    expect(fetchMock).toHaveBeenCalledOnce()
  })
  it('rejects non-GET requests and ambiguous parameters', async () => {
    expect((await getCover(request(artwork, { method: 'POST' }))).status).toBe(405)
    for (const suffix of ['&url=' + encodeURIComponent(artwork), '&other=1']) {
      expect((await getCover(new Request(request().url + suffix))).status).toBe(400)
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each(['https://127.0.0.1/internal', 'https://example.com/a.jpg'])(
    'does not follow a redirect to %s',
    async (url) => {
      fetchMock.mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { Location: url } }),
      )
      expect((await getCover(request())).status).toBe(502)
      expect(fetchMock).toHaveBeenCalledOnce()
    },
  )
  it('follows permitted relative redirects and bounds redirect loops', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: './next.jpg' } }),
    )
    expect((await getCover(request())).status).toBe(200)
    expect(fetchMock.mock.calls[1]![0]).toBe('https://y.gtimg.cn/music/photo_new/next.jpg')
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 302, headers: { Location: './loop.jpg' } }),
    )
    expect((await getCover(request(artwork + '?loop'))).status).toBe(502)
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })
  it.each([
    { type: 'text/html', body: jpeg },
    { type: 'image/svg+xml', body: jpeg },
    { type: 'image/jpeg', body: new TextEncoder().encode('<html>bad</html>') },
    { type: 'image/png', body: jpeg },
  ])('rejects non-image or mismatched content $type without caching it', async ({ type, body }) => {
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { 'Content-Type': type } }))
    expect((await getCover(request())).status).toBe(502)
    expect((await getCover(request())).status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it.each([true, false])('caps image bytes with declared length: %s', async (declared) => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1))
      },
      cancel,
    })
    fetchMock.mockResolvedValueOnce(
      new Response(stream, {
        headers: {
          'Content-Type': 'image/jpeg',
          ...(declared ? { 'Content-Length': '1048577' } : {}),
        },
      }),
    )
    expect((await getCover(request())).status).toBe(502)
    expect(cancel).toHaveBeenCalledOnce()
  })
  it.each(['abort', 'timeout'])('cancels a stalled response body on %s', async (cause) => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    fetchMock.mockResolvedValueOnce(
      new Response(new ReadableStream({ cancel }), { headers: { 'Content-Type': 'image/jpeg' } }),
    )
    const controller = new AbortController()
    const pending = getCover(request(artwork, { signal: controller.signal }))
    await Promise.resolve()
    if (cause === 'abort') controller.abort()
    else await vi.advanceTimersByTimeAsync(8000)
    expect((await pending).status).toBe(502)
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]![1]!.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('expires completed entries and evicts the oldest artwork at its entry limit', async () => {
    vi.useFakeTimers()
    for (let index = 0; index < 17; index++) await getCover(request(artwork + `?v=${index}`))
    expect((await getCover(request(artwork + '?v=0'))).headers.get('X-Cover-Cache')).toBe('MISS')
    expect((await getCover(request(artwork + '?v=0'))).headers.get('X-Cover-Cache')).toBe('HIT')
    await vi.advanceTimersByTimeAsync(86_400_001)
    expect((await getCover(request(artwork + '?v=0'))).headers.get('X-Cover-Cache')).toBe('MISS')
  })
  it('limits expensive concurrent requests without sharing their in-flight work', async () => {
    const controllers = Array.from({ length: 4 }, () => new AbortController())
    fetchMock.mockImplementation(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(new Error('Aborted')), {
            once: true,
          })
        }),
    )
    const pending = controllers.map((controller) =>
      getCover(request(artwork, { signal: controller.signal })),
    )
    expect((await getCover(request())).status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    controllers.forEach((controller) => controller.abort())
    expect((await Promise.all(pending)).every((response) => response.status === 502)).toBe(true)
    fetchMock.mockImplementation(async () => image())
    expect((await getCover(request())).status).toBe(200)
  })
  it('rate limits cache misses and leaves cached artwork available', async () => {
    await getCover(request())
    for (let index = 0; index < 29; index++) await getCover(request(artwork + `?v=${index}`))
    expect((await getCover(request(artwork + '?more'))).status).toBe(429)
    expect((await getCover(request(artwork + '?v=28'))).status).toBe(200)
  })
})
