import { describe, expect, it } from 'vitest'
import {
  continuousBeatCoverage,
  createBeatSchedulingController,
  type BeatPlaybackState,
} from '../core/analysis/beat-scheduling'
import type { BeatTimeRange } from '../core/analysis/beat-timeline'

function playback(overrides: Partial<BeatPlaybackState> = {}): BeatPlaybackState {
  return { timeSeconds: 0, playing: true, playbackRate: 1, seeking: false, ...overrides }
}

function windows(duration = 240, width = 24): BeatTimeRange[] {
  return Array.from({ length: Math.ceil(duration / width) }, (_, index) => ({
    startSeconds: index * width,
    endSeconds: Math.min(duration, (index + 1) * width),
  }))
}

describe('continuous beat coverage', () => {
  const ranges = [
    { startSeconds: 20, endSeconds: 30 },
    { startSeconds: 2, endSeconds: 7 },
    { startSeconds: 5, endSeconds: 10 },
    { startSeconds: 10, endSeconds: 14 },
  ]

  it('unites overlapping and touching ranges without crossing a hole', () => {
    expect(continuousBeatCoverage(ranges, 2.5, 40)).toBe(11.5)
    expect(continuousBeatCoverage(ranges, 10, 40)).toBe(4)
    expect(continuousBeatCoverage(ranges, 20.25, 40)).toBe(9.75)
    expect(ranges[0]).toEqual({ startSeconds: 20, endSeconds: 30 })
    for (const time of [0, 1.999, 14, 19.999, 30, 40, -1, Infinity, Number.NaN])
      expect(continuousBeatCoverage(ranges, time, 40)).toBe(0)
  })

  it('uses actual fractional coverage, clamps to duration and rejects invalid durations', () => {
    const actual = [{ startSeconds: 24.25, endSeconds: 47.75 }]
    expect(continuousBeatCoverage(actual, 24.1, 100)).toBe(0)
    expect(continuousBeatCoverage(actual, 24.25, 100)).toBe(23.5)
    expect(continuousBeatCoverage(actual, 47.75, 100)).toBe(0)
    expect(continuousBeatCoverage(ranges, 20, 25)).toBe(5)
    for (const duration of [0, -1, Number.NaN, Infinity])
      expect(continuousBeatCoverage(ranges, 3, duration)).toBe(0)
  })
})

describe('beat scheduling playback clock', () => {
  it('extrapolates only while playing, respects rate changes and clamps to song boundaries', () => {
    const scheduler = createBeatSchedulingController(100, playback({ timeSeconds: 10 }), 1000)
    expect(scheduler.playbackAt(4000).timeSeconds).toBe(13)
    scheduler.updatePlayback(playback({ timeSeconds: 13, playbackRate: 2 }), 4000)
    expect(scheduler.playbackAt(6000).timeSeconds).toBe(17)
    scheduler.updatePlayback(playback({ timeSeconds: 17, playing: false }), 6000)
    expect(scheduler.playbackAt(60000).timeSeconds).toBe(17)
    scheduler.updatePlayback(playback({ timeSeconds: 98, playbackRate: 2 }), 60000)
    expect(scheduler.playbackAt(62000).timeSeconds).toBe(100)
    scheduler.updatePlayback(playback({ timeSeconds: -3 }), 62000)
    expect(scheduler.playbackAt(62000).timeSeconds).toBe(0)
  })

  it('freezes throughout seeking and reanchors the final selected position', () => {
    const scheduler = createBeatSchedulingController(240, playback(), 0)
    scheduler.updatePlayback(playback({ timeSeconds: 130, seeking: true }), 1000)
    expect(scheduler.playbackAt(5000).timeSeconds).toBe(130)
    expect(scheduler.next(windows(), new Set(), 5000)).toBeNull()
    scheduler.updatePlayback(playback({ timeSeconds: 65, seeking: true }), 6000)
    expect(scheduler.next(windows(), new Set(), 9000)).toBeNull()
    scheduler.updatePlayback(playback({ timeSeconds: 65 }), 10000)
    expect(scheduler.next(windows(), new Set(), 10000)).toBe(2)
    expect(scheduler.playbackAt(11000).timeSeconds).toBe(66)
  })

  it('sanitizes invalid samples without mutating callers or inventing elapsed time', () => {
    const initial = playback({ timeSeconds: 5 })
    const scheduler = createBeatSchedulingController(100, initial, 1000)
    initial.timeSeconds = 88
    expect(scheduler.playbackAt(500).timeSeconds).toBe(5)
    expect(scheduler.playbackAt(Number.NaN).timeSeconds).toBe(5)
    scheduler.updatePlayback(playback({ timeSeconds: Number.NaN, playbackRate: Infinity }), 2000)
    expect(scheduler.playbackAt(3000)).toEqual(playback({ timeSeconds: 7 }))
    scheduler.playbackAt(3000).timeSeconds = 90
    expect(scheduler.playbackAt(3000).timeSeconds).toBe(7)
    for (const duration of [0, -1, Number.NaN, Infinity])
      expect(() => createBeatSchedulingController(duration, playback(), 0)).toThrow()
  })
})

describe('adaptive beat scheduling', () => {
  it('starts nearby without a measurement and never reserves or revisits completed work', () => {
    const scheduler = createBeatSchedulingController(240, playback({ timeSeconds: 50 }), 0)
    const completed = new Set<number>()
    expect(scheduler.next(windows(), completed, 0)).toBe(2)
    expect(scheduler.next(windows(), completed, 0)).toBe(2)
    expect(completed.size).toBe(0)
    completed.add(2)
    expect(scheduler.next(windows(), completed, 0)).toBe(1)
    for (let index = 0; index < 10; index += 1) completed.add(index)
    expect(scheduler.next(windows(), completed, 0)).toBeNull()
    expect(scheduler.next([], new Set(), 0)).toBeNull()
  })

  it('keeps the current window when enough of it remains after the measured work', () => {
    const scheduler = createBeatSchedulingController(240, playback({ timeSeconds: 5 }), 0)
    scheduler.seedWorkDuration(8000)
    expect(scheduler.next(windows(), new Set(), 0)).toBe(0)
    scheduler.updatePlayback(playback({ timeSeconds: 20 }), 0)
    expect(scheduler.next(windows(), new Set(), 0)).toBe(1)
  })

  it('uses probe timing on startup and jumps far enough for a slow model to catch playback', () => {
    const scheduler = createBeatSchedulingController(240, playback(), 0)
    scheduler.seedWorkDuration(60000)
    const completed = new Set<number>()
    const first = scheduler.next(windows(), completed, 0)
    expect(first).toBe(2)
    expect(windows()[first!]!.endSeconds).toBeGreaterThan(60)
    completed.add(first!)
    scheduler.observeWorkDuration(60000)
    expect(scheduler.next(windows(), completed, 60000)).toBe(5)
  })

  it('does not cap necessary prediction below the real cost of extremely slow hardware', () => {
    const scheduler = createBeatSchedulingController(600, playback(), 0)
    scheduler.seedWorkDuration(180000)
    const selected = scheduler.next(windows(600), new Set(), 0)
    expect(selected).toBe(7)
    expect(windows(600)[selected!]!.endSeconds).toBeGreaterThan(180)
    scheduler.observeWorkDuration(1e9)
    expect(scheduler.next(windows(600), new Set(), 0)).toBe(24)
  })

  it('responds quickly to rising cost and smooths reductions across windows', () => {
    const scheduler = createBeatSchedulingController(240, playback(), 0)
    scheduler.observeWorkDuration(1000)
    expect(scheduler.estimatedWorkMs).toBe(1000)
    scheduler.observeWorkDuration(11000)
    expect(scheduler.estimatedWorkMs).toBeCloseTo(9500)
    scheduler.observeWorkDuration(1000)
    expect(scheduler.estimatedWorkMs).toBeCloseTo(8225)
    scheduler.seedWorkDuration(100)
    expect(scheduler.estimatedWorkMs).toBeCloseTo(8225)
    scheduler.seedWorkDuration(12000)
    expect(scheduler.estimatedWorkMs).toBe(12000)
    for (const invalid of [-1, Infinity, Number.NaN]) {
      scheduler.observeWorkDuration(invalid)
      scheduler.seedWorkDuration(invalid)
    }
    expect(scheduler.estimatedWorkMs).toBe(12000)
  })

  it('uses playback speed when estimating where a window becomes useful', () => {
    const scheduler = createBeatSchedulingController(240, playback({ timeSeconds: 5 }), 0)
    scheduler.seedWorkDuration(15000)
    expect(scheduler.next(windows(), new Set(), 0)).toBe(0)
    scheduler.updatePlayback(playback({ timeSeconds: 5, playbackRate: 2 }), 0)
    expect(scheduler.next(windows(), new Set(), 0)).toBe(1)
    scheduler.updatePlayback(playback({ timeSeconds: 5, playbackRate: 0.5 }), 0)
    expect(scheduler.next(windows(), new Set(), 0)).toBe(0)
  })

  it('does not predict ahead while paused, and fills nearest holes in both directions', () => {
    const scheduler = createBeatSchedulingController(
      240,
      playback({ timeSeconds: 53, playing: false }),
      0,
    )
    scheduler.seedWorkDuration(60000)
    const completed = new Set<number>()
    expect(scheduler.next(windows(), completed, 30000)).toBe(2)
    completed.add(2)
    expect(scheduler.next(windows(), completed, 30000)).toBe(1)
    completed.add(1)
    expect(scheduler.next(windows(), completed, 30000)).toBe(3)
    scheduler.updatePlayback(playback({ timeSeconds: 72, playing: false }), 30000)
    expect(scheduler.next(windows(), new Set(), 30000)).toBe(3)
  })

  it('repairs nearby history when forward coverage is sufficient, then protects the frontier', () => {
    const scheduler = createBeatSchedulingController(240, playback({ timeSeconds: 50 }), 0)
    scheduler.seedWorkDuration(5000)
    const completed = new Set([2, 3, 4])
    expect(scheduler.next(windows(), completed, 0)).toBe(1)
    completed.add(1)
    expect(scheduler.next(windows(), completed, 0)).toBe(0)
    // Remaining runway is now below the two-window target: extend the front.
    expect(scheduler.next(windows(), completed, 35000)).toBe(5)
    expect(completed).toEqual(new Set([1, 2, 3, 4]))
  })

  it('does not mistake disjoint completed islands for continuous lookahead', () => {
    const scheduler = createBeatSchedulingController(240, playback({ timeSeconds: 25 }), 0)
    scheduler.seedWorkDuration(5000)
    expect(scheduler.next(windows(), new Set([1, 3, 4, 5]), 0)).toBe(2)
    // Enough contiguous audio changes the choice to the nearby historical hole.
    expect(scheduler.next(windows(), new Set([1, 2, 3, 4, 5]), 0)).toBe(0)
  })

  it('reselects after a seek without losing completion or the cost estimate', () => {
    const scheduler = createBeatSchedulingController(240, playback(), 0)
    scheduler.seedWorkDuration(3000)
    const completed = new Set([0, 1, 7])
    scheduler.updatePlayback(playback({ timeSeconds: 170, seeking: true }), 1000)
    expect(scheduler.next(windows(), completed, 2000)).toBeNull()
    scheduler.updatePlayback(playback({ timeSeconds: 130 }), 3000)
    expect(scheduler.next(windows(), completed, 3000)).toBe(5)
    expect(completed).toEqual(new Set([0, 1, 7]))
    expect(scheduler.estimatedWorkMs).toBe(3000)
  })

  it('handles ten-second DSP windows, a short tail and fully elapsed playback', () => {
    const scheduler = createBeatSchedulingController(45, playback({ timeSeconds: 25 }), 0)
    scheduler.seedWorkDuration(500)
    expect(scheduler.next(windows(45, 10), new Set(), 0)).toBe(2)
    scheduler.updatePlayback(playback({ timeSeconds: 44.8 }), 0)
    expect(scheduler.next(windows(45, 10), new Set([0, 1, 2, 3]), 0)).toBe(4)
    expect(scheduler.next(windows(45, 10), new Set([4]), 1000)).toBe(3)
    const short = createBeatSchedulingController(0.1, playback(), 0)
    short.seedWorkDuration(10000)
    expect(short.next(windows(0.1), new Set(), 0)).toBe(0)
  })

  it('returns original indices for unsorted ranges and skips empty or invalid regions', () => {
    const ranges = [
      { startSeconds: 30, endSeconds: 40 },
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 10, endSeconds: 10 },
      { startSeconds: Number.NaN, endSeconds: 20 },
      { startSeconds: 10, endSeconds: 20 },
      { startSeconds: 50, endSeconds: 60 },
      { startSeconds: -Infinity, endSeconds: 40 },
      { startSeconds: 0, endSeconds: Infinity },
    ]
    const scheduler = createBeatSchedulingController(40, playback({ timeSeconds: 12 }), 0)
    scheduler.seedWorkDuration(2000)
    expect(scheduler.next(ranges, new Set(), 0)).toBe(4)
    expect(scheduler.next(ranges, new Set([4]), 0)).toBe(0)
    expect(ranges[0]!.startSeconds).toBe(30)
  })

  it('eventually fills every hole even when work is slower than playback', () => {
    const scheduler = createBeatSchedulingController(240, playback(), 0)
    scheduler.seedWorkDuration(45000)
    const completed = new Set<number>()
    const order: number[] = []
    let now = 0
    for (;;) {
      const selected = scheduler.next(windows(), completed, now)
      if (selected === null) break
      expect(completed.has(selected)).toBe(false)
      completed.add(selected)
      order.push(selected)
      scheduler.observeWorkDuration(45000)
      now += 45000
    }
    expect(order).toHaveLength(10)
    expect(new Set(order).size).toBe(10)
    expect(order[0]).toBe(1)
  })
})
