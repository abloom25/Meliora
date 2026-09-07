import { describe, expect, it } from 'vitest'
import {
  lineWeight,
  mergeLyricTranslations,
  mergeSyllablesIntoWords,
  resolveLyricTimings,
  tokenizeLyricText,
  wordFillProgress,
} from '../utils/lyrics'
import type { LyricLine } from '../types/music'

describe('tokenizeLyricText', () => {
  it('splits CJK per character and latin per word', () => {
    expect(tokenizeLyricText('你好 world').map((token) => token.text)).toEqual([
      '你',
      '好',
      'world',
    ])
  })

  it('marks the token before a space so the original spacing can be restored', () => {
    const tokens = tokenizeLyricText('hello world')

    expect(tokens[0]?.trailingSpace).toBe(true)
    expect(tokens[1]?.trailingSpace).toBe(false)
  })

  it('attaches punctuation to the syllable in front of it', () => {
    expect(tokenizeLyricText('好,走').map((token) => token.text)).toEqual(['好,', '走'])
  })

  it('keeps leading punctuation as its own low-weight token', () => {
    const tokens = tokenizeLyricText('「走')

    expect(tokens[0]?.text).toBe('「')
    expect(tokens[0]?.weight).toBeLessThan(tokens[1]!.weight)
  })

  it('weights longer latin words higher but caps the range', () => {
    expect(lineWeight('a')).toBeLessThan(lineWeight('beautiful'))
    expect(lineWeight('supercalifragilisticexpialidocious')).toBeLessThan(4)
  })

  it('returns nothing for an empty string', () => {
    expect(tokenizeLyricText('   ')).toEqual([])
  })
})

describe('mergeSyllablesIntoWords', () => {
  it('merges latin syllables of one word but keeps CJK characters separate', () => {
    const merged = mergeSyllablesIntoWords([
      { time: 0, duration: 0.2, text: 'beau' },
      { time: 0.2, duration: 0.2, text: 'ti' },
      { time: 0.4, duration: 0.3, text: 'ful', trailingSpace: true },
      { time: 0.7, duration: 0.3, text: 'day' },
    ])

    expect(merged.map((word) => word.text)).toEqual(['beautiful', 'day'])
    expect(merged[0]?.trailingSpace).toBe(true)
  })

  it('spans the merged word across all of its syllables', () => {
    const merged = mergeSyllablesIntoWords([
      { time: 1, duration: 0.2, text: 'to' },
      { time: 1.2, duration: 0.5, text: 'day' },
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.time).toBeCloseTo(1, 5)
    expect(merged[0]?.duration).toBeCloseTo(0.7, 5)
  })

  it('never merges across a space', () => {
    const merged = mergeSyllablesIntoWords([
      { time: 0, duration: 0.3, text: 'go', trailingSpace: true },
      { time: 0.3, duration: 0.3, text: 'on' },
    ])

    expect(merged.map((word) => word.text)).toEqual(['go', 'on'])
  })

  it('keeps every CJK character as its own unit', () => {
    const merged = mergeSyllablesIntoWords([
      { time: 0, duration: 0.3, text: '你' },
      { time: 0.3, duration: 0.3, text: '好' },
    ])

    expect(merged.map((word) => word.text)).toEqual(['你', '好'])
  })

  it('does not mutate the input syllables', () => {
    const source = [
      { time: 0, duration: 0.2, text: 'a' },
      { time: 0.2, duration: 0.2, text: 'go' },
    ]
    mergeSyllablesIntoWords(source)

    expect(source[0]?.text).toBe('a')
    expect(source[0]?.duration).toBeCloseTo(0.2, 5)
  })
})

describe('resolveLyricTimings', () => {
  const lines: LyricLine[] = [
    { time: 0, text: '第一行' },
    { time: 2, text: '第二行' },
    { time: 4, text: '第三行' },
  ]

  it('fills in end times but never invents a word timeline', () => {
    const resolved = resolveLyricTimings(lines)

    expect(resolved[0]?.endTime).toBeCloseTo(2, 5)
    // 没有真实逐字数据的行不做插值合成:猜出来的扫光在长拖音上必然对不上
    expect(resolved[0]?.words).toBeUndefined()
    expect(resolved[0]?.wordSource).toBeUndefined()
  })

  it('keeps native syllables untouched and only adds the end time', () => {
    const native: LyricLine[] = [
      {
        time: 0,
        text: 'hi',
        wordSource: 'native',
        words: [{ time: 0, duration: 0.5, text: 'hi' }],
      },
      { time: 4, text: 'next' },
    ]
    const resolved = resolveLyricTimings(native)

    expect(resolved[0]?.wordSource).toBe('native')
    expect(resolved[0]?.words).toEqual(native[0]?.words)
    expect(resolved[0]?.endTime).toBeCloseTo(0.5, 5)
    expect(resolved[1]?.words).toBeUndefined()
  })

  it('does not stretch a line across an instrumental break', () => {
    // 间奏前的最后一行不能把扫光拉成一整段空转:
    // 时长按这首歌自身的演唱速率估算,而不是直接用到下一行的间隔
    const withGap: LyricLine[] = [
      { time: 0, text: '一二三四' },
      { time: 2, text: '五六七八' },
      { time: 4, text: '九十十一' },
      { time: 60, text: '间奏之后' },
    ]
    const resolved = resolveLyricTimings(withGap)

    expect(resolved[2]?.endTime).toBeLessThan(12)
    expect(resolved[2]?.endTime).toBeGreaterThan(4)
  })

  it('leaves untimed plain lyrics alone', () => {
    const plain: LyricLine[] = [{ time: null, text: 'no timing' }]

    expect(resolveLyricTimings(plain)).toBe(plain)
  })
})

describe('mergeLyricTranslations', () => {
  it('pulls translations onto matching lines by time', () => {
    const primary: LyricLine[] = [
      { time: 1, text: 'one' },
      { time: 5, text: 'two' },
    ]
    const donor: LyricLine[] = [
      { time: 1.05, text: 'one', translation: '一' },
      { time: 5.2, text: 'two', translation: '二' },
    ]

    expect(mergeLyricTranslations(primary, donor).map((line) => line.translation)).toEqual([
      '一',
      '二',
    ])
  })

  it('ignores donors that are too far away in time', () => {
    const primary: LyricLine[] = [{ time: 1, text: 'one' }]
    const donor: LyricLine[] = [{ time: 9, text: 'other', translation: '九' }]

    expect(mergeLyricTranslations(primary, donor)[0]?.translation).toBeUndefined()
  })

  it('never overwrites an existing translation', () => {
    const primary: LyricLine[] = [{ time: 1, text: 'one', translation: 'keep' }]
    const donor: LyricLine[] = [{ time: 1, text: 'one', translation: 'replace' }]

    expect(mergeLyricTranslations(primary, donor)[0]?.translation).toBe('keep')
  })

  it('returns the input untouched when the donor has no translations', () => {
    const primary: LyricLine[] = [{ time: 1, text: 'one' }]

    expect(mergeLyricTranslations(primary, [{ time: 1, text: 'one' }])).toBe(primary)
  })
})

describe('word envelopes', () => {
  const word = { time: 10, duration: 0.5, text: '啊' }

  it('reports fill progress clamped to the syllable window', () => {
    expect(wordFillProgress(9.9, word)).toBe(0)
    expect(wordFillProgress(10.25, word)).toBeCloseTo(0.5, 5)
    expect(wordFillProgress(99, word)).toBe(1)
  })

  it('treats a zero-length syllable as instantly full', () => {
    expect(wordFillProgress(5, { time: 5, duration: 0, text: 'x' })).toBe(1)
  })

  it('does not let a harmony line cut short the line it belongs to', () => {
    const withHarmony: LyricLine[] = [
      {
        time: 0,
        text: 'main',
        wordSource: 'native',
        words: [{ time: 0, duration: 3, text: 'main' }],
      },
      { time: 0.2, text: 'ooh', background: true },
      { time: 8, text: 'next' },
    ]
    const resolved = resolveLyricTimings(withHarmony)

    // 和声在 0.2s 起,但它属于主行,不能把主行的结束时间截到 0.2s
    expect(resolved[0]?.endTime).toBeCloseTo(3, 5)
  })
})
