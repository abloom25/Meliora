import { afterEach, describe, expect, it, vi } from 'vitest'
import { testMusicApi } from '../core/music-api-tester'
import type { ConfigPayload } from '../core/types'
import { CONFIG_LIMITS } from '../../shared/constants'

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

  it('rejects malformed playlist payloads before issuing a fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const response = await testMusicApi({ ...CONFIG, playlists: 'not-an-array' })
    const data = (await response.json()) as { error?: string; details?: string[] }

    expect(response.status).toBe(400)
    expect(data.error).toBe('配置校验失败')
    expect(data.details).toContain('playlists 必须是数组')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects test payloads that exceed the per-request playlist limit', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const playlists = Array.from({ length: CONFIG_LIMITS.MAX_TEST_PLAYLISTS + 1 }, (_, index) => ({
      server: 'netease' as const,
      playlistId: String(index),
    }))

    const response = await testMusicApi({ ...CONFIG, playlists })
    const data = (await response.json()) as { details?: string[] }

    expect(response.status).toBe(400)
    expect(data.details).toContain(`playlists 最多允许 ${CONFIG_LIMITS.MAX_TEST_PLAYLISTS} 项`)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops before reading an oversized remote response body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('[]', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(CONFIG_LIMITS.MAX_TEST_RESPONSE_BYTES + 1),
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const response = await testMusicApi(CONFIG)
    const data = (await response.json()) as {
      ok: boolean
      playlists: Array<{ error?: string }>
    }

    expect(response.status).toBe(200)
    expect(data.ok).toBe(false)
    expect(data.playlists[0]?.error).toBe('响应数据过大')
  })
})
