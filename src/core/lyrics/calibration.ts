import type { LyricLine, LyricProviderSource } from '../types'

export interface LyricCalibrationContext {
  trackId: string
  source: LyricProviderSource | null
  /** Original source times, before the user's per-song correction. */
  lines: readonly LyricLine[]
}

export interface LyricCalibrationSample {
  index: number
  offsetMs: number
}

export function calibrationLines(
  lines: readonly LyricLine[],
): Array<{ index: number; line: LyricLine }> {
  return lines.flatMap((line, index) =>
    line.time !== null &&
    Number.isFinite(line.time) &&
    line.time >= 0 &&
    line.text.trim() &&
    !line.background
      ? [{ index, line }]
      : [],
  )
}

export function recordCalibrationSample(
  samples: readonly LyricCalibrationSample[],
  index: number,
  sourceSeconds: number,
  playbackSeconds: number,
): LyricCalibrationSample[] | null {
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    !Number.isFinite(sourceSeconds) ||
    !Number.isFinite(playbackSeconds) ||
    playbackSeconds < 0
  )
    return null
  const offsetMs = (playbackSeconds - sourceSeconds) * 1000
  if (Math.abs(offsetMs) > 30000) return null
  // A repeated tap on one line replaces its sample instead of weighting it twice.
  return [...samples.filter((sample) => sample.index !== index), { index, offsetMs }].slice(-5)
}

export function calibratedOffset(samples: readonly LyricCalibrationSample[]): number | null {
  const values = samples
    .map((sample) => sample.offsetMs)
    .filter((value) => Number.isFinite(value) && Math.abs(value) <= 30000)
    .sort((a, b) => a - b)
  if (!values.length) return null
  const middle = Math.floor(values.length / 2)
  const median = values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2
  return Math.round(median / 100) * 100
}
