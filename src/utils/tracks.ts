import type { LocalTrackConfig, MetingTrack, Track } from '../types/music'

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')

export function trackIdentity(track: Pick<Track, 'title' | 'artist'>): string {
  return `${normalize(track.title)}::${normalize(track.artist)}`
}

function hashShareIdentity(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function createTrackShareId(track: Pick<Track, 'title' | 'artist'>): string {
  return hashShareIdentity(trackIdentity(track))
}

export function deduplicateTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>()
  return tracks.filter((track) => {
    const identity = trackIdentity(track)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

export function filterTracks(tracks: Track[], query: string): Track[] {
  const keyword = normalize(query)
  if (!keyword) return tracks
  return tracks.filter(
    (track) =>
      normalize(track.title).includes(keyword) || normalize(track.artist).includes(keyword),
  )
}

export function mapMetingTrack(track: MetingTrack, sourceKey: string, index: number): Track | null {
  if (!track.title?.trim() || !track.url?.trim()) return null
  return {
    id: `meting:${sourceKey}:${index}:${track.url}`,
    title: track.title.trim(),
    artist: track.author?.trim() || '未知艺术家',
    cover: track.pic?.trim() || undefined,
    audioUrl: track.url.trim(),
    lyricsUrl: track.lrc?.trim() || undefined,
    kind: 'meting',
  }
}

export function mapLocalTrack(track: LocalTrackConfig): Track {
  return {
    id: `local:${track.id}`,
    title: track.title,
    artist: track.artist,
    album: track.album,
    cover: track.cover,
    audioUrl: track.audio,
    lyricsUrl: track.lyrics,
    kind: 'local',
  }
}
