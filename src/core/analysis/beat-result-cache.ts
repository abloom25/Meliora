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
    (a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key),
  )
  let bytes = 0
  let count = 0
  return newest
    .filter((entry) => {
      if (
        !Number.isFinite(entry.bytes) ||
        entry.bytes <= 0 ||
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
