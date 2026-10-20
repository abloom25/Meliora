import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  getNativeLyricsCacheToken,
  hasCachedNativeLyrics,
  loadNativeLyrics,
  nativeLyricsCacheKey,
  resetNativeLyricsCache,
  setNativeLyricsCacheStore,
  toNativeLyricsQuery,
} from '../services/native-lyrics'
import type { NativeLyricsData } from '../../shared/native-lyrics'
import type { LyricsCacheRecord } from '../core/platform/lyrics-cache'
import {
  NATIVE_LYRICS_NEGATIVE_TTL_MS,
  NATIVE_LYRICS_POSITIVE_TTL_MS,
  NATIVE_LYRICS_TIMEOUT_MS,
} from '../config/lyrics'

const YRC = '[1000,900](1000,400,0)你(1400,500,0)好'
const QRC = '[1000,900]你(1000,400)好(1400,500)'
const query = { source: 'netease' as const, id: '123' }

function data(): NativeLyricsData {
  return {
    source: 'netease',
    format: 'yrc',
    lyrics: YRC,
    translation: '[00:01.00]Hello',
    romanization: '[00:01.00]ni hao',
  }
}

function found(payload: NativeLyricsData = data()): Response {
  return Response.json({ status: 'found', data: payload })
}

function missing(): Response {
  return Response.json({ status: 'missing' }, { status: 404 })
}

describe('native platform lyrics', () => {
  let records: Map<string, LyricsCacheRecord>

  beforeEach(() => {
    resetNativeLyricsCache()
    records = new Map()
    setNativeLyricsCacheStore({
      get: async (key) => records.get(key) ?? null,
      set: async (record) => {
        records.set(record.key, record)
      },
    })
  })

  afterEach(() => {
    resetNativeLyricsCache()
    setNativeLyricsCacheStore(null)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('loads a same-origin YRC response and retains translation and romanization', async () => {
    const fetchMock = vi.fn(async () => found())
    vi.stubGlobal('fetch', fetchMock)
    const lines = await loadNativeLyrics(query)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/lyrics?source=netease&id=123',
      expect.objectContaining({ cache: 'no-cache' }),
    )
    expect(lines?.[0]).toMatchObject({
      text: '你好',
      wordSource: 'native',
      translation: 'Hello',
      roman: 'ni hao',
    })
    expect(lines?.[0]?.words).toHaveLength(2)
  })

  it('maps QQ songmid to the qq source and parses QRC', async () => {
    const qq = toNativeLyricsQuery({ platform: 'tencent', id: '004songmid' })!
    const fetchMock = vi.fn(async () => found({ source: 'qq', format: 'qrc', lyrics: QRC }))
    vi.stubGlobal('fetch', fetchMock)
    expect((await loadNativeLyrics(qq))?.[0]?.words).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/lyrics?source=qq&id=004songmid',
      expect.any(Object),
    )
    expect(toNativeLyricsQuery({ platform: 'netease' })).toBeNull()
    expect(toNativeLyricsQuery({ id: '123' })).toBeNull()
  })

  it('keeps platform and AMLL cache namespaces separate', () => {
    expect(nativeLyricsCacheKey(query)).toBe('native-lyrics:v1:netease:123')
    expect(nativeLyricsCacheKey(query)).not.toBe(nativeLyricsCacheKey({ ...query, source: 'qq' }))
  })

  it('shares concurrent work and uses a stable cache token until refresh', async () => {
    const fetchMock = vi.fn(async () => found())
    vi.stubGlobal('fetch', fetchMock)
    const [first, second] = await Promise.all([loadNativeLyrics(query), loadNativeLyrics(query)])
    expect(first).toBe(second)
    expect(await loadNativeLyrics(query)).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const token = getNativeLyricsCacheToken(query)
    expect(token).not.toBeNull()
    expect(getNativeLyricsCacheToken({ ...query })).toBe(token)
  })

  it('persists full native data and restores auxiliary text without a network request', async () => {
    const fetchMock = vi.fn(async () => found())
    vi.stubGlobal('fetch', fetchMock)
    await loadNativeLyrics(query)
    await flushPromises()
    const raw = records.get(nativeLyricsCacheKey(query))?.text
    expect(JSON.parse(raw!)).toEqual(data())
    resetNativeLyricsCache()
    expect((await loadNativeLyrics(query))?.[0]).toMatchObject({
      translation: 'Hello',
      roman: 'ni hao',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['positive', NATIVE_LYRICS_POSITIVE_TTL_MS, () => found()],
    ['negative', NATIVE_LYRICS_NEGATIVE_TTL_MS, missing],
  ])('expires %s caches and requests fresh platform data', async (_label, ttl, reply) => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async () => reply())
    vi.stubGlobal('fetch', fetchMock)
    await loadNativeLyrics(query)
    const token = getNativeLyricsCacheToken(query)
    expect(hasCachedNativeLyrics(query)).toBe(true)
    vi.setSystemTime(Date.now() + ttl + 1)
    expect(getNativeLyricsCacheToken(query)).toBeNull()
    await loadNativeLyrics(query)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getNativeLyricsCacheToken(query)).not.toBe(token)
  })

  it.each([403, 405, 502, 503])(
    'does not cache unavailable HTTP %i as a missing lyric',
    async (status) => {
      const fetchMock = vi.fn(async () => Response.json({ status: 'unavailable' }, { status }))
      vi.stubGlobal('fetch', fetchMock)
      expect(await loadNativeLyrics(query)).toBeNull()
      expect(hasCachedNativeLyrics(query)).toBe(false)
      fetchMock.mockImplementation(async () => found())
      expect((await loadNativeLyrics(query))?.[0]?.wordSource).toBe('native')
    },
  )

  it.each([
    ['static host HTML', () => new Response('<html>SPA fallback</html>')],
    ['wrong source', () => found({ source: 'qq', format: 'qrc', lyrics: QRC })],
    ['wrong format', () => found({ ...data(), format: 'qrc' })],
    ['plain lyrics instead of timings', () => found({ ...data(), lyrics: '[00:01]Plain line' })],
    ['an unstructured missing response', () => new Response('', { status: 404 })],
  ])('ignores %s without poisoning the negative cache', async (_label, reply) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply()),
    )
    expect(await loadNativeLyrics(query)).toBeNull()
    expect(hasCachedNativeLyrics(query)).toBe(false)
  })

  it('continues if persistent storage fails or contains damaged JSON', async () => {
    records.set(nativeLyricsCacheKey(query), {
      cacheVersion: 1,
      key: nativeLyricsCacheKey(query),
      text: '{broken',
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => found()),
    )
    expect((await loadNativeLyrics(query))?.[0]?.wordSource).toBe('native')
    resetNativeLyricsCache()
    setNativeLyricsCacheStore({
      get: async () => {
        throw new Error('denied')
      },
      set: async () => {
        throw new Error('full')
      },
    })
    expect((await loadNativeLyrics(query))?.[0]?.wordSource).toBe('native')
  })

  it('bounds an unresponsive persistence layer before starting its request', async () => {
    vi.useFakeTimers()
    setNativeLyricsCacheStore({ get: () => new Promise(() => {}), set: async () => {} })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => found()),
    )
    const pending = loadNativeLyrics(query)
    await vi.advanceTimersByTimeAsync(501)
    expect((await pending)?.[0]?.wordSource).toBe('native')
  })

  it('does not cancel a shared platform request when only one subscriber leaves', async () => {
    let resolveFetch!: (value: Response) => void
    let networkSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        networkSignal = init?.signal ?? undefined
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
      }),
    )
    const controller = new AbortController()
    const first = loadNativeLyrics(query, controller.signal)
    const second = loadNativeLyrics(query)
    await flushPromises()
    controller.abort()
    expect(await first).toBeNull()
    expect(networkSignal?.aborted).toBe(false)
    resolveFetch(found())
    expect((await second)?.[0]?.wordSource).toBe('native')
  })

  it('stops the network after its final subscriber leaves and allows a fresh retry', async () => {
    let networkSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      networkSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = loadNativeLyrics(query, controller.signal)
    await flushPromises()
    controller.abort()
    expect(await pending).toBeNull()
    expect(networkSignal?.aborted).toBe(true)
    expect(hasCachedNativeLyrics(query)).toBe(false)
    fetchMock.mockImplementation(async () => found())
    expect((await loadNativeLyrics(query))?.[0]?.wordSource).toBe('native')
  })

  it.each(['headers', 'body'])(
    'bounds an unresponsive response %s to the query budget',
    async (stage) => {
      vi.useFakeTimers()
      const stalled = new Promise<Response>(() => {})
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          stage === 'headers' ? stalled : Promise.resolve(new Response(new ReadableStream())),
        ),
      )
      const pending = loadNativeLyrics(query)
      await vi.advanceTimersByTimeAsync(NATIVE_LYRICS_TIMEOUT_MS + 1)
      expect(await pending).toBeNull()
      expect(hasCachedNativeLyrics(query)).toBe(false)
    },
  )

  it('skips empty IDs and pre-cancelled subscribers', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    expect(await loadNativeLyrics(query, controller.signal)).toBeNull()
    expect(await loadNativeLyrics({ ...query, id: '' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
