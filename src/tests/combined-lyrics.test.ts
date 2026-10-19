import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  getCombinedLyricsCacheToken,
  getLyricsSource,
  loadCombinedLyrics,
  loadTrackLyrics,
  registerTrackLyrics,
} from '../services/lyrics'
import * as lyricsDb from '../services/lyrics-db'
import * as nativeLyrics from '../services/native-lyrics'
import { parseAnyLyrics } from '../core/lyrics'
import type { LyricLine, LyricProviderSource, Track } from '../core/types'

const TTML = `<tt><body><div><p begin="00:01.000" end="00:02.000"><span begin="00:01.000" end="00:01.400">你</span><span begin="00:01.400" end="00:02.000">好</span></p></div></body></tt>`

function routeFetch(routes: Record<string, Response | Error>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    for (const [needle, value] of Object.entries(routes)) {
      if (!url.includes(needle)) continue
      if (value instanceof Error) throw value
      return value.clone()
    }
    return new Response('', { status: 404 })
  })
}

describe('loadCombinedLyrics', () => {
  beforeEach(() => {
    vi.spyOn(lyricsDb, 'loadWordLyrics').mockResolvedValue(null)
    vi.spyOn(nativeLyrics, 'loadNativeLyrics').mockResolvedValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('prefers the word timeline over the plain lyrics when the database has a hit', async () => {
    vi.mocked(lyricsDb.loadWordLyrics).mockResolvedValue(parseAnyLyrics(TTML))
    vi.stubGlobal(
      'fetch',
      routeFetch({
        'plain-1.lrc': new Response('[00:01.00]你好', { status: 200 }),
      }),
    )

    const lines = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/plain-1.lrc',
      wordQuery: { platform: 'netease', id: '1' },
    })

    expect(lines[0]?.wordSource).toBe('native')
    expect(lines[0]?.words).toHaveLength(2)
  })

  it('shows plain lyrics before a slow word source and upgrades them afterwards', async () => {
    let resolveWords!: (lines: LyricLine[]) => void
    const words = new Promise<LyricLine[]>((resolve) => {
      resolveWords = resolve
    })
    vi.mocked(lyricsDb.loadWordLyrics).mockReturnValue(words)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[00:01.00]你好 (hello)')),
    )
    const progress = vi.fn()
    const result = loadCombinedLyrics(
      {
        lyricsUrl: 'https://cdn.example.com/progressive.lrc',
        wordQuery: { platform: 'netease', id: 'progressive' },
      },
      undefined,
      progress,
    )
    await flushPromises()
    expect(progress).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ text: '你好', translation: 'hello' })]),
    )
    expect(progress.mock.calls.at(-1)?.[0][0]?.wordSource).toBeUndefined()
    resolveWords(parseAnyLyrics(TTML))
    const final = await result
    expect(final[0]?.wordSource).toBe('native')
    expect(progress.mock.calls.at(-1)?.[0][0]).toMatchObject({
      wordSource: 'native',
      translation: 'hello',
    })
    expect(final).toBe(progress.mock.calls.at(-1)?.[0])
    expect(progress).toHaveBeenCalledTimes(2)
  })

  it('borrows translations from the plain lyrics because TTML often has none', async () => {
    vi.mocked(lyricsDb.loadWordLyrics).mockResolvedValue(parseAnyLyrics(TTML))
    vi.stubGlobal(
      'fetch',
      routeFetch({
        'plain-2.lrc': new Response('[00:01.00]你好 (hello)', { status: 200 }),
      }),
    )

    const lines = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/plain-2.lrc',
      wordQuery: { platform: 'netease', id: '2' },
    })

    expect(lines[0]?.translation).toBe('hello')
  })

  it('leaves plain lyrics without a word timeline when the database misses', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({ 'plain-3.lrc': new Response('[00:01.00]你好世界', { status: 200 }) }),
    )

    const lines = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/plain-3.lrc',
      wordQuery: { platform: 'netease', id: '3' },
    })

    // 没命中逐字库就老老实实整行高亮,不猜音节
    expect(lines[0]).toMatchObject({ time: 1, text: '你好世界' })
    expect(lines[0]?.words).toBeUndefined()
    expect(lines[0]?.wordSource).toBeUndefined()
  })

  it('keeps the word timeline even when the plain lyrics request fails', async () => {
    vi.mocked(lyricsDb.loadWordLyrics).mockResolvedValue(parseAnyLyrics(TTML))
    vi.stubGlobal(
      'fetch',
      routeFetch({
        'plain-4.lrc': new Error('offline'),
      }),
    )

    const lines = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/plain-4.lrc',
      wordQuery: { platform: 'netease', id: '4' },
    })

    expect(lines[0]?.wordSource).toBe('native')
  })

  it('surfaces the plain lyrics failure when there is no word timeline to fall back on', async () => {
    vi.stubGlobal('fetch', routeFetch({ 'plain-5.lrc': new Error('offline') }))

    await expect(
      loadCombinedLyrics({
        lyricsUrl: 'https://cdn.example.com/plain-5.lrc',
        wordQuery: { platform: 'netease', id: '5' },
      }),
    ).rejects.toThrow('offline')
  })

  it('does not query the database when no query was supplied', async () => {
    const fetchMock = routeFetch({
      'plain-6.lrc': new Response('[00:01.00]你好', { status: 200 }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await loadCombinedLyrics({ lyricsUrl: 'https://cdn.example.com/plain-6.lrc' })

    expect(lyricsDb.loadWordLyrics).not.toHaveBeenCalled()
  })

  it('does not republish word lyrics when late plain lyrics add no translations', async () => {
    const wordLines = parseAnyLyrics(TTML)
    vi.mocked(lyricsDb.loadWordLyrics).mockResolvedValue(wordLines)
    let resolvePlain!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvePlain = resolve
          }),
      ),
    )
    const progress = vi.fn()
    const request = loadCombinedLyrics(
      {
        lyricsUrl: 'https://cdn.example.com/late-plain.lrc',
        wordQuery: { platform: 'netease', id: 'late-plain' },
      },
      undefined,
      progress,
    )
    await flushPromises()
    expect(progress).toHaveBeenCalledExactlyOnceWith(wordLines)

    resolvePlain(new Response('[00:01.00]你好'))
    await expect(request).resolves.toBe(wordLines)
    expect(progress).toHaveBeenCalledTimes(1)
  })

  it('adds late translations once and returns the published merged result', async () => {
    vi.mocked(lyricsDb.loadWordLyrics).mockResolvedValue(parseAnyLyrics(TTML))
    let resolvePlain!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolvePlain = resolve
          }),
      ),
    )
    const progress = vi.fn()
    const request = loadCombinedLyrics(
      {
        lyricsUrl: 'https://cdn.example.com/late-translation.lrc',
        wordQuery: { platform: 'netease', id: 'late-translation' },
      },
      undefined,
      progress,
    )
    await flushPromises()
    resolvePlain(new Response('[00:01.00]你好 (hello)'))

    const result = await request
    expect(result[0]?.translation).toBe('hello')
    expect(result).toBe(progress.mock.calls.at(-1)?.[0])
    expect(progress).toHaveBeenCalledTimes(2)
  })

  it('shows platform lyrics while AMLL is pending, then upgrades and retains auxiliary text', async () => {
    let resolveWords!: (lines: LyricLine[]) => void
    vi.mocked(lyricsDb.loadWordLyrics).mockReturnValue(
      new Promise((resolve) => {
        resolveWords = resolve
      }),
    )
    const platform = parseAnyLyrics('[1000,900](1000,400,0)你(1400,500,0)好')
    platform[0]!.translation = 'Hello'
    platform[0]!.roman = 'ni hao'
    vi.mocked(nativeLyrics.loadNativeLyrics).mockResolvedValue(platform)
    const progress = vi.fn()
    const pending = loadCombinedLyrics(
      { wordQuery: { platform: 'netease', id: 'native-first' } },
      undefined,
      progress,
    )
    await flushPromises()
    expect(progress).toHaveBeenCalledExactlyOnceWith(platform)
    resolveWords(parseAnyLyrics(TTML))
    const result = await pending
    expect(result[0]).toMatchObject({ endTime: 2, translation: 'Hello', roman: 'ni hao' })
    expect(result).toBe(progress.mock.calls.at(-1)?.[0])
    expect(progress).toHaveBeenCalledTimes(2)
  })

  it('keeps platform lyrics when AMLL misses and the plain request fails', async () => {
    const platform = parseAnyLyrics('[1000,900](1000,400,0)你(1400,500,0)好')
    vi.mocked(nativeLyrics.loadNativeLyrics).mockResolvedValue(platform)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('plain unavailable')))
    const result = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/native-fallback.lrc',
      wordQuery: { platform: 'tencent', id: 'native-fallback' },
    })
    expect(result).toBe(platform)
    expect(getLyricsSource(result)).toBe('qq')
    expect(nativeLyrics.loadNativeLyrics).toHaveBeenCalledWith(
      { source: 'qq', id: 'native-fallback' },
      undefined,
    )
  })

  it('does not republish an already merged AMLL result when late native lyrics add nothing', async () => {
    let resolveNative!: (lines: LyricLine[]) => void
    vi.mocked(lyricsDb.loadWordLyrics).mockResolvedValue(parseAnyLyrics(TTML))
    vi.mocked(nativeLyrics.loadNativeLyrics).mockReturnValue(
      new Promise((resolve) => {
        resolveNative = resolve
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[00:01]你好 (hello)')),
    )
    const progress = vi.fn()
    const pending = loadCombinedLyrics(
      {
        lyricsUrl: 'https://cdn.example.com/late-native.lrc',
        wordQuery: { platform: 'netease', id: 'late-native' },
      },
      undefined,
      progress,
    )
    await flushPromises()
    const before = progress.mock.calls.at(-1)?.[0]
    const count = progress.mock.calls.length
    resolveNative(parseAnyLyrics('[1000,900](1000,400,0)你(1400,500,0)好'))
    expect(await pending).toBe(before)
    expect(progress).toHaveBeenCalledTimes(count)
  })

  it('never requests a platform endpoint from metadata alone', async () => {
    await loadCombinedLyrics({ wordQuery: { title: 'Local title', artist: 'Artist' } })
    expect(nativeLyrics.loadNativeLyrics).not.toHaveBeenCalled()
  })

  it('keeps composite freshness tokens stable and changes them when either source changes', () => {
    let word: object | null = {}
    let native: object | null = {}
    vi.spyOn(lyricsDb, 'getWordLyricsCacheToken').mockImplementation(() => word)
    vi.spyOn(nativeLyrics, 'getNativeLyricsCacheToken').mockImplementation(() => native)
    const query = { platform: 'netease' as const, id: 'token' }
    const first = getCombinedLyricsCacheToken(query)
    expect(getCombinedLyricsCacheToken({ ...query })).toBe(first)
    native = {}
    const second = getCombinedLyricsCacheToken(query)
    expect(second).not.toBe(first)
    expect(getCombinedLyricsCacheToken(query)).toBe(second)
    word = {}
    expect(getCombinedLyricsCacheToken(query)).not.toBe(second)
    native = null
    expect(getCombinedLyricsCacheToken(query)).toBeNull()
    expect(getCombinedLyricsCacheToken({ title: 'Metadata only', artist: 'Artist' })).toBe(word)
  })

  it('records the actual progressive source before each publish and retains it in the track cache', async () => {
    let resolveWords!: (lines: LyricLine[]) => void
    let resolveNative!: (lines: LyricLine[]) => void
    vi.mocked(lyricsDb.loadWordLyrics).mockReturnValue(
      new Promise((resolve) => {
        resolveWords = resolve
      }),
    )
    vi.mocked(nativeLyrics.loadNativeLyrics).mockReturnValue(
      new Promise((resolve) => {
        resolveNative = resolve
      }),
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[00:01]你好 (Hello)')),
    )
    const observed: Array<LyricProviderSource | null> = []
    const published: LyricLine[][] = []
    const track: Track = {
      id: 'provenance-progress',
      title: 'Progress',
      artist: 'Artist',
      audioUrl: '/progress.mp3',
      kind: 'remote',
    }
    const load = vi.fn((signal?: AbortSignal, onProgress?: (lines: LyricLine[]) => void) =>
      loadCombinedLyrics(
        {
          lyricsUrl: 'https://cdn.example.com/provenance-progress.lrc',
          wordQuery: { platform: 'netease', id: 'provenance-progress' },
        },
        signal,
        onProgress,
      ),
    )
    registerTrackLyrics(track, { cacheKey: 'provenance-progress', load })
    const pending = loadTrackLyrics(track, undefined, (lines) => {
      observed.push(getLyricsSource(lines))
      published.push(lines)
    })
    await flushPromises()
    expect(observed).toEqual(['meting'])
    resolveNative(parseAnyLyrics('[1000,900](1000,400,0)你(1400,500,0)好'))
    await flushPromises()
    expect(observed).toEqual(['meting', 'netease'])
    resolveWords(parseAnyLyrics(TTML))
    const result = await pending
    expect(observed).toEqual(['meting', 'netease', 'amll'])
    expect(result).toBe(published.at(-1))
    expect(result[0]?.translation).toBe('Hello')
    expect(getLyricsSource(result)).toBe('amll')
    const replay = vi.fn((lines: LyricLine[]) => getLyricsSource(lines))
    expect(await loadTrackLyrics(track, undefined, replay)).toBe(result)
    expect(replay.mock.results[0]?.value).toBe('amll')
    expect(load).toHaveBeenCalledTimes(1)
    expect(getLyricsSource(published[0]!)).toBe('meting')
    expect(getLyricsSource(published[1]!)).toBe('netease')
  })

  it('identifies Meting-delivered word timings by their actual path instead of their format', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(TTML)),
    )
    const result = await loadCombinedLyrics({
      lyricsUrl: 'https://cdn.example.com/meting-ttml-source.lrc',
    })
    expect(result[0]?.wordSource).toBe('native')
    expect(getLyricsSource(result)).toBe('meting')
    expect(getLyricsSource([])).toBeNull()
  })
})
