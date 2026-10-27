import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  WORD_LYRICS_MIRRORS,
  WORD_LYRICS_NEGATIVE_TTL_MS,
  WORD_LYRICS_POSITIVE_TTL_MS,
  WORD_LYRICS_QUERY_TIMEOUT_MS,
} from '../config/lyrics'
import {
  getWordLyricsQueryKey,
  hasCachedWordLyrics,
  invalidateWordLyrics,
  loadWordLyrics,
  resetWordLyricsCache,
  setWordLyricsCacheStore,
} from '../services/lyrics-db'
import type { LyricsCacheRecord } from '../core/platform/lyrics-cache'

const TTML = `<tt><body><div><p begin="00:01.000" end="00:02.000"><span begin="00:01.000" end="00:01.400">你</span><span begin="00:01.400" end="00:02.000">好</span></p></div></body></tt>`
const YRC = '[1000,900](1000,400,0)你(1400,500,0)好'
const query = { platform: 'netease' as const, id: '123' }

function song(id = 1, title = 'Hello', artist = 'Artist', album = 'Album') {
  return {
    id,
    filename: `${id}.ttml`,
    musicNames: [title],
    artistNames: [artist],
    albumNames: [album],
  }
}

function success(data: unknown): Response {
  return Response.json({ status: 200, data })
}

function hit(id = 1): Response {
  return success({ ...song(id), lyrics: TTML, format: 'ttml' })
}

function missing(): Response {
  return Response.json({ status: 404, error: 'Not Found' }, { status: 404 })
}

function search(items: ReturnType<typeof song>[], hasMore = false): Response {
  return success({ items, pagination: { page: 1, pageSize: 100, total: items.length, hasMore } })
}

describe('loadWordLyrics', () => {
  let records: Map<string, LyricsCacheRecord>

  beforeEach(() => {
    resetWordLyricsCache()
    records = new Map()
    setWordLyricsCacheStore({
      get: async (key) => records.get(key) ?? null,
      set: async (record) => {
        records.set(record.key, record)
      },
    })
  })

  afterEach(() => {
    resetWordLyricsCache()
    setWordLyricsCacheStore(null)
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('refreshes a single cached query without dropping another song', async () => {
    const fetchMock = vi.fn(async () => hit())
    vi.stubGlobal('fetch', fetchMock)
    const other = { ...query, id: 'other' }
    const first = await loadWordLyrics(query)
    const second = await loadWordLyrics(other)
    await flushPromises()
    await invalidateWordLyrics(query)
    expect(await loadWordLyrics(other)).toBe(second)
    expect(await loadWordLyrics(query)).not.toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('does not restore memory or persistence when storage is cleared during a request', async () => {
    let generation = 0
    const write = vi.fn(async () => undefined)
    setWordLyricsCacheStore({
      get generation() {
        return generation
      },
      get: async () => null,
      set: write,
    })
    let complete!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve
          }),
      ),
    )
    const pending = loadWordLyrics(query)
    await flushPromises()
    generation += 1
    complete(hit())
    expect(await pending).toBeNull()
    expect(hasCachedWordLyrics(query)).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('queries the official platform ID endpoint and returns native timings', async () => {
    const fetchMock = vi.fn().mockImplementation(() => hit())
    vi.stubGlobal('fetch', fetchMock)
    const lines = await loadWordLyrics(query)
    expect(lines?.[0]?.wordSource).toBe('native')
    expect(lines?.[0]?.words).toHaveLength(2)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.amll.dev/v1/lyrics/get?ncmMusicId=123')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-cache' })
  })

  it('uses qqMusicId for QQ songmid values', async () => {
    const fetchMock = vi.fn().mockImplementation(() => hit())
    vi.stubGlobal('fetch', fetchMock)
    await loadWordLyrics({ platform: 'tencent', id: '004d5o8E' })
    expect(fetchMock.mock.calls[0]?.[0]).toContain('qqMusicId=004d5o8E')
  })

  it('shares a request and caches its parsed result', async () => {
    const fetchMock = vi.fn().mockImplementation(() => hit())
    vi.stubGlobal('fetch', fetchMock)
    const [first, second] = await Promise.all([loadWordLyrics(query), loadWordLyrics(query)])
    expect(first).toBe(second)
    expect(await loadWordLyrics(query)).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hasCachedWordLyrics(query)).toBe(true)
  })

  it('caches an official miss, without polling static mirrors', async () => {
    const fetchMock = vi.fn().mockImplementation(missing)
    vi.stubGlobal('fetch', fetchMock)
    expect(await loadWordLyrics(query)).toBeNull()
    expect(await loadWordLyrics(query)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(hasCachedWordLyrics(query)).toBe(true)
  })

  it('continues past a stale CDN 404 when the official API is unavailable', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('api.amll.dev')) return new Response('', { status: 503 })
      if (url.startsWith(WORD_LYRICS_MIRRORS[0]!.baseUrl)) return new Response('', { status: 404 })
      return new Response(TTML)
    })
    vi.stubGlobal('fetch', fetchMock)
    expect((await loadWordLyrics(query))?.[0]?.wordSource).toBe('native')
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith(WORD_LYRICS_MIRRORS[1]!.baseUrl)),
    ).toBe(true)
  })

  it('does not turn API failure plus mirror 404s into a cached miss', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('api.amll.dev')
        ? new Response('', { status: 429 })
        : new Response('', { status: 404 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await loadWordLyrics(query)).toBeNull()
    expect(hasCachedWordLyrics(query)).toBe(false)
    fetchMock.mockImplementation(async () => hit())
    expect((await loadWordLyrics(query))?.[0]?.wordSource).toBe('native')
  })

  it('recovers through mirrors when an API success contains invalid lyric content', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('api.amll.dev')
          ? success({ ...song(), lyrics: '<html>Bad gateway</html>' })
          : new Response(TTML),
      ),
    )
    expect((await loadWordLyrics(query))?.[0]?.wordSource).toBe('native')
  })

  it('tries another mirror format when TTML contains no native timing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('api.amll.dev')) throw new Error('offline')
        return new Response(url.endsWith('.yrc') ? YRC : '[00:01]plain line')
      }),
    )
    expect((await loadWordLyrics(query))?.[0]?.words).toHaveLength(2)
  })

  it('searches without a platform ID and only fetches the unique exact candidate', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/search?')
        ? search([song(42, 'Hello', 'Artist', 'Album'), song(43, 'Hello (Live)')])
        : hit(42),
    )
    vi.stubGlobal('fetch', fetchMock)
    const lines = await loadWordLyrics({ title: '  HELLO ', artist: 'Artist', album: 'Album' })
    expect(lines?.[0]?.wordSource).toBe('native')
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(url.searchParams.get('musicName')).toBe('HELLO')
    expect(url.searchParams.get('artistName')).toBe('Artist')
    expect(url.searchParams.get('albumName')).toBe('Album')
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/get?id=42')
  })

  it('falls back to metadata after an official platform miss', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('ncmMusicId')) return missing()
      return url.includes('/search?') ? search([song(42)]) : hit(42)
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(
      (await loadWordLyrics({ ...query, title: 'Hello', artist: 'Artist' }))?.[0]?.wordSource,
    ).toBe('native')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['a different version', [song(1, 'Hello (Live)')], false],
    ['a different artist', [song(1, 'Hello', 'Other')], false],
    ['ambiguous recordings', [song(1), song(2)], false],
    ['an incomplete result page', [song(1)], true],
  ])('rejects %s instead of assigning unrelated lyrics', async (_label, items, hasMore) => {
    const fetchMock = vi.fn().mockImplementation(() => search(items, hasMore))
    vi.stubGlobal('fetch', fetchMock)
    expect(await loadWordLyrics({ title: 'Hello', artist: 'Artist' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not cache malformed API responses as missing lyrics', async () => {
    const fetchMock = vi.fn().mockImplementation(() => success({ items: 'invalid' }))
    vi.stubGlobal('fetch', fetchMock)
    const metadata = { title: 'Hello', artist: 'Artist' }
    expect(await loadWordLyrics(metadata)).toBeNull()
    expect(hasCachedWordLyrics(metadata)).toBe(false)
  })

  it('retains complete version and album metadata in cache keys', () => {
    const base = { title: 'Hello', artist: 'Artist' }
    expect(getWordLyricsQueryKey(base)).toBe(
      getWordLyricsQueryKey({ title: ' HELLO ', artist: 'artist' }),
    )
    expect(getWordLyricsQueryKey(base)).not.toBe(
      getWordLyricsQueryKey({ ...base, title: 'Hello (Live)' }),
    )
    expect(getWordLyricsQueryKey(base)).not.toBe(getWordLyricsQueryKey({ ...base, album: 'Other' }))
  })

  it('restores raw lyrics from persistent storage after clearing the memory cache', async () => {
    const fetchMock = vi.fn().mockImplementation(() => hit())
    vi.stubGlobal('fetch', fetchMock)
    await loadWordLyrics(query)
    await flushPromises()
    resetWordLyricsCache()
    expect((await loadWordLyrics(query))?.[0]?.wordSource).toBe('native')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(records.get(getWordLyricsQueryKey(query))?.text).toBe(TTML)
  })

  it.each([
    ['positive', WORD_LYRICS_POSITIVE_TTL_MS, hit],
    ['negative', WORD_LYRICS_NEGATIVE_TTL_MS, missing],
  ])('expires %s entries in memory and persistent storage', async (_name, ttl, reply) => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockImplementation(() => reply())
    vi.stubGlobal('fetch', fetchMock)
    await loadWordLyrics(query)
    expect(hasCachedWordLyrics(query)).toBe(true)
    vi.setSystemTime(Date.now() + ttl + 1)
    expect(hasCachedWordLyrics(query)).toBe(false)
    await loadWordLyrics(query)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('ignores incompatible persisted cache versions', async () => {
    records.set(getWordLyricsQueryKey(query), {
      cacheVersion: 0,
      key: getWordLyricsQueryKey(query),
      text: null,
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    } as unknown as LyricsCacheRecord)
    const fetchMock = vi.fn().mockImplementation(() => hit())
    vi.stubGlobal('fetch', fetchMock)
    expect((await loadWordLyrics(query))?.[0]?.wordSource).toBe('native')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('continues when persistence reads and writes fail', async () => {
    setWordLyricsCacheStore({
      get: async () => {
        throw new Error('disabled')
      },
      set: async () => {
        throw new Error('quota')
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => hit()),
    )
    expect((await loadWordLyrics(query))?.[0]?.wordSource).toBe('native')
    expect(hasCachedWordLyrics(query)).toBe(true)
  })

  it('bounds a stuck persistence read without delaying the network indefinitely', async () => {
    vi.useFakeTimers()
    setWordLyricsCacheStore({ get: () => new Promise(() => {}), set: async () => {} })
    const fetchMock = vi.fn().mockImplementation(() => hit())
    vi.stubGlobal('fetch', fetchMock)
    const pending = loadWordLyrics(query)
    await vi.advanceTimersByTimeAsync(501)
    expect((await pending)?.[0]?.wordSource).toBe('native')
  })

  it('cancels only one subscriber while another still needs the shared query', async () => {
    let resolveFetch!: (response: Response) => void
    let networkSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        networkSignal = init?.signal ?? undefined
        return new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
      }),
    )
    const controller = new AbortController()
    const first = loadWordLyrics(query, controller.signal)
    const second = loadWordLyrics(query)
    await flushPromises()
    controller.abort()
    expect(await first).toBeNull()
    expect(networkSignal?.aborted).toBe(false)
    resolveFetch(hit())
    expect((await second)?.[0]?.wordSource).toBe('native')
  })

  it('aborts work after its final subscriber leaves and permits a fresh retry', async () => {
    let networkSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      networkSignal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = loadWordLyrics(query, controller.signal)
    await flushPromises()
    controller.abort()
    expect(await pending).toBeNull()
    expect(networkSignal?.aborted).toBe(true)
    expect(hasCachedWordLyrics(query)).toBe(false)
    fetchMock.mockImplementation(async () => hit())
    expect((await loadWordLyrics(query))?.[0]?.wordSource).toBe('native')
  })

  it('bounds total query time including waiting for a network slot', async () => {
    vi.useFakeTimers()
    let active = 0
    let maximum = 0
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        active += 1
        maximum = Math.max(maximum, active)
        init?.signal?.addEventListener(
          'abort',
          () => {
            active -= 1
          },
          { once: true },
        )
        return new Promise<Response>(() => {})
      }),
    )
    const pending = Array.from({ length: 12 }, (_, id) =>
      loadWordLyrics({ ...query, id: String(id) }),
    )
    await vi.advanceTimersByTimeAsync(WORD_LYRICS_QUERY_TIMEOUT_MS + 1)
    expect(await Promise.all(pending)).toEqual(Array(12).fill(null))
    expect(maximum).toBeLessThanOrEqual(4)
    expect(active).toBe(0)
    expect(hasCachedWordLyrics(query)).toBe(false)
  })

  it('skips incomplete or already cancelled queries', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()
    expect(await loadWordLyrics(query, controller.signal)).toBeNull()
    expect(await loadWordLyrics({ platform: 'netease', id: '' })).toBeNull()
    expect(await loadWordLyrics({ title: 'Hello' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
