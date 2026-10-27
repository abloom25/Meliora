import { describe, expect, it } from 'vitest'
import {
  createTrackShareId,
  deduplicateTracks,
  filterTracks,
  formatTrackDisplayTitle,
  mergeTrackShareAliases,
} from '../core/library/tracks'
import { mapMetingTrack } from '../services/music-adapters/track-mapping'
import type { Track } from '../core/types'

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

  it('refreshes cached search text when a track object is updated in place', () => {
    const mutableTrack: Track = {
      id: 'mutable',
      title: 'Original Title',
      artist: 'Artist',
      audioUrl: '/mutable.mp3',
      kind: 'local',
    }

    expect(filterTracks([mutableTrack], 'original')).toEqual([mutableTrack])

    mutableTrack.title = 'Updated Title'

    expect(filterTracks([mutableTrack], 'original')).toEqual([])
    expect(filterTracks([mutableTrack], 'updated')).toEqual([mutableTrack])
  })

  it('rejects incomplete Meting entries', () => {
    expect(mapMetingTrack({ title: 'Missing URL' }, 'source')).toBeNull()
    expect(mapMetingTrack({ title: 'Song', author: '', url: '/audio' }, 'source')).toMatchObject({
      title: 'Song',
      artist: '未知艺术家',
      kind: 'meting',
    })
  })

  it('lets providers split display title versions before tracks reach the player', () => {
    expect(
      mapMetingTrack({ title: 'Song Title (Live) (Remastered)', url: '/audio' }, 'source'),
    ).toMatchObject({
      title: 'Song Title',
      titleVersions: ['Live', 'Remastered'],
    })
  })

  it('keeps actual Meting IDs stable across playlist ordering and expiring media links', () => {
    const before = mapMetingTrack(
      { title: 'Song', url: 'https://old-api.test/music?server=netease&type=url&id=123&token=old' },
      'netease:first-playlist',
    )!
    const after = mapMetingTrack(
      {
        title: 'Updated title',
        url: 'https://new-api.test/music?server=netease&type=url&id=123&token=new',
      },
      'netease:second-playlist',
    )!
    expect(before.id).toBe('meting:v2:netease:song:123')
    expect(after.id).toBe(before.id)
    expect(after.audioUrl).not.toBe(before.audioUrl)
  })

  it('uses platform lyrics IDs for direct media links and separates different recordings', () => {
    const map = (id: string, index: number) =>
      mapMetingTrack(
        {
          title: 'Song',
          url: `https://cdn.test/${index}.mp3`,
          lrc: `https://api.test?server=tencent&type=lrc&id=${id}`,
        },
        'tencent:playlist',
      )!
    expect(map('qq-song', 1).id).toBe(map('qq-song', 7).id)
    expect(map('qq-song', 1).id).not.toBe(map('qq-live', 2).id)
    const audioWins = mapMetingTrack(
      {
        title: 'Live',
        url: '/music?server=tencent&type=url&id=live',
        lrc: '/music?server=tencent&type=lrc&id=studio',
      },
      'tencent:playlist',
    )!
    expect(audioWins.id).toBe('meting:v2:tencent:song:live')
  })

  it('uses the complete audio resource when no platform identity is available', () => {
    const map = (url: string) =>
      mapMetingTrack({ title: 'Same Song', author: 'Same Artist', url }, 'netease:playlist')!
    expect(map('/song.mp3?version=live').id).toBe(map('/song.mp3?version=live#play').id)
    expect(map('/song.mp3?version=live').id).not.toBe(map('/song.mp3?version=remix').id)
    expect(map('/song.mp3?token=old').id).not.toBe(map('/song.mp3?token=new').id)
  })

  it('creates short share ids without exposing media urls', () => {
    const track = mapMetingTrack(
      {
        title: 'Song',
        author: 'Singer',
        url: 'https://api.example.com/song/url?id=123&token=secret',
      },
      'netease:123',
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
