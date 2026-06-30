import { describe, expect, it, vi } from 'vitest'
import { loadConfiguredTracks, loadMusicConfig } from '../services/music'
import type { PublicMusicConfig } from '../types/music'

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
})
