import { describe, expect, it } from 'vitest'
import {
  createTrackShareId,
  deduplicateTracks,
  filterTracks,
  mapMetingTrack,
} from '../utils/tracks'
import type { Track } from '../types/music'

const tracks: Track[] = [
  {
    id: '1',
    title: 'Echoes in the Sky',
    artist: 'ABloom',
    audioUrl: '/one.mp3',
    kind: 'local',
  },
  {
    id: '2',
    title: 'Neon Mirage',
    artist: 'Night Drive',
    audioUrl: '/two.mp3',
    kind: 'local',
  },
]

describe('track utilities', () => {
  it('deduplicates normalized title and artist while preserving first occurrence', () => {
    const duplicate: Track = {
      ...tracks[0]!,
      id: '3',
      title: ' ECHOES  IN THE SKY ',
      artist: 'abloom',
    }
    expect(deduplicateTracks([...tracks, duplicate]).map((track) => track.id)).toEqual(['1', '2'])
  })

  it('filters loaded tracks by title or artist', () => {
    expect(filterTracks(tracks, 'neon').map((track) => track.id)).toEqual(['2'])
    expect(filterTracks(tracks, 'ABLOOM').map((track) => track.id)).toEqual(['1'])
    expect(filterTracks(tracks, '')).toBe(tracks)
  })

  it('rejects incomplete Meting entries', () => {
    expect(mapMetingTrack({ title: 'Missing URL' }, 'source', 0)).toBeNull()
    expect(mapMetingTrack({ title: 'Song', author: '', url: '/audio' }, 'source', 1)).toMatchObject(
      {
        title: 'Song',
        artist: '未知艺术家',
        kind: 'meting',
      },
    )
  })

  it('creates short share ids without exposing media urls', () => {
    const track = mapMetingTrack(
      {
        title: 'Song',
        author: 'Singer',
        url: 'https://api.example.com/song/url?id=123&token=secret',
      },
      'netease:123',
      0,
    )

    expect(track).not.toBeNull()
    const shareId = createTrackShareId(track!)

    expect(shareId).toMatch(/^[a-z0-9]+$/)
    expect(shareId).not.toContain('api.example.com')
    expect(shareId).not.toContain('secret')
    expect(shareId.length).toBeLessThan(16)
  })

  it('does not treat internal track ids as share ids', () => {
    const track = {
      ...tracks[0]!,
      id: 'meting:netease:123:0:https://api.example.com/song/url?id=123',
      kind: 'meting' as const,
    }

    expect(createTrackShareId(track)).not.toBe(track.id)
  })
})
