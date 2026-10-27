import { describe, expect, it } from 'vitest'
import { parseLyrics, shiftLyricTimings } from '../core/lyrics'
import type { LyricLine } from '../core/types'

describe('lyric timing offsets', () => {
  it('applies the last valid signed LRC offset to every line, including repeated enhanced timestamps', () => {
    const lines = parseLyrics(
      '[offset:900]\n[00:01.00][00:05.00]<00:01.20>Hel<00:01.60>lo<00:02.00>\n[offset:-200]\n[offset:invalid]',
    )
    expect(lines.map((line) => line.time)).toEqual([1.2, 5.2])
    expect(lines[0]?.words?.[0]?.time).toBeCloseTo(1.4)
    expect(lines[0]?.endTime).toBeCloseTo(2.2)
    expect(lines[1]?.words?.[0]?.time).toBeCloseTo(5.4)
  })

  it('treats positive LRC metadata as advance without clamping negative times', () => {
    const lines = parseLyrics('[offset:1500]\n[00:01.00]First\n[00:02.00]Second')
    expect(lines.map((line) => line.time)).toEqual([-0.5, 0.5])
    expect(parseLyrics('[offset:100]\nPlain words')).toEqual([{ time: null, text: 'Plain words' }])
  })

  it('shifts line, explicit end and words together without mutating caches or durations', () => {
    const lines: LyricLine[] = [
      {
        time: 1,
        endTime: 4,
        text: 'A',
        background: true,
        words: [{ time: 2, duration: 0.5, text: 'A' }],
      },
    ]
    const shifted = shiftLyricTimings(lines, 0.2)
    expect(shifted[0]).toMatchObject({
      time: 1.2,
      endTime: 4.2,
      background: true,
      words: [{ time: 2.2, duration: 0.5 }],
    })
    expect(lines[0]).toMatchObject({ time: 1, endTime: 4, words: [{ time: 2 }] })
    expect(shiftLyricTimings(lines, 0)).toBe(lines)
    expect(shiftLyricTimings(lines, Number.NaN)).toBe(lines)
  })
})
