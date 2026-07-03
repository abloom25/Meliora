import { afterEach, describe, expect, it, vi } from 'vitest'
import { testMusicApi } from '../core/music-api-tester'
import type { ConfigPayload } from '../core/types'

const CONFIG: ConfigPayload = {
  siteName: 'Meliora',
  apiEndpoint: 'https://music-api.example.com/playlist',
  playlists: [{ server: 'netease', playlistId: '123' }],
  localTracks: [],
}

describe('music api tester', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not follow redirects while testing a configured music API', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'http://169.254.169.254/latest/meta-data' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await testMusicApi(CONFIG)
    const data = (await response.json()) as {
      ok: boolean
      playlists: Array<{ ok: boolean; status?: number; error?: string }>
    }

    expect(response.status).toBe(200)
    expect(data.ok).toBe(false)
    expect(data.playlists[0]).toMatchObject({
      ok: false,
      status: 302,
      error: '重定向已拒绝',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://music-api.example.com/playlist?server=netease&type=playlist&id=123',
      expect.objectContaining({ redirect: 'manual' }),
    )
  })
})
