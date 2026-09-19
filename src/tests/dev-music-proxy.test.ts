import { describe, expect, it } from 'vitest'
import { resolveDevMusicUrl } from '../../shared/dev-music-proxy'

const endpoint = 'https://music.example/api'

describe('development music proxy', () => {
  it.each(['playlist', 'url', 'lrc', 'pic'])(
    'proxies %s requests to the configured API',
    (type) => {
      const query = `?server=netease&type=${type}&id=123`
      expect(resolveDevMusicUrl(`${endpoint}${query}`, endpoint, true)).toBe(
        `/__meliora-dev/music/api${query}`,
      )
    },
  )

  it('preserves production URLs and third-party resources', () => {
    expect(resolveDevMusicUrl(endpoint, endpoint, false)).toBe(endpoint)
    for (const url of ['https://cdn.example/cover.jpg', 'https://music.example/other']) {
      expect(resolveDevMusicUrl(url, endpoint, true)).toBe(url)
    }
  })

  it('resolves relative API resources and keeps invalid or local configurations unchanged', () => {
    expect(resolveDevMusicUrl('/api?type=lrc&id=123', endpoint, true)).toBe(
      '/__meliora-dev/music/api?type=lrc&id=123',
    )
    expect(resolveDevMusicUrl('/music/song.mp3', '/api', true)).toBe('/music/song.mp3')
    expect(resolveDevMusicUrl('https://[invalid', endpoint, true)).toBe('https://[invalid')
  })
})
