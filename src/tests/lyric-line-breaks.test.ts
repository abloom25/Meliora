import { describe, expect, it } from 'vitest'
import { balanceLyricBreaks } from '../core/lyrics/line-breaks'

describe('balanced lyric lines', () => {
  it('moves a word from a packed first row to avoid a one-word orphan', () => {
    const words = ['one', 'two', 'three', 'four'].map((text) => ({ text, width: 40, gap: 10 }))
    expect(balanceLyricBreaks(words, 150)).toEqual([2])
    expect(balanceLyricBreaks(words, 200)).toEqual([])
    expect(balanceLyricBreaks(words, 99)).toEqual([2])
  })

  it('preserves an oversized word as one token and avoids punctuation at row start', () => {
    expect(
      balanceLyricBreaks(
        [
          { text: 'unbreakable', width: 250, gap: 10 },
          { text: 'word', width: 30, gap: 0 },
        ],
        100,
      ),
    ).toEqual([1])
    const words = ['你', '好', '，', '世', '界'].map((text) => ({ text, width: 20, gap: 0 }))
    expect(balanceLyricBreaks(words, 60)).toEqual([3])
  })

  it('returns deterministic breaks across resize and bounds work for very long lyrics', () => {
    const words = Array.from({ length: 300 }, () => ({ text: '啊', width: 20, gap: 0 }))
    expect(balanceLyricBreaks(words, 100)).toHaveLength(59)
    expect(balanceLyricBreaks(words, 0)).toEqual([])
    expect(balanceLyricBreaks(words, 200)).toHaveLength(29)
  })
})
