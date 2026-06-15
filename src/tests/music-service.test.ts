import { afterEach, describe, expect, it, vi } from 'vitest'
import { musicConfig } from '../config/music'
import { loadConfiguredTracks } from '../services/music'

describe('music service', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    musicConfig.playlists = [{ server: 'netease', playlistId: '17390341309', enabled: true }]
    musicConfig.localTracks = []
  })

  it('keeps successful sources and local tracks when one source fails', async () => {
    musicConfig.playlists = [
      { server: 'netease', playlistId: 'one' },
      { server: 'tencent', playlistId: 'two' },
    ]
    musicConfig.localTracks = [
      { id: 'local', title: 'Local Song', artist: 'Artist', audio: '/music/local.mp3' },
    ]
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { title: 'Remote Song', author: 'Singer', url: '/remote.mp3' },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response('failed', { status: 500 })))

    const result = await loadConfiguredTracks()
    expect(result.failedSources).toBe(1)
    expect(result.tracks.map((track) => track.title)).toEqual(['Remote Song', 'Local Song'])
  })
})
