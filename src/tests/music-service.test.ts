import { describe, expect, it, vi } from 'vitest'
import { loadConfiguredTracks } from '../services/music'
import type { MusicConfig } from '../types/music'

describe('music service', () => {
  it('keeps successful sources and local tracks when one source fails', async () => {
    const config: MusicConfig = {
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
  })
})
