import type { LocalTrackConfig, MetingTrack, Track } from '../types/music'
import { splitDisplayTitle } from './title'

const normalize = (value: string) => value.trim().toLocaleLowerCase().replace(/\s+/g, ' ')

type TrackIdentityInput = Pick<Track, 'title' | 'artist' | 'titleVersions'>
type TrackSearchInput = Pick<Track, 'title' | 'artist' | 'titleVersions'>

const searchTextCache = new WeakMap<TrackSearchInput, { signature: string; text: string }>()

function searchSignature(track: TrackSearchInput): string {
  return [track.title, track.artist, ...(track.titleVersions ?? [])].join('\u0000')
}

export function createTrackSearchText(track: TrackSearchInput): string {
  const signature = searchSignature(track)
  const cached = searchTextCache.get(track)
  if (cached?.signature === signature) return cached.text
  const text = [track.title, track.artist, ...(track.titleVersions ?? [])]
    .map(normalize)
    .filter(Boolean)
    .join(' ')
  searchTextCache.set(track, { signature, text })
  return text
}

function normalizedTitleParts(track: TrackIdentityInput): string {
  return [track.title, ...(track.titleVersions ?? [])].map(normalize).filter(Boolean).join('::')
}

export function trackIdentity(track: TrackIdentityInput): string {
  return `${normalizedTitleParts(track)}::${normalize(track.artist)}`
}

function hashShareIdentity(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function createTrackShareId(track: TrackIdentityInput): string {
  return hashShareIdentity(trackIdentity(track))
}

export function formatTrackDisplayTitle(track: TrackIdentityInput): string {
  return [track.title, ...(track.titleVersions ?? []).map((version) => `(${version})`)].join(' ')
}

export function trackMatchesShareId(track: Track, shareId: string): boolean {
  return createTrackShareId(track) === shareId || Boolean(track.shareAliases?.includes(shareId))
}

export function mergeTrackShareAliases(target: Track, source: Track) {
  const aliases = new Set([...(target.shareAliases ?? []), ...(source.shareAliases ?? [])])
  aliases.delete(createTrackShareId(target))
  if (aliases.size) {
    target.shareAliases = [...aliases]
  } else {
    delete target.shareAliases
  }
}

export function deduplicateTracks(
  tracks: Track[],
  mergeDuplicate?: (kept: Track, duplicate: Track) => void,
): Track[] {
  const seen = new Map<string, Track>()
  return tracks.filter((track) => {
    const identity = trackIdentity(track)
    const kept = seen.get(identity)
    if (kept) {
      mergeDuplicate?.(kept, track)
      return false
    }
    seen.set(identity, track)
    return true
  })
}

export function filterTracks(tracks: Track[], query: string): Track[] {
  const keyword = normalize(query)
  if (!keyword) return tracks
  return tracks.filter((track) => createTrackSearchText(track).includes(keyword))
}

export function mapMetingTrack(track: MetingTrack, sourceKey: string, index: number): Track | null {
  if (!track.title?.trim() || !track.url?.trim()) return null
  const rawTitle = track.title.trim()
  const displayTitle = splitDisplayTitle(track.title)
  const mapped: Track = {
    id: `meting:${sourceKey}:${index}:${track.url}`,
    title: displayTitle.title,
    titleVersions: displayTitle.versions.length ? displayTitle.versions : undefined,
    artist: track.author?.trim() || '未知艺术家',
    cover: track.pic?.trim() || undefined,
    audioUrl: track.url.trim(),
    kind: 'meting',
  }
  const legacyShareId = createTrackShareId({
    title: rawTitle,
    artist: mapped.artist,
  })
  if (legacyShareId !== createTrackShareId(mapped)) mapped.shareAliases = [legacyShareId]
  return mapped
}

export function mapLocalTrack(track: LocalTrackConfig): Track {
  const rawTitle = track.title.trim()
  const displayTitle = splitDisplayTitle(track.title)
  const mapped: Track = {
    id: `local:${track.id}`,
    title: displayTitle.title,
    titleVersions: displayTitle.versions.length ? displayTitle.versions : undefined,
    artist: track.artist,
    album: track.album,
    cover: track.cover,
    audioUrl: track.audio,
    kind: 'local',
  }
  const legacyShareId = createTrackShareId({
    title: rawTitle,
    artist: mapped.artist,
  })
  if (legacyShareId !== createTrackShareId(mapped)) mapped.shareAliases = [legacyShareId]
  return mapped
}
