import type { Track } from '../types'
import {
  listeningTrackKey,
  normalizeListeningKey,
  type ListeningRecord,
} from '../playback/listening-stats'

export type LibraryView = 'all' | 'queue' | 'recent' | 'frequent' | 'favorites'

export const LIBRARY_VIEWS: readonly { value: LibraryView; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'queue', label: '队列' },
  { value: 'recent', label: '最近' },
  { value: 'frequent', label: '常听' },
  { value: 'favorites', label: '收藏' },
]

export function sanitizeFavoriteKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((key): key is string => {
          if (typeof key !== 'string' || key.length > 16_384) return false
          try {
            const pair: unknown = JSON.parse(key)
            return (
              Array.isArray(pair) &&
              pair.length === 2 &&
              ['local', 'remote', 'meting'].includes(pair[0]) &&
              typeof pair[1] === 'string' &&
              pair[1].length > 0
            )
          } catch {
            return false
          }
        })
        .map(normalizeListeningKey),
    ),
  ].slice(0, 5000)
}

/** Personal lists reference stable source IDs; a refreshed URL or duplicate title is not a new song. */
export function selectLibraryTracks(
  tracks: readonly Track[],
  queue: readonly Track[],
  records: readonly ListeningRecord[],
  favorites: ReadonlySet<string>,
  view: LibraryView,
): Track[] {
  if (view === 'queue') return [...queue]
  if (view === 'favorites') return tracks.filter((track) => favorites.has(listeningTrackKey(track)))
  if (view === 'all') return [...tracks]
  const byKey = new Map(tracks.map((track) => [listeningTrackKey(track), track]))
  const eligible = records.filter((record) => byKey.has(record.key) && record.listenedSeconds > 0)
  eligible.sort(
    view === 'recent'
      ? (a, b) => b.lastPlayedAt - a.lastPlayedAt
      : (a, b) =>
          b.qualifiedPlays - a.qualifiedPlays ||
          b.listenedSeconds - a.listenedSeconds ||
          b.lastPlayedAt - a.lastPlayedAt,
  )
  return eligible
    .filter((record) => view !== 'frequent' || record.qualifiedPlays > 0)
    .map((record) => byKey.get(record.key)!)
}
