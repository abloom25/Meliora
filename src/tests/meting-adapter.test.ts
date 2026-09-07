import { describe, expect, it } from 'vitest'
import { buildMetingPlaylistUrl, extractMetingTrackId } from '../services/music-adapters/meting'

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

describe('extractMetingTrackId', () => {
  it('reads the platform song id back out of an absolute resource url', () => {
    expect(
      extractMetingTrackId('https://api.example.com/meting?server=netease&type=lrc&id=1974443814'),
    ).toBe('1974443814')
  })

  it('handles relative endpoints and QQ song mids', () => {
    expect(extractMetingTrackId('/api/meting?server=tencent&type=url&id=004d5o8E19OLXw')).toBe(
      '004d5o8E19OLXw',
    )
  })

  it('returns null when there is no id to work with', () => {
    // 拿不到 ID 时逐字歌词库无法寻址,调用方退化为纯 LRC 加载
    expect(extractMetingTrackId('https://cdn.example.com/song.lrc')).toBeNull()
    expect(extractMetingTrackId('?id=')).toBeNull()
    expect(extractMetingTrackId('')).toBeNull()
  })
})
