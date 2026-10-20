import { describe, expect, it } from 'vitest'
import {
  appendBeatComparisonSample,
  createBeatComparisonSample,
} from '../core/analysis/beat-comparison'
import type { BeatDebugSample } from '../core/analysis/beat-debug'
import { createBeatTimelineBuffer } from '../core/analysis/beat-timeline'

function actual(sampledAtMs = 1000): BeatDebugSample {
  return {
    sampledAtMs,
    level: 0.7,
    sustain: 0.3,
    rawLevel: 0.9,
    rawSustain: 0.8,
    readyMix: 1,
    playbackSeconds: 11,
    sampleSeconds: 10.5,
    delayMs: 500,
    playing: true,
    seeking: false,
    canHighlight: true,
    reason: 'ready',
  }
}
describe('rolling beat comparison observations', () => {
  it('samples candidates at actual sampleSeconds while preserving the actual renderer output', () => {
    const timeline = createBeatTimelineBuffer(30, 0.5)
    timeline.completedRanges = [{ startSeconds: 10, endSeconds: 12 }]
    timeline.levels[1][21] = 0.25
    timeline.levels[1][22] = 0.75
    timeline.sustain[21] = 0.5
    const sample = createBeatComparisonSample(actual(), 1, {
      basic: timeline,
      'beat-this-small': timeline,
      'beat-this-standard': null,
    })
    expect(sample.actual.level).toBe(0.7)
    expect(sample.actual.rawLevel).toBe(0.9)
    expect(sample.candidates.basic).toEqual({ level: 0.25, sustain: 0.5 })
    expect(sample.candidates['beat-this-small']).toEqual(sample.candidates.basic)
    expect(sample.candidates['beat-this-standard']).toBeNull()
  })
  it('never fills an old gap after analysis finishes and keeps a real paused release tail', () => {
    const timeline = createBeatTimelineBuffer(30)
    const input = { ...actual(), playing: false, canHighlight: false, reason: 'paused' as const }
    const sample = createBeatComparisonSample(input, 1, {
      basic: timeline,
      'beat-this-small': null,
      'beat-this-standard': null,
    })
    expect(sample.actual.level).toBe(0.7)
    timeline.completedRanges = [{ startSeconds: 0, endSeconds: 30 }]
    timeline.levels[1].fill(1)
    input.level = 0
    expect(sample.actual.level).toBe(0.7)
    expect(sample.candidates.basic).toBeNull()
    expect(
      createBeatComparisonSample(input, 1, {
        basic: timeline,
        'beat-this-small': null,
        'beat-this-standard': null,
      }).candidates.basic?.level,
    ).toBe(1)
  })
  it('retains twenty seconds and bounds even unusually fast observations', () => {
    const sample = createBeatComparisonSample(actual(0), 1, {
      basic: null,
      'beat-this-small': null,
      'beat-this-standard': null,
    })
    let history = [sample]
    for (let index = 1; index <= 1300; index += 1)
      history = [...appendBeatComparisonSample(history, { ...sample, sampledAtMs: index })]
    expect(history).toHaveLength(1200)
    const trimmed = appendBeatComparisonSample(history, { ...sample, sampledAtMs: 22000 })
    expect(trimmed).toHaveLength(1)
    expect(appendBeatComparisonSample(trimmed, { ...sample, sampledAtMs: 22000 })).toHaveLength(1)
  })
})
