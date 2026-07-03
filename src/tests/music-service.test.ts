import { describe, expect, it, vi } from 'vitest'
import { hasTrackLyricsSource, loadTrackLyrics } from '../services/lyrics'
import { loadConfiguredTracks, loadMusicConfig } from '../services/music'
import type { PublicMusicConfig } from '../types/music'
import type { MusicProviderAdapter } from '../services/music-adapters/types'

describe('music service', () => {
  it('loads the compiled public config without requesting the worker runtime config', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const config = loadMusicConfig()

    expect(config.siteName).toBe('Meliora')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps successful sources and local tracks when one source fails', async () => {
    const config: PublicMusicConfig = {
      siteName: 'test',
      apiEndpoint: 'https://test/api',
      playlists: [
        { server: 'netease', playlistId: 'one' },
        { server: 'tencent', playlistId: 'two' },
      ],
      localTracks: [
        { id: 'local', title: 'Local Song', artist: 'Artist', audio: '/music/local.mp3' },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify([{ title: 'Remote Song', author: 'Singer', url: '/remote.mp3' }]),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response('failed', { status: 500 })),
    )

    const result = await loadConfiguredTracks(config)
    expect(result.failedSources).toBe(1)
    expect(result.tracks.map((track) => track.title)).toEqual(['Remote Song', 'Local Song'])
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
      'https://test/api?server=netease&type=playlist&id=one',
      'https://test/api?server=tencent&type=playlist&id=two',
    ])
  })

  it('loads remote tracks through the configured adapter contract', async () => {
    const config: PublicMusicConfig = {
      siteName: 'test',
      apiEndpoint: 'https://custom.example.com/music',
      playlists: [{ server: 'netease', playlistId: 'adapter-source' }],
      localTracks: [],
    }
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const adapter: MusicProviderAdapter<PublicMusicConfig['playlists'][number]> = {
      id: 'custom',
      load: vi.fn().mockResolvedValue([
        {
          id: 'custom:adapter-source:1',
          title: 'Adapter Song',
          artist: 'Adapter Artist',
          audioUrl: 'https://cdn.example.com/adapter.mp3',
          kind: 'remote',
        },
      ]),
    }

    const result = await loadConfiguredTracks(config, {
      adapters: {
        meting: adapter,
      },
    })

    expect(result).toEqual({
      failedSources: 0,
      tracks: [
        {
          id: 'custom:adapter-source:1',
          title: 'Adapter Song',
          artist: 'Adapter Artist',
          audioUrl: 'https://cdn.example.com/adapter.mp3',
          kind: 'remote',
        },
      ],
    })
    expect(adapter.load).toHaveBeenCalledWith(config.playlists[0], {
      apiEndpoint: 'https://custom.example.com/music',
      timeoutMs: 8000,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('loads local tracks through the local adapter and keeps lyric parsing out of the player', async () => {
    const config: PublicMusicConfig = {
      siteName: 'test',
      apiEndpoint: 'https://custom.example.com/music',
      playlists: [],
      localTracks: [
        {
          id: 'local-with-lyrics',
          title: 'Local With Lyrics',
          artist: 'Local Artist',
          audio: '/music/local.mp3',
          lyrics: '/lyrics/local.lrc',
        },
      ],
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('[00:01.00]Local line (本地翻译)', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await loadConfiguredTracks(config)
    const track = result.tracks[0]

    expect(track).toMatchObject({
      id: 'local:local-with-lyrics',
      title: 'Local With Lyrics',
      artist: 'Local Artist',
      audioUrl: '/music/local.mp3',
      kind: 'local',
    })
    expect(track).not.toHaveProperty('lyricsUrl')
    expect(track).not.toHaveProperty('lyricsLoader')
    expect(hasTrackLyricsSource(track)).toBe(true)
    await expect(loadTrackLyrics(track!)).resolves.toEqual([
      { time: 1, text: 'Local line', translation: '本地翻译' },
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      '/lyrics/local.lrc',
      expect.objectContaining({ cache: 'force-cache' }),
    )
  })

  it('keeps lyrics from a duplicate source when the first duplicate has no lyrics', async () => {
    const config: PublicMusicConfig = {
      siteName: 'test',
      apiEndpoint: 'https://custom.example.com/music',
      playlists: [],
      localTracks: [
        {
          id: 'first',
          title: 'Duplicate Song',
          artist: 'Same Artist',
          audio: '/music/first.mp3',
        },
        {
          id: 'second',
          title: 'Duplicate Song',
          artist: 'Same Artist',
          audio: '/music/second.mp3',
          lyrics: '/lyrics/second.lrc',
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('[00:02.00]Merged lyric', { status: 200 })),
    )

    const result = await loadConfiguredTracks(config)
    const track = result.tracks[0]

    expect(result.tracks).toHaveLength(1)
    expect(track?.id).toBe('local:first')
    expect(hasTrackLyricsSource(track)).toBe(true)
    await expect(loadTrackLyrics(track!)).resolves.toEqual([{ time: 2, text: 'Merged lyric' }])
  })
})
