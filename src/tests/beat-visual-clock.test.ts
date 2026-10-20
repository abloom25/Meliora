import { describe, expect, it } from 'vitest'
import {
  createBeatVisualClock,
  type BeatVisualClockInput,
} from '../core/analysis/beat-visual-clock'

function input(overrides: Partial<BeatVisualClockInput> = {}): BeatVisualClockInput {
  return {
    nowMs: 1000,
    mediaSeconds: 12,
    contextSeconds: 20,
    playbackRate: 1,
    running: true,
    baseLatencySeconds: 0.02,
    outputLatencySeconds: 0.08,
    outputTimestamp: { contextTime: 19.9, performanceTime: 1000 },
    ...overrides,
  }
}

describe('beat output visual clock', () => {
  it('maps output time into the media anchor without applying reported latency twice', () => {
    const sample = createBeatVisualClock().sample(input({ manualOffsetMs: 25 }))
    expect(sample.clockSource).toBe('output-timestamp')
    expect(sample.sampleSeconds).toBeCloseTo(11.875)
    expect(sample.outputOffsetMs).toBeCloseTo(100)
    expect(sample.delayMs).toBeCloseTo(125)
    expect(sample.frameLeadMs).toBe(0)
  })

  it('uses the performance mapping across context render-quantum jitter', () => {
    const clock = createBeatVisualClock()
    clock.sample(input())
    const sample = clock.sample(
      input({
        nowMs: 1016,
        mediaSeconds: 12.016,
        contextSeconds: 20.02,
        outputTimestamp: { contextTime: 19.91, performanceTime: 1010 },
      }),
    )
    expect(sample.sampleSeconds).toBeCloseTo(11.916)
    expect(sample.clockSource).toBe('output-timestamp')
  })

  it.each([
    { contextTime: 0, performanceTime: 0 },
    { contextTime: NaN, performanceTime: 1000 },
    { contextTime: 19.9, performanceTime: Infinity },
    { contextTime: 19.9, performanceTime: 700 },
    { contextTime: 19.9, performanceTime: 1030 },
    { contextTime: 25, performanceTime: 1000 },
    { contextTime: 15, performanceTime: 1000 },
  ])('falls back safely for an invalid or stale timestamp %j', (outputTimestamp) => {
    const sample = createBeatVisualClock().sample(input({ outputTimestamp, manualOffsetMs: -30 }))
    expect(sample.clockSource).toBe('latency-fallback')
    expect(sample.sampleSeconds).toBeCloseTo(11.93)
  })

  it('rejects regressing timestamps and accepts them after an explicit reanchor', () => {
    const clock = createBeatVisualClock()
    clock.sample(input())
    const next = input({ outputTimestamp: { contextTime: 19.89, performanceTime: 999 } })
    expect(clock.sample(next).clockSource).toBe('latency-fallback')
    clock.reset()
    expect(clock.sample(next).clockSource).toBe('output-timestamp')
  })

  it('reanchors rate changes, large media jumps and reset context clocks', () => {
    const clock = createBeatVisualClock()
    clock.sample(input())
    expect(clock.sample(input({ playbackRate: 2, manualOffsetMs: -25 })).sampleSeconds).toBeCloseTo(
      11.85,
    )
    expect(clock.sample(input({ mediaSeconds: 30 })).sampleSeconds).toBeCloseTo(29.9)
    expect(
      clock.sample(
        input({
          contextSeconds: 1,
          outputTimestamp: { contextTime: 0.9, performanceTime: 1000 },
        }),
      ).sampleSeconds,
    ).toBeCloseTo(11.9)
  })

  it('requires stable cadence, caps prediction at 20ms and discards long-frame catch-up', () => {
    const clock = createBeatVisualClock()
    const samples = Array.from({ length: 4 }, (_, index) =>
      clock.sample(
        input({
          nowMs: 1000 + index * 33,
          mediaSeconds: 12 + index * 0.033,
          contextSeconds: 20 + index * 0.033,
          outputTimestamp: undefined,
          frameDeltaMs: 33,
        }),
      ),
    )
    expect(samples[0]!.frameLeadMs).toBe(0)
    expect(samples[1]!.frameLeadMs).toBe(0)
    expect(samples[2]!.frameLeadMs).toBe(20)
    const jumped = clock.sample(
      input({ nowMs: 1132, mediaSeconds: 30, contextSeconds: 20.132, frameDeltaMs: 33 }),
    )
    expect(jumped.frameLeadMs).toBe(0)
    const resumed = clock.sample(
      input({ nowMs: 5000, mediaSeconds: 16, contextSeconds: 24, frameDeltaMs: 3901 }),
    )
    expect(resumed.frameLeadMs).toBe(0)
    expect(resumed.sampleSeconds).toBeCloseTo(15.9)
  })

  it('does not keep extrapolating an unchanged media position or a paused/stalled clock', () => {
    const clock = createBeatVisualClock()
    clock.sample(input())
    const stalled = clock.sample(
      input({
        nowMs: 1200,
        contextSeconds: 20.2,
        outputTimestamp: { contextTime: 20.1, performanceTime: 1200 },
        frameDeltaMs: 16,
      }),
    )
    expect(stalled.clockSource).toBe('latency-fallback')
    expect(stalled.sampleSeconds).toBeCloseTo(11.9)
    expect(stalled.frameLeadMs).toBe(0)
    expect(clock.sample(input({ running: false })).clockSource).toBe('media')
    expect(clock.sample(input({ running: false })).sampleSeconds).toBe(12)
    expect(clock.sample(input({ mediaSeconds: 24 })).sampleSeconds).toBeCloseTo(23.9)
  })

  it('sanitizes invalid latency and manual settings without NaN propagation', () => {
    const sample = createBeatVisualClock().sample(
      input({
        outputTimestamp: undefined,
        baseLatencySeconds: NaN,
        outputLatencySeconds: Infinity,
        manualOffsetMs: NaN,
      }),
    )
    expect(sample.sampleSeconds).toBe(12)
    expect(sample.delayMs).toBe(0)
  })

  it('never replays a sampled attack when timestamp validity or frame prediction changes', () => {
    const clock = createBeatVisualClock()
    const first = clock.sample(
      input({ outputTimestamp: { contextTime: 19.95, performanceTime: 1000 } }),
    )
    const fallback = clock.sample(
      input({
        nowMs: 1016,
        mediaSeconds: 12.016,
        contextSeconds: 20.016,
        outputTimestamp: undefined,
      }),
    )
    const recovered = clock.sample(
      input({
        nowMs: 1032,
        mediaSeconds: 12.032,
        contextSeconds: 20.032,
        outputTimestamp: { contextTime: 19.982, performanceTime: 1032 },
      }),
    )
    expect(first.sampleSeconds).toBeCloseTo(11.95)
    expect(fallback.clockSource).toBe('latency-fallback')
    expect(fallback.sampleSeconds).toBeCloseTo(11.95)
    expect(recovered.sampleSeconds).toBeCloseTo(11.982)
    clock.reset()
    expect(clock.sample(input({ outputTimestamp: undefined })).sampleSeconds).toBeCloseTo(11.9)
  })

  it('lets deliberate manual offset changes move the sampling position backwards', () => {
    const clock = createBeatVisualClock()
    clock.sample(input())
    const adjusted = clock.sample(input({ manualOffsetMs: 100 }))
    expect(adjusted.sampleSeconds).toBeCloseTo(11.8)
  })
})
