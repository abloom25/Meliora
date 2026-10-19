import { describe, expect, it } from 'vitest'
import {
  createBeatTimelineBuilder,
  createBeatTimelineBuffer,
  createBeatRangeScheduler,
  normalizeBeatRanges,
  beatRangesDuration,
  mergeBeatTimelineRange,
  snapshotBeatTimeline,
  isBeatTimelineReadyAt,
  sampleBeatTimeline,
  type BeatTimeline,
} from '../core/analysis/beat-timeline'
import { createRealtimeHpss } from '../core/analysis/hpss'

const SAMPLE_RATE = 48000

function drums(duration: number, spacing = 0.5, gain = 0.08): Float32Array {
  return Float32Array.from({ length: Math.round(duration * SAMPLE_RATE) }, (_, sample) => {
    const time = sample / SAMPLE_RATE
    if (time < 0.5 || time > duration - 1) return 0
    const beatTime = (time - 0.5) % spacing
    if (beatTime > 0.12) return 0
    return (
      gain *
      Math.exp(-beatTime * 35) *
      (Math.sin(2 * Math.PI * 80 * beatTime) +
        0.7 * Math.sin(2 * Math.PI * 140 * beatTime) +
        0.5 * Math.sin(2 * Math.PI * 210 * beatTime))
    )
  })
}

function build(channels: Float32Array[], batch = 1000): BeatTimeline {
  const builder = createBeatTimelineBuilder(channels, SAMPLE_RATE)
  while (builder.process(batch) < 1) {
    // Deliberately finish in multiple batches, as a yielding worker does.
  }
  return builder.finish()
}

function peakAround(timeline: BeatTimeline, time: number, rate = 1): number {
  let peak = 0
  for (let offset = -0.03; offset < 0.08; offset += 0.005) {
    peak = Math.max(peak, sampleBeatTimeline(timeline, time + offset, rate).level)
  }
  return peak
}

function rises(values: Float32Array): number {
  let result = 0
  for (let index = 1; index < values.length; index += 1) {
    if (values[index]! - values[index - 1]! > 0.2) result += 1
  }
  return result
}

describe('prebuilt DSP beat timeline', () => {
  it('builds a middle range with bounded warmup and global frame indexing', () => {
    const samples = drums(28)
    // The range builder must never walk the unrelated opening of the song.
    samples[0] = Number.NaN
    const builder = createBeatTimelineBuilder([samples], SAMPLE_RATE, {
      startSeconds: 20,
      endSeconds: 24,
    })
    builder.process(60)
    expect(builder.snapshot().completedRanges).toEqual([])
    expect(sampleBeatTimeline(builder.snapshot(), 14.5, 1).level).toBe(0)
    expect(builder.process(541)).toBe(1) // Six-second warmup plus four seconds, inclusive endpoint.
    const timeline = builder.finish()
    expect(timeline.completedRanges).toEqual([{ startSeconds: 20, endSeconds: 24 }])
    expect(timeline.levels[0].length).toBe(28 * 60 + 1)
    expect(peakAround(timeline, 20.5)).toBeGreaterThan(0.5)
    expect(sampleBeatTimeline(timeline, 19.9, 1).level).toBe(0)
    expect(sampleBeatTimeline(timeline, 24, 1).level).toBe(0)
  })

  it('normalizes disjoint ranges without filling gaps or counting overlaps twice', () => {
    const ranges = [
      { startSeconds: 8, endSeconds: 15 },
      { startSeconds: 2, endSeconds: 4 },
      { startSeconds: -1, endSeconds: 2 },
      { startSeconds: 3, endSeconds: 5 },
      { startSeconds: 9, endSeconds: 8 },
      { startSeconds: Number.NaN, endSeconds: 8 },
    ]
    const normalized = normalizeBeatRanges(ranges, 10)
    expect(normalized).toEqual([
      { startSeconds: 0, endSeconds: 5 },
      { startSeconds: 8, endSeconds: 10 },
    ])
    expect(beatRangesDuration(normalized)).toBe(7)
    expect(normalizeBeatRanges(ranges, Number.NaN)).toEqual([])
    expect(ranges[0]).toEqual({ startSeconds: 8, endSeconds: 15 })
  })

  it('merges out-of-order coverage without changing already published frames', () => {
    const target = createBeatTimelineBuffer(6, 0.5)
    const late = createBeatTimelineBuffer(6, 0.5)
    late.levels.forEach((values) => values.fill(0.8))
    late.sustain.fill(0.6)
    late.completedRanges = [{ startSeconds: 4, endSeconds: 6 }]
    mergeBeatTimelineRange(target, late)
    const published = snapshotBeatTimeline(target)
    const early = createBeatTimelineBuffer(6, 0.5)
    early.levels.forEach((values) => values.fill(0.2))
    early.completedRanges = [{ startSeconds: 0, endSeconds: 2 }]
    mergeBeatTimelineRange(target, early)
    expect(target.completedRanges).toEqual([
      { startSeconds: 0, endSeconds: 2 },
      { startSeconds: 4, endSeconds: 6 },
    ])
    expect(target.builtUntilSeconds).toBe(2)
    expect(sampleBeatTimeline(target, 4.5, 1).level).toBeCloseTo(0.8)
    expect(sampleBeatTimeline(target, 3, 1)).toEqual({ level: 0, sustain: 0 })
    expect(published.completedRanges).toEqual([{ startSeconds: 4, endSeconds: 6 }])
    expect(published.levels[0][0]).toBe(0)
    mergeBeatTimelineRange(target, early, { startSeconds: 1, endSeconds: 5 })
    expect(target.completedRanges).toEqual([{ startSeconds: 0, endSeconds: 6 }])
    expect(sampleBeatTimeline(target, 4.5, 1).level).toBeCloseTo(0.8)
  })

  it('never interpolates through a hole or lets a legacy prefix mask valid later ranges', () => {
    const timeline = createBeatTimelineBuffer(5, 0.5)
    timeline.completedRanges = [
      { startSeconds: 1, endSeconds: 1.75 },
      { startSeconds: 3, endSeconds: 4 },
    ]
    timeline.builtUntilSeconds = 0
    timeline.levels.forEach((values) => values.fill(9))
    timeline.sustain.fill(9)
    timeline.levels.forEach((values) => {
      values[2] = 0.4
      values[3] = 0.4
      values[4] = 0.4 // Computed right support for the half-open 1.75-second endpoint.
      values[6] = 0.7
      values[7] = 0.7
    })
    expect(isBeatTimelineReadyAt(timeline, 3.25)).toBe(true)
    expect(sampleBeatTimeline(timeline, 3.25, 1).level).toBeCloseTo(0.7)
    expect(sampleBeatTimeline(timeline, 1.7, 1).level).toBeCloseTo(0.4)
    for (const time of [0.99, 1.75, 2.9, 4, 5, Number.NaN])
      expect(sampleBeatTimeline(timeline, time, 1)).toEqual({ level: 0, sustain: 0 })
  })

  it('freezes both interpolation supports when adjacent ranges join in either order', () => {
    const timeline = createBeatTimelineBuffer(3, 0.5)
    const middle = createBeatTimelineBuffer(3, 0.5)
    middle.levels.forEach((values) => values.set([0, 0.1, 0.2, 0.3, 0.4, 0, 0]))
    middle.sustain.set([0, 0.4, 0.3, 0.2, 0.1, 0, 0])
    mergeBeatTimelineRange(timeline, middle, { startSeconds: 0.75, endSeconds: 1.75 })
    const left = sampleBeatTimeline(timeline, 0.755, 1)
    const right = sampleBeatTimeline(timeline, 1.745, 1)
    const adjacent = createBeatTimelineBuffer(3, 0.5)
    adjacent.levels.forEach((values) => values.fill(0.9))
    adjacent.sustain.fill(0.9)
    mergeBeatTimelineRange(timeline, adjacent, { startSeconds: 1.75, endSeconds: 3 })
    mergeBeatTimelineRange(timeline, adjacent, { startSeconds: 0, endSeconds: 0.75 })
    expect(timeline.completedRanges).toEqual([{ startSeconds: 0, endSeconds: 3 }])
    expect(sampleBeatTimeline(timeline, 0.755, 1)).toEqual(left)
    expect(sampleBeatTimeline(timeline, 1.745, 1)).toEqual(right)
  })

  it('prioritizes the current segment, continues forward, then fills earlier holes', () => {
    const scheduler = createBeatRangeScheduler(45, 10)
    scheduler.prioritize(25)
    expect(scheduler.next()).toEqual({ startSeconds: 20, endSeconds: 30 })
    expect(scheduler.next()).toEqual({ startSeconds: 30, endSeconds: 40 })
    scheduler.prioritize(5)
    expect(scheduler.next()).toEqual({ startSeconds: 0, endSeconds: 10 })
    expect(scheduler.next()).toEqual({ startSeconds: 10, endSeconds: 20 })
    expect(scheduler.next()).toEqual({ startSeconds: 40, endSeconds: 45 })
    expect(scheduler.next()).toBeNull()
  })

  it('publishes immutable prefixes and never samples unbuilt audio', () => {
    const builder = createBeatTimelineBuilder([drums(4)], SAMPLE_RATE)
    builder.process(70)
    const partial = builder.snapshot()
    const frozen = partial.levels[0].slice()
    expect(partial.builtUntilSeconds).toBeCloseTo(69 / 60)
    expect(peakAround(partial, 0.5)).toBeGreaterThan(0.6)
    expect(sampleBeatTimeline(partial, 1.5, 1)).toEqual({ level: 0, sustain: 0 })
    builder.process(10000)
    const full = builder.finish()
    expect(partial.levels[0]).toEqual(frozen)
    expect(peakAround(full, 1.5)).toBeGreaterThan(0.6)
    expect(full.levels[0].slice(0, 70)).toEqual(frozen)
  })
  it('never flashes or breathes for silence and only exposes completed builds', () => {
    const builder = createBeatTimelineBuilder([new Float32Array(SAMPLE_RATE)], SAMPLE_RATE)
    expect(() => builder.finish()).toThrow('尚未构建')
    expect(builder.process(10)).toBeCloseTo(10 / 61)
    expect(() => builder.finish()).toThrow('尚未构建')
    expect(builder.process(100)).toBe(1)
    const timeline = builder.finish()
    expect(timeline.durationSeconds).toBe(1)
    expect(timeline.stepSeconds).toBe(1 / 60)
    for (const values of [...timeline.levels, timeline.sustain]) {
      expect(values.every((value) => value === 0)).toBe(true)
    }
  })

  it('aligns repeated drum pulses with media time and decays through the silent tail', () => {
    const timeline = build([drums(5)])
    expect(sampleBeatTimeline(timeline, 0.3, 1).level).toBe(0)
    for (const time of [0.5, 1, 1.5, 2, 2.5, 3]) {
      expect(peakAround(timeline, time)).toBeGreaterThan(0.65)
      expect(sampleBeatTimeline(timeline, time + 0.35, 1).level).toBeLessThan(0.25)
    }
    expect(sampleBeatTimeline(timeline, 4.9, 1).level).toBeLessThan(0.01)
    for (const values of [...timeline.levels, timeline.sustain]) {
      expect(values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true)
    }
  })

  it('normalizes quieter music without losing pulse strength', () => {
    const quiet = build([drums(3, 0.5, 0.008)])
    const loud = build([drums(3, 0.5, 0.08)])
    for (const time of [0.5, 1, 1.5]) {
      expect(peakAround(quiet, time)).toBeGreaterThan(0.6)
      expect(Math.abs(peakAround(quiet, time) - peakAround(loud, time))).toBeLessThan(0.3)
    }
  })

  it('computes density choices together and limits closely spaced pulses at low density', () => {
    const timeline = build([drums(5, 0.125)])
    const counts = timeline.levels.map(rises)
    expect(counts[0]).toBeLessThan(counts[1]!)
    expect(counts[1]).toBeLessThan(counts[2]!)
    expect(counts[2]).toBeLessThanOrEqual(counts[3]!)
    expect(counts[3]).toBeGreaterThan(15)
  })

  it('is independent of batching and averages channels before analysis', () => {
    const samples = drums(1.5)
    const first = build([samples], 7)
    const second = build([samples, samples], 91)
    expect(second).toEqual(first)
    const inverse = samples.map((value) => -value)
    const cancelled = build([samples, inverse])
    expect(cancelled.levels.every((values) => values.every((value) => value === 0))).toBe(true)
    expect(cancelled.sustain.every((value) => value === 0)).toBe(true)
  })

  it('keeps cropped low-frequency HPSS identical to its full-spectrum reference', () => {
    const full = createRealtimeHpss({ bins: 1024 })
    const lowTo = Math.round((150 * 2048) / SAMPLE_RATE)
    const crop = createRealtimeHpss({ bins: lowTo + 8 })
    for (let frame = 0; frame < 20; frame += 1) {
      const magnitude = Float32Array.from(
        { length: 1024 },
        (_, bin) => Math.abs(Math.sin(frame * 9 + bin * 11)) * (frame % 7 === 0 ? 0.6 : 0.1),
      )
      const expected = full.process(magnitude).percussiveMask
      const actual = crop.process(magnitude.subarray(0, lowTo + 8)).percussiveMask
      expect(actual.slice(1, lowTo)).toEqual(expected.slice(1, lowTo))
    }
  })

  it('interpolates media time, supports seeks in any order and reuses the output object', () => {
    const timeline: BeatTimeline = {
      durationSeconds: 1,
      stepSeconds: 0.5,
      levels: [
        new Float32Array([0, 0.2, 0]),
        new Float32Array([0, 0.4, 0]),
        new Float32Array([0, 0.6, 0]),
        new Float32Array([0, 0.8, 0]),
      ],
      sustain: new Float32Array([0.2, 0.6, 0.2]),
    }
    const result = { level: 0, sustain: 0 }
    expect(sampleBeatTimeline(timeline, 0.75, 4, result)).toBe(result)
    expect(result.level).toBeCloseTo(0.4)
    expect(result.sustain).toBeCloseTo(0.4)
    expect(sampleBeatTimeline(timeline, 0.25, 2).level).toBeCloseTo(0.3)
    expect(sampleBeatTimeline(timeline, 0.25, Number.NaN).level).toBeCloseTo(0.2)
    for (const time of [-1, 1, 99, Number.NaN, Infinity]) {
      expect(sampleBeatTimeline(timeline, time, 1)).toEqual({ level: 0, sustain: 0 })
    }
  })

  it('rejects invalid audio and incremental batch inputs', () => {
    const frame = new Float32Array(100)
    for (const rate of [0, 7999, 192001, Number.NaN, Infinity]) {
      expect(() => createBeatTimelineBuilder([frame], rate)).toThrow()
    }
    expect(() => createBeatTimelineBuilder([], SAMPLE_RATE)).toThrow()
    expect(() => createBeatTimelineBuilder([new Float32Array()], SAMPLE_RATE)).toThrow()
    expect(() => createBeatTimelineBuilder([frame, frame.slice(1)], SAMPLE_RATE)).toThrow()
    const builder = createBeatTimelineBuilder([frame], SAMPLE_RATE)
    for (const batch of [0, -1, Number.NaN, Infinity]) {
      expect(() => builder.process(batch)).toThrow()
    }
    frame[12] = Infinity
    expect(() => builder.process(1)).toThrow('无效采样')
  })
})
