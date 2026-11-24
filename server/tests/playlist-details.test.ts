import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPlaylistDetails } from '../core/playlist-handler'

const request = (query: string) => new Request('https://meliora.test/api/playlist?' + query)
afterEach(() => vi.unstubAllGlobals())

describe('public playlist details', () => {
  it.each([
    [
      'netease',
      { code: 200, playlist: { name: '夜航', coverImgUrl: 'http://p1.music.126.net/1.jpg' } },
      'https://p1.music.126.net/1.jpg',
    ],
    [
      'tencent',
      { code: 0, cdlist: [{ dissname: '夜航', logo: 'https://y.gtimg.cn/2.jpg' }] },
      'https://y.gtimg.cn/2.jpg',
    ],
  ] as const)(
    'reads and caches %s playlist artwork independently of its tracks',
    async (platform, payload, cover) => {
      const fetch = vi.fn().mockResolvedValue(Response.json(payload))
      vi.stubGlobal('fetch', fetch)
      const query = 'server=' + platform + '&id=98765'
      for (let i = 0; i < 2; i++) {
        const result = await getPlaylistDetails(request(query))
        expect(await result.json()).toEqual({ name: '夜航', cover })
      }
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects an unrecognized provider or ID before contacting a platform', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const query of ['server=other&id=1', 'server=netease&id=abc']) {
      expect((await getPlaylistDetails(request(query))).status).toBe(400)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})
