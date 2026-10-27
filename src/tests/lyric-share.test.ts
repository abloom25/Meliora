import { describe, expect, it } from 'vitest'
import { lyricShareTime, lyricShareTimeLabel, selectedShareLines } from '../core/lyrics/share'
import type { LyricLine } from '../core/types'

describe('lyric share selection', () => {
  const lines: LyricLine[] = Array.from({ length: 10 }, (_, index) => ({
    text: `Line ${index}`,
    time: index * 5 + 0.25,
    translation: `译文 ${index}`,
  }))

  it('orders by song position, removes duplicates and invalid indices, and caps the card', () => {
    expect(selectedShareLines(lines, [4, 1, 1, NaN, -1, 2.5, 99, 0, 9, 2, 3, 7])).toEqual([
      lines[0],
      lines[1],
      lines[2],
      lines[3],
      lines[4],
      lines[7],
    ])
    expect(selectedShareLines([{ text: '  ', time: 0 }], [0])).toEqual([])
  })

  it('shares the first selected line without losing calibrated subsecond timing', () => {
    expect(lyricShareTime(selectedShareLines(lines, [4, 2]))).toBe(10.25)
    expect(lyricShareTime([{ text: 'Intro', time: -0.1 }])).toBe(0)
  })

  it('does not invent a timestamp for untimed lyrics or invalid times', () => {
    for (const time of [null, NaN, Infinity])
      expect(lyricShareTime([{ text: 'Untimed', time }])).toBeUndefined()
    expect(lyricShareTime([])).toBeUndefined()
  })

  it('formats display time separately from the precise link position', () => {
    expect(lyricShareTimeLabel(80.75)).toBe('1:20')
    expect(lyricShareTimeLabel(0)).toBe('0:00')
    expect(lyricShareTimeLabel(undefined)).toBeUndefined()
  })
})
