import type { LyricLine, Track } from '../types'

export const MAX_SHARED_LYRIC_LINES = 6

/** Keep card metadata stable while its asynchronous render is pending. */
export interface LyricShareSelection {
  track: Track
  lines: LyricLine[]
  index: number
}

export function selectedShareLines(
  lines: readonly LyricLine[],
  indices: readonly number[],
): LyricLine[] {
  return [...new Set(indices)]
    .filter((index) => Number.isInteger(index) && index >= 0 && lines[index]?.text.trim())
    .sort((a, b) => a - b)
    .slice(0, MAX_SHARED_LYRIC_LINES)
    .map((index) => lines[index]!)
}

export function lyricShareTime(lines: readonly LyricLine[]): number | undefined {
  const time = lines[0]?.time
  return typeof time === 'number' && Number.isFinite(time) ? Math.max(0, time) : undefined
}

export function lyricShareTimeLabel(time: number | undefined): string | undefined {
  if (time === undefined || !Number.isFinite(time) || time < 0) return undefined
  const seconds = Math.floor(time)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
