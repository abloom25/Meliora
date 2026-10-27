import type { PlayMode, Track } from '../types'
import { normalizeTrackId } from '../library/track-id'

export const PLAYBACK_SESSION_KEY = 'meliora:playback-session:v1'
const MAX_QUEUE = 5000
const MAX_HISTORY = 500

export interface QueueJourney {
  history: string[]
  historyIndex: number
  remaining: string[]
  played: string[]
  priority: string[]
}

export interface PlaybackSession {
  version: 1
  queueIds: string[]
  customQueue: boolean
  currentTrackId: string | null
  audioUrl: string
  position: number
  journey: QueueJourney
}

export function emptyQueueJourney(): QueueJourney {
  return { history: [], historyIndex: -1, remaining: [], played: [], priority: [] }
}

/** Platform song IDs survive renewed CDN tokens; resource/local identities do not prove that. */
export function canResumePlayback(
  savedTrackId: string | null,
  savedSource: string,
  track: Pick<Track, 'id' | 'audioUrl'>,
): boolean {
  return (
    savedTrackId === track.id &&
    (savedSource === track.audioUrl || /^meting:v2:(?:netease|tencent):song:.+$/.test(track.id))
  )
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192
}

function ids(value: unknown, unique = true, limit = MAX_QUEUE): string[] {
  if (!Array.isArray(value)) return []
  const result = value
    .filter((item): item is string => typeof item === 'string' && item.length <= 8192)
    .slice(0, limit)
    .map(normalizeTrackId)
    .filter(validId)
  return unique ? [...new Set(result)] : result
}

export function sanitizePlaybackSession(value: unknown): PlaybackSession | null {
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1)
    return null
  const data = value as Partial<PlaybackSession>
  const queueIds = ids(data.queueIds)
  const allowed = new Set(queueIds)
  const normalizedCurrent =
    typeof data.currentTrackId === 'string' && data.currentTrackId.length <= 8192
      ? normalizeTrackId(data.currentTrackId)
      : null
  const currentTrackId =
    validId(normalizedCurrent) && allowed.has(normalizedCurrent) ? normalizedCurrent : null
  const raw = data.journey && typeof data.journey === 'object' ? data.journey : emptyQueueJourney()
  const rawHistory = ids(raw.history, false, MAX_HISTORY)
  const rawIndex = Number.isInteger(raw.historyIndex)
    ? Math.max(-1, Math.min(rawHistory.length - 1, raw.historyIndex))
    : rawHistory.length - 1
  const history = rawHistory.filter((id) => allowed.has(id))
  const historyIndex = rawHistory.slice(0, rawIndex + 1).filter((id) => allowed.has(id)).length - 1
  const position =
    typeof data.position === 'number' && Number.isFinite(data.position)
      ? Math.max(0, Math.min(7 * 24 * 60 * 60, data.position))
      : 0
  return {
    version: 1,
    queueIds,
    customQueue: data.customQueue === true,
    currentTrackId,
    audioUrl:
      typeof data.audioUrl === 'string' && data.audioUrl.length <= 8192 ? data.audioUrl : '',
    position: currentTrackId ? position : 0,
    journey: {
      history,
      historyIndex,
      remaining: ids(raw.remaining).filter((id) => allowed.has(id)),
      played: ids(raw.played).filter((id) => allowed.has(id)),
      priority: ids(raw.priority).filter((id) => allowed.has(id)),
    },
  }
}

/** A finite shuffle even when an injected random source repeatedly returns the same value. */
export function shuffledIds(values: readonly string[], random: () => number): string[] {
  const available = [...values]
  const shuffled: string[] = []
  while (available.length) {
    const sample = random()
    const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999999, sample)) : 0
    const index = Math.floor(normalized * available.length)
    shuffled.push(available[index]!)
    available[index] = available[available.length - 1]!
    available.pop()
  }
  return shuffled
}

/** Prepare once, then every consumer reads the same remaining round without drawing again. */
export function prepareQueueJourney(
  journey: QueueJourney,
  queueIds: readonly string[],
  currentId: string | null,
  random: () => number,
): QueueJourney {
  const allowed = new Set(queueIds)
  let played = journey.played.filter((id) => allowed.has(id))
  if (currentId && allowed.has(currentId) && !played.includes(currentId)) played.push(currentId)
  const playedSet = new Set(played)
  let remaining = journey.remaining.filter((id) => allowed.has(id) && !playedSet.has(id))
  const remainingSet = new Set(remaining)
  const missing = queueIds.filter((id) => !playedSet.has(id) && !remainingSet.has(id))
  remaining = [...remaining, ...shuffledIds(missing, random)]
  if (!remaining.length && queueIds.length > 1) {
    played = currentId ? [currentId] : []
    remaining = shuffledIds(
      queueIds.filter((id) => id !== currentId),
      random,
    )
  }
  return {
    ...journey,
    remaining,
    played,
    priority: journey.priority.filter((id) => allowed.has(id)),
  }
}

export function peekJourneyTrack(
  journey: QueueJourney,
  queueIds: readonly string[],
  currentId: string | null,
  mode: PlayMode,
  direction: 'next' | 'previous',
  manual: boolean,
  unavailable: (id: string) => boolean,
): string | null {
  if (!queueIds.length) return null
  const allowed = new Set(queueIds)
  const usable = (id: string) => allowed.has(id) && !unavailable(id)
  if (direction === 'next' && mode === 'single' && !manual && currentId)
    return usable(currentId) ? currentId : null
  if (direction === 'next') {
    const priority = journey.priority.find((id) => id !== currentId && usable(id))
    if (priority) return priority
  }
  const step = direction === 'next' ? 1 : -1
  const historyStart =
    direction === 'previous' && journey.history[journey.historyIndex] !== currentId
      ? journey.historyIndex
      : journey.historyIndex + step
  for (let index = historyStart; index >= 0 && index < journey.history.length; index += step) {
    const id = journey.history[index]!
    if (id !== currentId && usable(id)) return id
  }
  if (direction === 'next') {
    if (mode === 'shuffle') {
      if (queueIds.length === 1) return usable(queueIds[0]!) ? queueIds[0]! : null
      return journey.remaining.find((id) => id !== currentId && usable(id)) ?? null
    }
  } else if (journey.history.length > 1) return null
  const currentIndex = currentId ? queueIds.indexOf(currentId) : -1
  const base = currentIndex < 0 ? (step > 0 ? -1 : queueIds.length) : currentIndex
  for (let offset = 1; offset <= queueIds.length; offset += 1) {
    const raw = base + step * offset
    if (direction === 'next' && mode === 'sequence' && raw >= queueIds.length) return null
    const id = queueIds[((raw % queueIds.length) + queueIds.length) % queueIds.length]!
    if (usable(id)) return id
  }
  return null
}

export function visitQueueTrack(
  journey: QueueJourney,
  id: string,
  direction: 'next' | 'previous' | 'select',
): QueueJourney {
  let history = [...journey.history]
  let historyIndex = journey.historyIndex
  const target =
    direction === 'previous'
      ? historyIndex > 0
        ? history.lastIndexOf(id, historyIndex - 1)
        : -1
      : direction === 'next' && !journey.priority.includes(id)
        ? history.indexOf(id, historyIndex + 1)
        : -1
  if (target >= 0) historyIndex = target
  else if (history[historyIndex] !== id) {
    if (direction === 'previous') {
      history = [id, ...history].slice(0, MAX_HISTORY)
      historyIndex = 0
    } else {
      history = [...history.slice(0, historyIndex + 1), id].slice(-MAX_HISTORY)
      historyIndex = history.length - 1
    }
  }
  return {
    history,
    historyIndex,
    remaining: journey.remaining.filter((item) => item !== id),
    played: journey.played.includes(id) ? [...journey.played] : [...journey.played, id],
    priority: journey.priority.filter((item) => item !== id),
  }
}
