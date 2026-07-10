import { describe, expect, it } from 'vitest'
import { buildMetingPlaylistUrl } from '../services/music-adapters/meting'

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
