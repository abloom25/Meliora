import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  deduplicateTracks,
  filterTracks,
  trackIdentity,
  mapMetingTrack,
  mapLocalTrack,
} from '../../utils/tracks'
import type { LocalTrackConfig } from '../../types/music'
import { trackArb, collidingTrackArb, metingTrackArb } from './_arbitraries'

describe('trackIdentity', () => {
  it('对大小写、首尾空白与多余空白不敏感（归一化幂等）', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (title, artist) => {
        const a = trackIdentity({ title, artist })
        const b = trackIdentity({
          title: `  ${title.toUpperCase()}  `,
          artist: `  ${artist.toUpperCase()}  `,
        })
        expect(trackIdentity({ title: title.toLocaleLowerCase(), artist: artist.toLocaleLowerCase() })).toBe(a)
        expect(typeof b).toBe('string')
      }),
    )
  })
})

describe('deduplicateTracks 属性', () => {
  it('幂等：dedup(dedup(x)) 等价 dedup(x)', () => {
    fc.assert(
      fc.property(fc.array(collidingTrackArb), (tracks) => {
        const once = deduplicateTracks(tracks)
        expect(deduplicateTracks(once)).toEqual(once)
      }),
    )
  })

  it('输出内 identity 两两唯一', () => {
    fc.assert(
      fc.property(fc.array(collidingTrackArb), (tracks) => {
        const out = deduplicateTracks(tracks)
        const ids = out.map(trackIdentity)
        expect(new Set(ids).size).toBe(ids.length)
      }),
    )
  })

  it('长度不超过输入，且保留每个 identity 的首次出现', () => {
    fc.assert(
      fc.property(fc.array(collidingTrackArb), (tracks) => {
        const out = deduplicateTracks(tracks)
        expect(out.length).toBeLessThanOrEqual(tracks.length)
        const firstSeen = new Map<string, (typeof tracks)[number]>()
        for (const t of tracks) {
          const id = trackIdentity(t)
          if (!firstSeen.has(id)) firstSeen.set(id, t)
        }
        expect(out).toEqual([...firstSeen.values()])
      }),
    )
  })
})

describe('filterTracks 属性', () => {
  it('空白 query 原样返回同一引用', () => {
    fc.assert(
      fc.property(fc.array(trackArb), (tracks) => {
        expect(filterTracks(tracks, '   ')).toBe(tracks)
        expect(filterTracks(tracks, '')).toBe(tracks)
      }),
    )
  })

  it('结果恒为输入子集', () => {
    fc.assert(
      fc.property(fc.array(trackArb), fc.string(), (tracks, q) => {
        const out = filterTracks(tracks, q)
        out.forEach((t) => expect(tracks).toContain(t))
      }),
    )
  })

  it('查询对大小写/多空格归一后结果一致', () => {
    fc.assert(
      fc.property(fc.array(trackArb), fc.string({ minLength: 1 }), (tracks, q) => {
        const a = filterTracks(tracks, q)
        const b = filterTracks(tracks, `  ${q.toUpperCase()}  `)
        expect(b).toEqual(a)
      }),
    )
  })
})

describe('mapMetingTrack 分支', () => {
  it('title 或 url 为空时返回 null', () => {
    expect(mapMetingTrack({ title: '', url: 'https://x/y.mp3' }, 'k', 0)).toBeNull()
    expect(mapMetingTrack({ title: 'a', url: '' }, 'k', 0)).toBeNull()
    expect(mapMetingTrack({ title: '   ', url: '  ' }, 'k', 0)).toBeNull()
  })

  it('缺省 author 回落为「未知艺术家」，可选字段缺省为 undefined', () => {
    const t = mapMetingTrack({ title: '  Song  ', url: '  https://x/y.mp3  ' }, 'src', 3)!
    expect(t).not.toBeNull()
    expect(t.title).toBe('Song')
    expect(t.artist).toBe('未知艺术家')
    expect(t.cover).toBeUndefined()
    expect(t.lyricsUrl).toBeUndefined()
    expect(t.kind).toBe('meting')
    expect(t.id).toBe('meting:src:3:https://x/y.mp3')
  })

  it('提供 author/pic/lrc 时被正确 trim 与映射', () => {
    const t = mapMetingTrack(
      { title: 'S', author: '  A  ', pic: ' p ', url: 'u://a', lrc: ' l://b ' },
      'k',
      1,
    )!
    expect(t.artist).toBe('A')
    expect(t.cover).toBe('p')
    expect(t.lyricsUrl).toBe('l://b')
  })

  it('随机 MetingTrack：返回 null 或字段合法的 Track', () => {
    fc.assert(
      fc.property(metingTrackArb, fc.string(), fc.nat(), (m, key, idx) => {
        const t = mapMetingTrack(m, key, idx)
        if (t === null) {
          expect(!m.title?.trim() || !m.url?.trim()).toBe(true)
        } else {
          expect(t.title.length).toBeGreaterThan(0)
          expect(t.audioUrl.length).toBeGreaterThan(0)
          expect(t.artist.length).toBeGreaterThan(0)
          expect(t.kind).toBe('meting')
        }
      }),
    )
  })
})

describe('mapLocalTrack', () => {
  it('id 加 local: 前缀，字段透传', () => {
    const cfg: LocalTrackConfig = {
      id: 'x1',
      title: 'T',
      artist: 'AR',
      audio: 'a://x',
      album: 'AL',
      cover: 'c://y',
      lyrics: 'l://z',
    }
    const t = mapLocalTrack(cfg)
    expect(t.id).toBe('local:x1')
    expect(t.audioUrl).toBe('a://x')
    expect(t.lyricsUrl).toBe('l://z')
    expect(t.kind).toBe('local')
  })
})
