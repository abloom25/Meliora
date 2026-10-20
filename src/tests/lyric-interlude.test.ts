import { describe, expect, it } from 'vitest'
import { createLyricWaitingTimeline } from '../core/lyrics/interlude'
import { createLyricTimeline } from '../core/lyrics/scene'
import type { LyricLine } from '../core/types'

describe('createLyricWaitingTimeline', () => {
  it('shows a bounded intro with deterministic media-time progress and a stable interval identity', () => {
    const timeline = createLyricWaitingTimeline([{ time: 6, endTime: 8, text: 'First phrase' }])
    const first = timeline.read(0)!
    expect(first).toEqual({
      interval: { kind: 'intro', start: 0, end: 6, previousAnchor: -1, nextAnchor: 0 },
      progress: 0,
    })
    expect(Object.isFrozen(first.interval)).toBe(true)
    expect(timeline.read(3)).toEqual({ interval: first.interval, progress: 0.5 })
    expect(timeline.read(3)?.interval).toBe(first.interval)
    expect(timeline.read(3)).toEqual(timeline.read(3))
    expect(timeline.read(5.999)?.progress).toBeLessThan(1)
    expect(timeline.read(6)).toBeNull()
    expect(timeline.read(9)).toBeNull()
    expect(timeline.read(0)?.interval).toBe(first.interval)
  })

  it('does not flash for a short intro and accepts the exact three-second threshold', () => {
    for (const start of [0, 0.2, 2.999, 3]) {
      const timeline = createLyricWaitingTimeline([{ time: start, endTime: start + 1, text: 'A' }])
      expect(Boolean(timeline.read(0))).toBe(start >= 3)
    }
  })

  it('starts long interludes immediately at the preceding group end and stops at the next start', () => {
    for (const gap of [6.999, 7, 12]) {
      const lines: LyricLine[] = [
        { time: 0, endTime: 2, text: 'First' },
        { time: 2 + gap, endTime: 4 + gap, text: 'Next' },
      ]
      const timeline = createLyricWaitingTimeline(lines)
      const lyrics = createLyricTimeline(lines)
      expect(timeline.read(1.999)).toBeNull()
      if (gap >= 7) {
        expect(timeline.read(2)).toEqual({
          interval: {
            kind: 'interlude',
            start: 2,
            end: 2 + gap,
            previousAnchor: 0,
            nextAnchor: 1,
          },
          progress: 0,
        })
        expect(timeline.read(2 + gap / 2)?.progress).toBe(0.5)
        expect(lyrics.read(2).highlighted).toEqual([])
      } else {
        expect(timeline.read(2)).toBeNull()
        expect(lyrics.read(2).highlighted).toEqual([0])
      }
      expect(timeline.read(2 + gap)).toBeNull()
    }
  })

  it('uses the union of overlapping voices instead of the end of the latest-starting phrase', () => {
    const timeline = createLyricWaitingTimeline([
      { time: 0, endTime: 12, text: 'Long lead' },
      { time: 2, endTime: 3, text: 'Short response', agent: 'secondary' },
      { time: 20, endTime: 21, text: 'Next phrase' },
    ])
    expect(timeline.read(3)).toBeNull()
    expect(timeline.read(11)).toBeNull()
    expect(timeline.read(12)?.interval).toEqual({
      kind: 'interlude',
      start: 12,
      end: 20,
      previousAnchor: 1,
      nextAnchor: 2,
    })
  })

  it('keeps trailing or delayed harmony inside its main group and never uses it as a separate anchor', () => {
    const timeline = createLyricWaitingTimeline([
      { time: 0, endTime: 1, text: 'Lead' },
      { time: 10, endTime: 12, text: 'Delayed harmony', background: true },
      { time: 20, endTime: 21, text: 'Next lead' },
      { time: 20.5, endTime: 22, text: 'Next harmony', background: true },
    ])
    expect(timeline.read(5)).toBeNull()
    expect(timeline.read(11)).toBeNull()
    expect(timeline.read(12)?.interval).toMatchObject({
      start: 12,
      end: 20,
      previousAnchor: 0,
      nextAnchor: 2,
    })
    expect(timeline.read(22)).toBeNull()
  })

  it('handles unordered input and simultaneous next voices without losing source indices', () => {
    const timeline = createLyricWaitingTimeline([
      { time: 20, endTime: 23, text: 'Later' },
      { time: 0, endTime: 2, text: 'Earlier' },
      { time: 20, endTime: 24, text: 'Other later voice', agent: 'secondary' },
    ])
    expect(timeline.read(10)?.interval).toEqual({
      kind: 'interlude',
      start: 2,
      end: 20,
      previousAnchor: 1,
      nextAnchor: 0,
    })
  })

  it('does not invent internal silence from line starts when end timestamps are missing', () => {
    const timeline = createLyricWaitingTimeline([
      { time: 5, text: 'Only a start timestamp' },
      { time: 30, text: 'Another line' },
      { time: 70, text: 'Last line' },
    ])
    expect(timeline.read(2)?.interval.kind).toBe('intro')
    for (const time of [5, 10, 29, 30, 60, 70, 10000]) expect(timeline.read(time)).toBeNull()
  })

  it('returns no waiting interval for plain lyrics, invalid intervals, or a finished song', () => {
    const fixtures: LyricLine[][] = [
      [],
      [{ time: null, text: 'Plain text' }],
      [{ time: Number.NaN, endTime: 5, text: 'Invalid start' }],
      [{ time: 3, endTime: Number.NaN, text: 'Invalid end' }],
      [{ time: Number.POSITIVE_INFINITY, text: 'Infinite start' }],
      [{ time: 10, endTime: 10, text: 'Zero duration' }],
      [{ time: 10, endTime: 9, text: 'Inverted duration' }],
    ]
    for (const lines of fixtures) {
      const timeline = createLyricWaitingTimeline(lines)
      for (const time of [0, 1, 5, 100]) {
        expect(timeline.read(time)).toBeNull()
        expect(timeline.nextBoundary(time)).toBeNull()
      }
    }
    const ended = createLyricWaitingTimeline([{ time: 0, endTime: 5, text: 'Last phrase' }])
    for (const time of [5, 6, 10000]) expect(ended.read(time)).toBeNull()
  })

  it('uses zero as the intro origin even when irrelevant lyrics finish before media time zero', () => {
    const timeline = createLyricWaitingTimeline([
      { time: -10, endTime: -5, text: 'Before media' },
      { time: 4, endTime: 6, text: 'First audible phrase' },
    ])
    expect(timeline.read(0)?.interval).toEqual({
      kind: 'intro',
      start: 0,
      end: 4,
      previousAnchor: -1,
      nextAnchor: 1,
    })
    expect(timeline.read(-1)).toBeNull()
  })

  it('publishes every wait boundary, including an intro while no lyric is active', () => {
    const timeline = createLyricWaitingTimeline([
      { time: 4, endTime: 6, text: 'First' },
      { time: 14, endTime: 16, text: 'Last' },
    ])
    expect(timeline.nextBoundary(-1)).toBe(0)
    expect(timeline.nextBoundary(0)).toBe(4)
    expect(timeline.nextBoundary(4)).toBe(6)
    expect(timeline.nextBoundary(6)).toBe(14)
    expect(timeline.nextBoundary(14)).toBeNull()
    for (const time of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
      expect(timeline.read(time)).toBeNull()
      expect(timeline.nextBoundary(time)).toBeNull()
    }
  })

  it('is independent of seek history and does not reread lyrics during progress updates', () => {
    let timingReads = 0
    const lines: LyricLine[] = Array.from({ length: 10000 }, (_, index) => ({
      get time() {
        timingReads += 1
        return 4 + index * 12
      },
      get endTime() {
        timingReads += 1
        return 6 + index * 12
      },
      text: `Phrase ${index}`,
    }))
    const timeline = createLyricWaitingTimeline(lines)
    const initialReads = timingReads
    const forward = [2, 7, 20, 38, 90000].map((time) => timeline.read(time))
    for (let index = forward.length - 1; index >= 0; index -= 1) {
      const time = [2, 7, 20, 38, 90000][index]!
      expect(timeline.read(time)).toEqual(forward[index])
      expect(timeline.read(time)?.interval).toBe(forward[index]?.interval)
    }
    const interval = timeline.read(7)?.interval
    for (let frame = 0; frame < 480; frame += 1)
      expect(timeline.read(7 + frame / 60)?.interval).toBe(interval)
    expect(timingReads).toBe(initialReads)
  })
})
