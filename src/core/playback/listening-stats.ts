import type { Track } from '../types'

export const LISTENING_HISTORY_LIMIT = 500
export interface ListeningRecord {
  key: string
  title: string
  artist: string
  qualifiedPlays: number
  listenedSeconds: number
  lastPlayedAt: number
}
export interface ListeningSample {
  timeSeconds: number
  durationSeconds: number
  playing: boolean
  seeking: boolean
  playbackRate: number
  nowMs: number
}

/** Source IDs, never display names, identify listening history. Audio content is verified separately. */
export function listeningTrackKey(track: Pick<Track, 'id' | 'kind'>): string {
  return JSON.stringify([track.kind, track.id])
}

export function isFrequentlyPlayed(record: ListeningRecord | undefined): boolean {
  return !!record && record.qualifiedPlays >= 2 && record.listenedSeconds > 0
}

export function sanitizeListeningRecords(value: unknown): ListeningRecord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value
    .filter((item): item is ListeningRecord => {
      if (!item || typeof item !== 'object') return false
      const r = item as Partial<ListeningRecord>
      if (
        typeof r.key !== 'string' ||
        r.key.length > 4096 ||
        seen.has(r.key) ||
        typeof r.title !== 'string' ||
        r.title.length > 512 ||
        typeof r.artist !== 'string' ||
        r.artist.length > 512 ||
        !Number.isSafeInteger(r.qualifiedPlays) ||
        r.qualifiedPlays! < 0 ||
        !Number.isFinite(r.listenedSeconds) ||
        r.listenedSeconds! < 0 ||
        !Number.isFinite(r.lastPlayedAt) ||
        r.lastPlayedAt! < 0
      )
        return false
      seen.add(r.key)
      return true
    })
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
    .slice(0, LISTENING_HISTORY_LIMIT)
}

/** One visit can qualify once. Pauses/seeks do not create a new visit. */
export function createListeningCounter() {
  let previous: ListeningSample | undefined
  let seconds = 0
  let qualified = false
  return {
    reset(): void {
      previous = undefined
      seconds = 0
      qualified = false
    },
    sample(next: ListeningSample): { seconds: number; qualified: boolean } {
      const before = previous
      previous = next
      let added = 0
      if (
        before &&
        before.playing &&
        !before.seeking &&
        !next.seeking &&
        Number.isFinite(next.timeSeconds) &&
        Number.isFinite(before.timeSeconds) &&
        Number.isFinite(before.playbackRate) &&
        before.playbackRate > 0
      ) {
        const wall = (next.nowMs - before.nowMs) / 1000
        const media = next.timeSeconds - before.timeSeconds
        // Reject jumps, stalled clocks and suspended-page gaps. A seek cannot buy a play.
        if (wall > 0 && wall <= 10 && media > 0 && media <= wall * before.playbackRate + 0.35)
          added = Math.min(wall, media / before.playbackRate)
      }
      seconds += added
      const threshold = Math.min(30, next.durationSeconds / 2)
      const earned =
        !qualified &&
        added > 0 &&
        Number.isFinite(threshold) &&
        threshold > 0 &&
        seconds + 1e-6 >= threshold
      if (earned) qualified = true
      return { seconds: added, qualified: earned }
    },
  }
}
