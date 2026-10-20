import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildMetingPlaylistUrl,
  extractMetingTrackId,
  metingMusicAdapter,
} from '../services/music-adapters/meting'
import { hasCachedTrackLyrics, hasTrackLyricsSource, loadTrackLyrics } from '../services/lyrics'
import * as lyricsDb from '../services/lyrics-db'
import * as nativeLyrics from '../services/native-lyrics'

beforeEach(() => {
  vi.spyOn(nativeLyrics, 'loadNativeLyrics').mockResolvedValue(null)
  vi.spyOn(nativeLyrics, 'getNativeLyricsCacheToken').mockReturnValue({})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Meting response loading', () => {
  it('times out while reading a stalled body after receiving headers', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason))
              },
            }),
          ),
        ),
      ),
    )
    const result = metingMusicAdapter.load(
      { server: 'netease', playlistId: 'slow' },
      {
        apiEndpoint: 'https://api.example.com',
        timeoutMs: 8000,
      },
    )
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(8000)
    await assertion
  })

  it('keeps valid tracks when another row has malformed fields', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              null,
              { title: 123, url: '/bad.mp3' },
              { title: 'Good', author: 'Artist', url: '/good.mp3' },
            ]),
          ),
      ),
    )
    const tracks = await metingMusicAdapter.load(
      { server: 'netease', playlistId: 'mixed' },
      {
        apiEndpoint: 'https://api.example.com',
        timeoutMs: 8000,
      },
    )
    expect(tracks.map((track) => track.title)).toEqual(['Good'])
  })

  it('looks up the platform id from the audio URL even without a plain lyrics URL', async () => {
    const lines = [{ time: 1, text: 'Found without LRC' }]
    const loadWords = vi.spyOn(lyricsDb, 'loadWordLyrics').mockResolvedValue(lines)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          {
            title: 'Missing plain lyrics',
            author: 'Artist',
            url: 'https://api.example.com?server=netease&type=url&id=missing-lrc',
          },
        ]),
      ),
    )
    const [track] = await metingMusicAdapter.load(
      { server: 'netease', playlistId: 'word-only' },
      { apiEndpoint: 'https://api.example.com', timeoutMs: 8000 },
    )

    expect(hasTrackLyricsSource(track)).toBe(true)
    await expect(loadTrackLyrics(track)).resolves.toBe(lines)
    expect(loadWords).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'netease', id: 'missing-lrc' }),
      expect.any(AbortSignal),
    )
    expect(nativeLyrics.loadNativeLyrics).toHaveBeenCalledWith(
      { source: 'netease', id: 'missing-lrc' },
      expect.any(AbortSignal),
    )
  })

  it('passes original metadata when neither resource URL contains a platform id', async () => {
    const loadWords = vi.spyOn(lyricsDb, 'loadWordLyrics').mockResolvedValue([])
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          {
            title: 'Versioned Song (Live)',
            author: 'Versioned Artist',
            url: 'https://cdn.example.com/versioned.mp3',
          },
        ]),
      ),
    )
    const [track] = await metingMusicAdapter.load(
      { server: 'netease', playlistId: 'metadata-only' },
      { apiEndpoint: 'https://api.example.com', timeoutMs: 8000 },
    )

    await loadTrackLyrics(track)
    expect(loadWords).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Versioned Song (Live)',
        artist: 'Versioned Artist',
        id: undefined,
      }),
      expect.any(AbortSignal),
    )
  })

  it('keeps different metadata queries separate when tracks share a plain lyrics URL', async () => {
    const loadWords = vi
      .spyOn(lyricsDb, 'loadWordLyrics')
      .mockResolvedValueOnce([{ time: 1, text: 'First song' }])
      .mockResolvedValueOnce([{ time: 1, text: 'Second song' }])
    vi.spyOn(lyricsDb, 'hasCachedWordLyrics').mockReturnValue(true)
    vi.spyOn(lyricsDb, 'getWordLyricsCacheToken').mockReturnValue({})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('shared.lrc')
          ? new Response('[00:01.00]Plain lyrics')
          : Response.json([
              {
                title: 'First song',
                author: 'Artist',
                url: 'https://cdn.example.com/first.mp3',
                lrc: 'https://cdn.example.com/shared.lrc',
              },
              {
                title: 'Second song',
                author: 'Artist',
                url: 'https://cdn.example.com/second.mp3',
                lrc: 'https://cdn.example.com/shared.lrc',
              },
            ]),
      ),
    )
    const tracks = await metingMusicAdapter.load(
      { server: 'netease', playlistId: 'shared-lyrics-url' },
      { apiEndpoint: 'https://api.example.com', timeoutMs: 8000 },
    )

    expect((await loadTrackLyrics(tracks[0]))[0]?.text).toBe('First song')
    expect((await loadTrackLyrics(tracks[1]))[0]?.text).toBe('Second song')
    expect(loadWords).toHaveBeenCalledTimes(2)
  })

  it('invalidates combined track lyrics when the native source expires or refreshes', async () => {
    vi.spyOn(lyricsDb, 'loadWordLyrics').mockResolvedValue(null)
    vi.spyOn(lyricsDb, 'getWordLyricsCacheToken').mockReturnValue({})
    let nativeToken: object | null = {}
    vi.mocked(nativeLyrics.getNativeLyricsCacheToken).mockImplementation(() => nativeToken)
    const initial = [{ time: 1, text: 'Native original' }]
    const updated = [{ time: 1, text: 'Native updated' }]
    vi.mocked(nativeLyrics.loadNativeLyrics)
      .mockResolvedValueOnce(initial)
      .mockImplementation(async () => {
        nativeToken = {}
        return updated
      })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json([
          {
            title: 'Native expiry',
            author: 'Artist',
            url: '/meting?type=url&id=native-expiry',
          },
        ]),
      ),
    )
    const [track] = await metingMusicAdapter.load(
      { server: 'netease', playlistId: 'native-expiry' },
      { apiEndpoint: 'https://api.example.com', timeoutMs: 8000 },
    )
    expect(await loadTrackLyrics(track)).toBe(initial)
    expect(hasCachedTrackLyrics(track)).toBe(true)
    expect(await loadTrackLyrics(track)).toBe(initial)
    expect(nativeLyrics.loadNativeLyrics).toHaveBeenCalledTimes(1)
    nativeToken = null
    expect(hasCachedTrackLyrics(track)).toBe(false)
    expect(await loadTrackLyrics(track)).toBe(updated)
    expect(nativeLyrics.loadNativeLyrics).toHaveBeenCalledTimes(2)
    nativeToken = {}
    expect(hasCachedTrackLyrics(track)).toBe(false)
  })
})

describe('buildMetingPlaylistUrl', () => {
  it('merges playlist params with query params already present on apiEndpoint', () => {
    const url = new URL(
      buildMetingPlaylistUrl('https://api.example.com/meting?format=json&server=tencent', {
        server: 'netease',
        playlistId: '123',
      }),
    )

    expect(url.origin).toBe('https://api.example.com')
    expect(url.pathname).toBe('/meting')
    expect(url.searchParams.get('format')).toBe('json')
    expect(url.searchParams.get('server')).toBe('netease')
    expect(url.searchParams.get('type')).toBe('playlist')
    expect(url.searchParams.get('id')).toBe('123')
  })
})

describe('extractMetingTrackId', () => {
  it('reads the platform song id back out of an absolute resource url', () => {
    expect(
      extractMetingTrackId('https://api.example.com/meting?server=netease&type=lrc&id=1974443814'),
    ).toBe('1974443814')
  })

  it('handles relative endpoints and QQ song mids', () => {
    expect(extractMetingTrackId('/api/meting?server=tencent&type=url&id=004d5o8E19OLXw')).toBe(
      '004d5o8E19OLXw',
    )
  })

  it('returns null when there is no id to work with', () => {
    // 资源地址没有 ID 时,调用方仍可尝试歌名/歌手匹配。
    expect(extractMetingTrackId('https://cdn.example.com/song.lrc')).toBeNull()
    expect(extractMetingTrackId('?id=')).toBeNull()
    expect(extractMetingTrackId('')).toBeNull()
  })
})
