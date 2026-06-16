import { describe, expect, it } from 'vitest'
import { deduplicateTracks, filterTracks, mapMetingTrack } from '../utils/tracks'
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
    const duplicate: Track = { ...tracks[0]!, id: '3', title: ' ECHOES  IN THE SKY ', artist: 'abloom' }
    expect(deduplicateTracks([...tracks, duplicate]).map((track) => track.id)).toEqual(['1', '2'])
  })

  it('filters loaded tracks by title or artist', () => {
    expect(filterTracks(tracks, 'neon').map((track) => track.id)).toEqual(['2'])
    expect(filterTracks(tracks, 'ABLOOM').map((track) => track.id)).toEqual(['1'])
    expect(filterTracks(tracks, '')).toBe(tracks)
  })

  it('rejects incomplete Meting entries', () => {
    expect(mapMetingTrack({ title: 'Missing URL' }, 'source', 0)).toBeNull()
    expect(mapMetingTrack({ title: 'Song', author: '', url: '/audio' }, 'source', 1)).toMatchObject({
      title: 'Song',
      artist: '未知艺术家',
      kind: 'meting',
    })
  })
})
