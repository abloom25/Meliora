import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeLyricsResult } from '../../shared/native-lyrics'

const sources = vi.hoisted(() => ({ netease: vi.fn(), qq: vi.fn() }))
vi.mock('../core/lyrics/netease', () => ({ fetchNeteaseLyrics: sources.netease }))
vi.mock('../core/lyrics/qq', () => ({ fetchQqLyrics: sources.qq }))

const FOUND: NativeLyricsResult = {
  status: 'found',
  data: { source: 'netease', format: 'yrc', lyrics: '[1000,500](1000,500,0)词' },
}
const ENV = {
  GH_TOKEN: '',
  GH_REPO: '',
  GH_BRANCH: 'main',
  CONFIG_ENCRYPTION_KEY: '',
  DEVELOPMENT: 'true',
}
let getNativeLyrics: typeof import('../core/lyrics-handler').getNativeLyrics

function request(query = 'source=netease&id=1361348080', init?: RequestInit): Request {
  return new Request(`https://meliora.example/api/lyrics?${query}`, init)
}

describe('native lyrics gateway', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    sources.netease.mockResolvedValue(FOUND)
    sources.qq.mockResolvedValue({ status: 'missing' })
    ;({ getNativeLyrics } = await import('../core/lyrics-handler'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('serves completed results from a bounded cache without repeating upstream work', async () => {
    const first = await getNativeLyrics(request(), 'client')
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual(FOUND)
    expect(first.headers.get('X-Lyrics-Cache')).toBe('MISS')
    expect(first.headers.get('Cache-Control')).toContain('public, max-age=')
    const second = await getNativeLyrics(request(), 'another-client')
    expect(second.headers.get('X-Lyrics-Cache')).toBe('HIT')
    expect(sources.netease).toHaveBeenCalledTimes(1)
  })

  it('keeps sources separate and accepts QQ MID as well as numeric IDs', async () => {
    await getNativeLyrics(request('source=netease&id=123'))
    await getNativeLyrics(request('source=qq&id=123'))
    await getNativeLyrics(request('source=qq&id=0039MnYb0qxYhV'))
    expect(sources.netease).toHaveBeenCalledTimes(1)
    expect(sources.qq.mock.calls.map(([id]) => id)).toEqual(['123', '0039MnYb0qxYhV'])
  })

  it.each([
    '',
    'source=netease',
    'source=qq&id=',
    'source=other&id=123',
    'source=netease&id=0039MnYb0qxYhV',
    'source=netease&id=9007199254740992',
    'source=netease&id=0',
    'source=qq&id=https://example.org',
    'source=qq&id=abcdefghij',
    'source=qq&id=abcdefghijklmno',
    'source=qq&id=123&url=https://example.org',
    'source=qq&id=123&id=456',
    'source=qq&source=netease&id=123',
  ])('rejects unsupported identities without network access: %s', async (query) => {
    expect((await getNativeLyrics(request(query))).status).toBe(400)
    expect(sources.netease).not.toHaveBeenCalled()
    expect(sources.qq).not.toHaveBeenCalled()
  })

  it('only accepts read-only GET requests', async () => {
    const response = await getNativeLyrics(request(undefined, { method: 'POST' }))
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET')
    expect(sources.netease).not.toHaveBeenCalled()
  })

  it('expires positive and negative results independently', async () => {
    vi.useFakeTimers()
    await getNativeLyrics(request('source=netease&id=1'))
    expect((await getNativeLyrics(request('source=qq&id=1'))).status).toBe(404)
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1)
    await getNativeLyrics(request('source=netease&id=1'))
    await getNativeLyrics(request('source=qq&id=1'))
    expect(sources.netease).toHaveBeenCalledTimes(1)
    expect(sources.qq).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)
    await getNativeLyrics(request('source=netease&id=1'))
    expect(sources.netease).toHaveBeenCalledTimes(2)
  })

  it('does not cache upstream failures as absent lyrics', async () => {
    sources.netease.mockResolvedValueOnce({ status: 'unavailable' })
    const failed = await getNativeLyrics(request())
    expect(failed.status).toBe(502)
    expect(failed.headers.get('Cache-Control')).toBe('no-store')
    expect((await getNativeLyrics(request())).status).toBe(200)
    expect(sources.netease).toHaveBeenCalledTimes(2)
  })

  it('ends a stalled lookup within the request budget and releases its slot', async () => {
    vi.useFakeTimers()
    sources.netease.mockImplementationOnce(() => new Promise(() => {}))
    const pending = getNativeLyrics(request())
    const signal = sources.netease.mock.calls[0]![1] as AbortSignal
    await vi.advanceTimersByTimeAsync(6000)
    expect((await pending).status).toBe(502)
    expect(signal.aborted).toBe(true)
    expect((await getNativeLyrics(request())).status).toBe(200)
  })

  it('bounds parallel upstream work without sharing live I/O across requests', async () => {
    const completions: Array<(result: NativeLyricsResult) => void> = []
    sources.netease.mockImplementation(
      () => new Promise<NativeLyricsResult>((resolve) => completions.push(resolve)),
    )
    const controller = new AbortController()
    const pending = Array.from({ length: 4 }, (_, index) =>
      getNativeLyrics(
        request(`source=netease&id=${index + 1}`, index === 0 ? { signal: controller.signal } : {}),
        'parallel-client',
      ),
    )
    const busy = await getNativeLyrics(request('source=netease&id=5'), 'parallel-client')
    expect(busy.status).toBe(503)
    expect(busy.headers.get('Retry-After')).toBe('2')
    controller.abort()
    expect((await pending[0]!).status).toBe(502)
    expect((sources.netease.mock.calls[1]![1] as AbortSignal).aborted).toBe(false)
    completions.forEach((resolve) => resolve({ status: 'missing' }))
    await Promise.all(pending)
    sources.netease.mockResolvedValue(FOUND)
    expect((await getNativeLyrics(request('source=netease&id=5'))).status).toBe(200)
  })

  it('evicts old entries after the capacity is reached', async () => {
    for (let id = 1; id <= 65; id += 1) {
      await getNativeLyrics(request(`source=netease&id=${id}`), `client-${id}`)
    }
    await getNativeLyrics(request('source=netease&id=65'))
    expect(sources.netease).toHaveBeenCalledTimes(65)
    await getNativeLyrics(request('source=netease&id=1'))
    expect(sources.netease).toHaveBeenCalledTimes(66)
  })

  it('rate limits repeated uncached lookups with a retry hint', async () => {
    sources.netease.mockResolvedValue({ status: 'unavailable' })
    for (let index = 0; index < 60; index += 1) {
      await getNativeLyrics(request(), 'limited-client')
    }
    const limited = await getNativeLyrics(request(), 'limited-client')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect(sources.netease).toHaveBeenCalledTimes(60)
  })

  it('keeps the existing API shutdown and environment gates while allowing public lyrics', async () => {
    const { handleRequest } = await import('../core/router')
    expect((await handleRequest(request(), { ...ENV, ADMIN_DISABLED: 'true' })).status).toBe(403)
    expect((await handleRequest(request(), { ...ENV, DEVELOPMENT: undefined })).status).toBe(403)
    expect(sources.netease).not.toHaveBeenCalled()
    const publicResult = await handleRequest(request(), ENV)
    expect(publicResult.status).toBe(200)
    expect(publicResult.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(publicResult.headers.get('Cache-Control')).toContain('public')
    const adminResult = await handleRequest(new Request('https://meliora.example/api/config'), ENV)
    expect(adminResult.status).toBe(401)
    const removed = await handleRequest(
      new Request('https://meliora.example/api/runtime-config'),
      ENV,
    )
    expect(removed.status).toBe(404)
  })
})
