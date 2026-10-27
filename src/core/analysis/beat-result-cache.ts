import { validateBeatCheckpoint, type BeatAnalysisCheckpoint } from './beat-checkpoint'
import { beatThisWindows } from './beat-this-prediction'
import { BEAT_THIS_FPS } from './beat-this-features'
export const BEAT_RESULT_VERSION = 'rolling-v4'
export const BEAT_RESULT_MAX_BYTES = 32 * 1024 * 1024
export const BEAT_RESULT_MAX_ENTRIES = 128
export const BEAT_RESULT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
export interface BeatResultMetadata {
  key: string
  track: string
  bytes: number
  updatedAt: number
  pinned?: boolean
  version?: string
}
export interface BeatResultStore {
  readonly generation: number
  get(key: string): Promise<BeatAnalysisCheckpoint | null>
  set(
    key: string,
    track: string,
    checkpoint: BeatAnalysisCheckpoint,
    generation: number,
  ): Promise<void>
  clear(): Promise<void>
  refresh(): Promise<void>
}

export function validPersistentCheckpoint(value: unknown): value is BeatAnalysisCheckpoint {
  try {
    const checkpoint = value as BeatAnalysisCheckpoint
    const signature = checkpoint.signature
    if (
      !Number.isFinite(signature.sampleRate) ||
      signature.sampleRate < 8000 ||
      signature.sampleRate > 192000 ||
      !Number.isInteger(signature.sampleCount) ||
      signature.sampleCount <= 0 ||
      signature.sampleCount > signature.sampleRate * 600 ||
      !Number.isInteger(signature.channels) ||
      signature.channels < 1 ||
      signature.channels > 8 ||
      !['basic', 'small', 'standard'].includes(signature.modelId)
    )
      return false
    const duration = signature.sampleCount / signature.sampleRate
    const windows =
      signature.modelId === 'basic'
        ? Math.ceil(duration / 10)
        : beatThisWindows(Math.floor(duration * BEAT_THIS_FPS) + 1, duration).length
    validateBeatCheckpoint(checkpoint, signature, windows)
    return true
  } catch {
    return false
  }
}

export function selectBeatCacheEvictions(
  entries: readonly BeatResultMetadata[],
  now: number,
  maxBytes = BEAT_RESULT_MAX_BYTES,
  maxEntries = BEAT_RESULT_MAX_ENTRIES,
): string[] {
  const newest = [...entries].sort(
    (a, b) =>
      Number(b.pinned === true) - Number(a.pinned === true) ||
      b.updatedAt - a.updatedAt ||
      a.key.localeCompare(b.key),
  )
  let bytes = 0
  let count = 0
  return newest
    .filter((entry) => {
      if (
        !Number.isFinite(entry.bytes) ||
        entry.bytes <= 0 ||
        !Number.isFinite(entry.updatedAt) ||
        (entry.version !== undefined && entry.version !== BEAT_RESULT_VERSION) ||
        entry.updatedAt < now - BEAT_RESULT_MAX_AGE_MS ||
        entry.updatedAt > now + 60_000 ||
        bytes + entry.bytes > maxBytes ||
        count >= maxEntries
      )
        return true
      bytes += entry.bytes
      count += 1
      return false
    })
    .map((entry) => entry.key)
}

/** User limits remain bounded even when persisted settings are malformed. */
export function normalizeBeatCacheBudget(bytes: unknown): number {
  return typeof bytes === 'number' && Number.isFinite(bytes)
    ? Math.round(Math.min(128, Math.max(8, bytes / 1024 / 1024))) * 1024 * 1024
    : BEAT_RESULT_MAX_BYTES
}

export function groupBeatCacheEntries(entries: readonly BeatResultMetadata[]): Array<{
  track: string
  bytes: number
  pinned: boolean
  variants: number
  updatedAt: number
}> {
  const tracks = new Map<
    string,
    { track: string; bytes: number; pinned: boolean; variants: number; updatedAt: number }
  >()
  for (const entry of entries) {
    const group = tracks.get(entry.track) ?? {
      track: entry.track,
      bytes: 0,
      pinned: false,
      variants: 0,
      updatedAt: 0,
    }
    group.bytes += entry.bytes
    group.variants += 1
    group.pinned ||= entry.pinned === true
    group.updatedAt = Math.max(group.updatedAt, entry.updatedAt)
    tracks.set(entry.track, group)
  }
  return [...tracks.values()].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
  )
}
