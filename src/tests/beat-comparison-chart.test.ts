import { describe, expect, it } from 'vitest'
import { BEAT_COMPARISON_MODES, type BeatComparisonSample } from '../core/analysis/beat-comparison'
import type { BeatComparisonSeries } from '../core/analysis/beat-comparison-chart'
import { beatComparisonCurve, beatComparisonPosition } from '../core/analysis/beat-comparison-chart'

function sample(sampledAtMs: number): BeatComparisonSample {
  return {
    sampledAtMs,
    playbackSeconds: sampledAtMs / 1000,
    sampleSeconds: sampledAtMs / 1000 - 0.05,
    flashRate: 1,
    actual: {
      sampledAtMs,
      level: 0.9,
      sustain: 0.3,
      rawLevel: 0.7,
      rawSustain: 0.5,
      readyMix: 1,
      playbackSeconds: sampledAtMs / 1000,
      sampleSeconds: sampledAtMs / 1000 - 0.05,
      delayMs: 50,
      playing: true,
      seeking: false,
      canHighlight: true,
      reason: 'ready',
    },
    candidates: {
      basic: { level: 0.2, sustain: 0.5 },
      'beat-this-small': { level: 0.4, sustain: 0.5 },
      'beat-this-standard': { level: 0.6, sustain: 0.5 },
    },
  }
}

describe('beatComparisonCurve', () => {
  it('aligns all four series on the same observed-time and unit axes', () => {
    const history = [sample(20_000), sample(20_100)]
    const series: BeatComparisonSeries[] = [...BEAT_COMPARISON_MODES, 'actual']
    const paths = series.map((route) => beatComparisonCurve(history, route, 'level'))
    expect(paths.map((path) => path.match(/[ML]\d+\.\d+/g))).toEqual(
      Array.from({ length: 4 }, () => ['M465.81', 'L468.00']),
    )
    expect(paths[0]).toContain('114.80')
    expect(paths[3]).toContain('26.60')
    expect(paths[3]).not.toContain('51.80') // rawLevel is not the renderer output.
  })

  it('preserves unavailable model samples without adding a zero or replacing them with basic', () => {
    const history = [sample(20_000), sample(20_100), sample(20_200), sample(20_300)]
    history[1]!.candidates['beat-this-small'] = null
    history[2]!.candidates['beat-this-small'] = null
    const candidate = beatComparisonCurve(history, 'beat-this-small', 'level')
    expect(candidate.match(/M/g)).toHaveLength(2)
    expect(candidate).not.toContain('L')
    expect(candidate).not.toContain('140.00')
    expect(beatComparisonCurve(history, 'actual', 'level').match(/L/g)).toHaveLength(3)
  })

  it('moves existing points left as new samples arrive and discards observations older than twenty seconds', () => {
    const initial = [sample(20_000), sample(20_100)]
    expect(beatComparisonCurve(initial, 'actual', 'level')).toContain('M465.81')
    const next = [...initial, sample(20_200)]
    expect(beatComparisonCurve(next, 'actual', 'level')).toContain('M463.62')
    const old = sample(1000)
    old.actual.level = 0.1
    expect(beatComparisonCurve([old, sample(22_000)], 'actual', 'level')).toBe('M468.00,26.60')
    expect(beatComparisonPosition(2000, 22_000)).toBe(30)
    expect(beatComparisonPosition(1999, 22_000)).toBeNull()
  })

  it('uses real sustain and breaks gaps or invalid observations', () => {
    const history = [sample(1000), sample(1100), sample(1200), sample(2000)]
    history[1]!.actual.sustain = Number.NaN
    const path = beatComparisonCurve(history, 'actual', 'sustain')
    expect(path.match(/M/g)).toHaveLength(3)
    expect(path).not.toContain('NaN')
    expect(path).toContain('102.20')
    expect(beatComparisonCurve([], 'actual', 'level')).toBe('')
    expect(beatComparisonCurve([sample(Number.NaN)], 'actual', 'level')).toBe('')
    expect(beatComparisonPosition(Number.NaN, 1000)).toBeNull()
    expect(beatComparisonPosition(2000, 1000)).toBeNull()
  })
})
