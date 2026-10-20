import type { BeatComparisonMode, BeatComparisonSample } from './beat-comparison'
import { BEAT_DEBUG_HISTORY_MS } from './beat-debug'

export type BeatComparisonMetric = 'level' | 'sustain'
export type BeatComparisonSeries = BeatComparisonMode | 'actual'

export const BEAT_COMPARISON_CHART = {
  width: 480,
  height: 176,
  left: 30,
  right: 468,
  top: 14,
  bottom: 140,
} as const

export function beatComparisonPosition(sampledAtMs: number, endMs: number): number | null {
  if (
    !Number.isFinite(sampledAtMs) ||
    !Number.isFinite(endMs) ||
    sampledAtMs < endMs - BEAT_DEBUG_HISTORY_MS ||
    sampledAtMs > endMs
  )
    return null
  return (
    BEAT_COMPARISON_CHART.left +
    (1 - (endMs - sampledAtMs) / BEAT_DEBUG_HISTORY_MS) *
      (BEAT_COMPARISON_CHART.right - BEAT_COMPARISON_CHART.left)
  )
}

/** Observed history only: late model results never fill or reinterpret earlier gaps. */
export function beatComparisonCurve(
  history: readonly BeatComparisonSample[],
  series: BeatComparisonSeries,
  metric: BeatComparisonMetric,
): string {
  const endMs = history.at(-1)?.sampledAtMs
  if (endMs === undefined || !Number.isFinite(endMs)) return ''
  const path: string[] = []
  let previousMs: number | null = null
  for (const sample of history) {
    const x = beatComparisonPosition(sample.sampledAtMs, endMs)
    const value = (series === 'actual' ? sample.actual : sample.candidates[series])?.[metric]
    if (x === null || value === undefined || !Number.isFinite(value)) {
      previousMs = null
      continue
    }
    const y =
      BEAT_COMPARISON_CHART.bottom -
      Math.max(0, Math.min(1, value)) * (BEAT_COMPARISON_CHART.bottom - BEAT_COMPARISON_CHART.top)
    const command =
      previousMs === null ||
      sample.sampledAtMs - previousMs > 500 ||
      sample.sampledAtMs <= previousMs
        ? 'M'
        : 'L'
    path.push(`${command}${x.toFixed(2)},${y.toFixed(2)}`)
    previousMs = sample.sampledAtMs
  }
  return path.join(' ')
}
