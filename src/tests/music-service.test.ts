import { describe, expect, it, vi } from 'vitest'
import { hasTrackLyricsSource, loadTrackLyrics } from '../services/lyrics'
import { loadConfiguredTracks, loadMusicConfig } from '../services/music'
import type { PublicMusicConfig } from '../types/music'
import type { MusicProviderAdapter } from '../services/music-adapters/types'

function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => window.setTimeout(resolve, 0))
}

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

  it('limits configured source loading concurrency while preserving result order and failures', async () => {
    const config: PublicMusicConfig = {
      siteName: 'test',
      apiEndpoint: 'https://custom.example.com/music',
      playlists: [
        { server: 'netease', playlistId: 'one' },
        { server: 'netease', playlistId: 'two' },
        { server: 'netease', playlistId: 'three' },
        { server: 'netease', playlistId: 'four' },
        { server: 'netease', playlistId: 'five' },
      ],
      localTracks: [],
    }
    const deferredLoads = config.playlists.map(() =>
      createDeferred<
        Awaited<ReturnType<MusicProviderAdapter<PublicMusicConfig['playlists'][number]>['load']>>
      >(),
    )
    let activeLoads = 0
    let maxActiveLoads = 0
    const adapter: MusicProviderAdapter<PublicMusicConfig['playlists'][number]> = {
      id: 'limited',
      load: vi.fn((playlist) => {
        const sourceIndex = config.playlists.indexOf(playlist)
        activeLoads += 1
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads)
        return deferredLoads[sourceIndex]!.promise.finally(() => {
          activeLoads -= 1
        })
      }),
    }

    const loading = loadConfiguredTracks(config, {
      adapters: {
        meting: adapter,
      },
    })
    await flushPromises()

    expect(adapter.load).toHaveBeenCalledTimes(3)
    expect(maxActiveLoads).toBe(3)

    deferredLoads[2]!.resolve([
      {
        id: 'track-three',
        title: 'Three',
        artist: 'Artist',
        audioUrl: '/three.mp3',
        kind: 'remote',
      },
    ])
    await flushPromises()

    expect(adapter.load).toHaveBeenCalledTimes(4)
    expect(maxActiveLoads).toBe(3)

    deferredLoads[0]!.resolve([
      {
        id: 'track-one',
        title: 'One',
        artist: 'Artist',
        audioUrl: '/one.mp3',
        kind: 'remote',
      },
    ])
    await flushPromises()

    expect(adapter.load).toHaveBeenCalledTimes(5)
    expect(maxActiveLoads).toBe(3)

    deferredLoads[1]!.reject(new Error('source failed'))
    deferredLoads[3]!.resolve([
      {
        id: 'track-four',
        title: 'Four',
        artist: 'Artist',
        audioUrl: '/four.mp3',
        kind: 'remote',
      },
    ])
    deferredLoads[4]!.resolve([
      {
        id: 'track-five',
        title: 'Five',
        artist: 'Artist',
        audioUrl: '/five.mp3',
        kind: 'remote',
      },
    ])

    const result = await loading

    expect(result.failedSources).toBe(1)
    expect(result.tracks.map((track) => track.id)).toEqual([
      'track-one',
      'track-three',
      'track-four',
      'track-five',
    ])
    expect(maxActiveLoads).toBe(3)
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
