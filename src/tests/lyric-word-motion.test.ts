import { describe, expect, it } from 'vitest'
import {
  lyricCharacterEmphasis,
  lyricWordCharacters,
  lyricWordMotionEnd,
  lyricWordRise,
} from '../core/lyrics/word-motion'
import type { LyricWord } from '../core/types'

const short: LyricWord = { time: 2, duration: 0.15, text: 'you' }
const sustained: LyricWord = { time: 4, duration: 2, text: '永远' }

describe('lyric word motion', () => {
  it('lets a short syllable keep rising after its wipe has finished', () => {
    expect(lyricWordRise(2, short)).toBe(0)
    expect(lyricWordRise(2.15, short)).toBeCloseTo(1 - 0.85 ** 3)
    expect(lyricWordRise(2.5, short)).toBeCloseTo(0.875)
    expect(lyricWordRise(3, short)).toBe(1)
    expect(lyricWordMotionEnd(short)).toBe(3)
  })

  it('keeps long-word rise tied to its real duration and supports deterministic seek', () => {
    expect(lyricWordMotionEnd(sustained)).toBe(6)
    expect(lyricWordRise(5, sustained)).toBeCloseTo(0.875)
    expect(lyricWordRise(7, sustained)).toBe(1)
    expect(lyricWordRise(3, sustained)).toBe(0)
    expect(lyricWordRise(5, sustained)).toBeCloseTo(0.875)
  })

  it.each([
    { ...short, duration: 0 },
    { ...short, duration: -1 },
    { ...short, duration: Number.NaN },
    { ...short, time: Number.POSITIVE_INFINITY },
    { ...short, text: ' \n ' },
  ])('does not animate instantaneous, invalid or empty words: $text / $duration', (word) => {
    expect(lyricWordRise(3, word)).toBe(0)
    expect(lyricWordCharacters(word)).toBeNull()
    expect(lyricCharacterEmphasis(3, word, 0, 1)).toBe(0)
  })

  it('only splits sustained short words and keeps all text intact', () => {
    expect(lyricWordCharacters(short)).toBeNull()
    expect(lyricWordCharacters(sustained)).toEqual(['永', '远'])
    const spaced = { ...sustained, text: ' hold ' }
    expect(lyricWordCharacters(spaced)?.join('')).toBe(spaced.text)
    expect(lyricWordCharacters({ ...sustained, text: 'neverending' })).toBeNull()
    expect(lyricWordCharacters({ ...sustained, duration: 0.999 })).toBeNull()
  })

  it('does not split combining accents, joined emoji or country flags', () => {
    expect(lyricWordCharacters({ ...sustained, text: 'e\u0301👩🏽‍🎤🇨🇳' })).toEqual([
      'e\u0301',
      '👩🏽‍🎤',
      '🇨🇳',
    ])
  })

  it('staggers characters while returning all emphasis to zero at the real end', () => {
    expect(lyricCharacterEmphasis(4, sustained, 0, 2)).toBe(0)
    expect(lyricCharacterEmphasis(4.2, sustained, 0, 2)).toBeGreaterThan(0)
    expect(lyricCharacterEmphasis(4.2, sustained, 1, 2)).toBe(0)
    expect(lyricCharacterEmphasis(5, sustained, 0, 2)).toBeCloseTo(0.8)
    expect(lyricCharacterEmphasis(5, sustained, 1, 2)).toBeLessThan(0.8)
    for (const index of [0, 1]) {
      expect(lyricCharacterEmphasis(6, sustained, index, 2)).toBe(0)
      expect(lyricCharacterEmphasis(8, sustained, index, 2)).toBe(0)
      expect(lyricCharacterEmphasis(3, sustained, index, 2)).toBe(0)
    }
  })

  it('bounds long-note emphasis and rejects invalid time or character indices', () => {
    const long = { ...sustained, duration: 20 }
    expect(lyricCharacterEmphasis(14, long, 0, 1)).toBe(1)
    expect(lyricWordRise(Number.NaN, sustained)).toBe(0)
    expect(lyricCharacterEmphasis(Number.NaN, sustained, 0, 1)).toBe(0)
    expect(lyricCharacterEmphasis(5, sustained, -1, 1)).toBe(0)
    expect(lyricCharacterEmphasis(5, sustained, 1, 1)).toBe(0)
    expect(lyricCharacterEmphasis(5, sustained, 0, 0)).toBe(0)
  })
})
