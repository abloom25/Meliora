import { describe, expect, it } from 'vitest'
import {
  createTrackShareId,
  deduplicateTracks,
  filterTracks,
  formatTrackDisplayTitle,
  mapMetingTrack,
  mergeTrackShareAliases,
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

  it('keeps title versions in track identity so variants are not collapsed', () => {
    const variants: Track[] = [
      {
        id: 'live',
        title: 'Song',
        titleVersions: ['Live'],
        artist: 'Artist',
        audioUrl: '/live.mp3',
        kind: 'meting',
      },
      {
        id: 'remix',
        title: 'Song',
        titleVersions: ['Remix'],
        artist: 'Artist',
        audioUrl: '/remix.mp3',
        kind: 'meting',
      },
    ]

    expect(deduplicateTracks(variants).map((track) => track.id)).toEqual(['live', 'remix'])
    expect(createTrackShareId(variants[0]!)).not.toBe(createTrackShareId(variants[1]!))
  })

  it('formats provider-split title versions for display-only consumers', () => {
    expect(
      formatTrackDisplayTitle({
        title: 'Song',
        titleVersions: ['Live', 'Remastered'],
        artist: 'Artist',
      }),
    ).toBe('Song (Live) (Remastered)')
  })

  it('merges legacy share aliases from dropped duplicates', () => {
    const kept: Track = {
      id: 'kept',
      title: 'Song',
      titleVersions: ['Live'],
      shareAliases: ['old-kept'],
      artist: 'Artist',
      audioUrl: '/kept.mp3',
      kind: 'meting',
    }
    const duplicate: Track = {
      ...kept,
      id: 'duplicate',
      shareAliases: ['old-duplicate', createTrackShareId(kept)],
      audioUrl: '/duplicate.mp3',
    }

    mergeTrackShareAliases(kept, duplicate)

    expect(kept.shareAliases).toEqual(['old-kept', 'old-duplicate'])
  })

  it('filters loaded tracks by title or artist', () => {
    expect(filterTracks(tracks, 'neon').map((track) => track.id)).toEqual(['2'])
    expect(filterTracks(tracks, 'ABLOOM').map((track) => track.id)).toEqual(['1'])
    expect(filterTracks(tracks, '')).toBe(tracks)
  })

  it('filters loaded tracks by provider-split title versions', () => {
    const variant: Track = {
      id: '3',
      title: 'Song',
      titleVersions: ['Acoustic Version'],
      artist: 'Artist',
      audioUrl: '/three.mp3',
      kind: 'meting',
    }

    expect(filterTracks([...tracks, variant], 'acoustic').map((track) => track.id)).toEqual(['3'])
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

  it('lets providers split display title versions before tracks reach the player', () => {
    expect(
      mapMetingTrack({ title: 'Song Title (Live) (Remastered)', url: '/audio' }, 'source', 0),
    ).toMatchObject({
      title: 'Song Title',
      titleVersions: ['Live', 'Remastered'],
    })
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
