import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  parseLyrics,
  splitLyricTranslation,
  isInstrumentalPlaceholder,
  hasMeaningfulLyrics,
  findActiveLyricIndex,
} from '../../utils/lyrics'
import type { LyricLine } from '../../types/music'

describe('splitLyricTranslation', () => {
  it('无尾括号时 translation 为 undefined', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.trim().endsWith(')')),
        (s) => {
          expect(splitLyricTranslation(s).translation).toBeUndefined()
        },
      ),
    )
  })
  it('配对括号拆出译文', () => {
    expect(splitLyricTranslation('Hello (你好)')).toEqual({ text: 'Hello', translation: '你好' })
  })
  it('括号内容为空则不拆分', () => {
    expect(splitLyricTranslation('Hello ()')).toEqual({ text: 'Hello ()' })
  })
})

describe('isInstrumentalPlaceholder 各分支', () => {
  it.each([
    ['纯音乐', true],
    ['纯音乐，请欣赏', true],
    ['instrumental', true],
    ['暂无歌词', true],
    ['无歌词', true],
    ['本节目暂无字幕', true],
    ['这是一句真的歌词', false],
    ['', false],
  ])('%s -> %s', (input, expected) => {
    expect(isInstrumentalPlaceholder(input)).toBe(expected)
  })
})

describe('parseLyrics 排序不变量', () => {
  it('有时间戳的输出恒按 time 升序', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            m: fc.integer({ min: 0, max: 99 }),
            s: fc.integer({ min: 0, max: 59 }),
            ms: fc.integer({ min: 0, max: 999 }),
            text: fc.string({ minLength: 1 }).filter((t) => /\S/.test(t) && !t.includes('[')),
          }),
          { minLength: 1 },
        ),
        (rows) => {
          const src = rows
            .map((r) => `[${r.m}:${String(r.s).padStart(2, '0')}.${r.ms}]${r.text}`)
            .join('
')
          const parsed = parseLyrics(src)
          for (let i = 1; i < parsed.length; i++) {
            expect((parsed[i].time ?? 0) >= (parsed[i - 1].time ?? 0)).toBe(true)
          }
        },
      ),
    )
  })

  it('metadata 行被跳过', () => {
    const parsed = parseLyrics('[ti:标题]
[ar:歌手]
[00:01.00]真的歌词')
    expect(parsed).toHaveLength(1)
    expect(parsed[0].text).toBe('真的歌词')
  })

  it('无时间戳时回落为 plain（time 为 null）', () => {
    const parsed = parseLyrics('第一行
第二行')
    expect(parsed.every((l) => l.time === null)).toBe(true)
    expect(parsed).toHaveLength(2)
  })

  it('小数毫秒：1 位、2 位、3 位分别正确换算', () => {
    expect(parseLyrics('[00:00.5]a')[0].time).toBeCloseTo(0.5, 5)
    expect(parseLyrics('[00:00.05]a')[0].time).toBeCloseTo(0.05, 5)
    expect(parseLyrics('[00:00.005]a')[0].time).toBeCloseTo(0.005, 5)
  })
})

describe('findActiveLyricIndex 二分正确性', () => {
  it('返回的 index 满足 time<=currentTime< 下一行 time', () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.double({ min: 0, max: 1000, noNaN: true }), { minLength: 1, maxLength: 30 })
          .map((arr) => [...arr].sort((a, b) => a - b)),
        fc.double({ min: -10, max: 1010, noNaN: true }),
        (times, current) => {
          const lines: LyricLine[] = times.map((t) => ({ time: t, text: 'x' }))
          const idx = findActiveLyricIndex(lines, current)
          if (idx === -1) {
            expect(current < (lines[0].time ?? 0)).toBe(true)
          } else {
            expect((lines[idx].time ?? 0) <= current).toBe(true)
            if (idx + 1 < lines.length) {
              expect(current < (lines[idx + 1].time ?? 0)).toBe(true)
            }
          }
        },
      ),
    )
  })
})

describe('hasMeaningfulLyrics', () => {
  it('全为占位/署名时返回 false', () => {
    expect(hasMeaningfulLyrics([{ time: null, text: '纯音乐' }])).toBe(false)
    expect(hasMeaningfulLyrics([{ time: null, text: '作词：某人' }])).toBe(false)
  })
  it('存在真实歌词时返回 true', () => {
    expect(hasMeaningfulLyrics([{ time: 1, text: '真的歌词' }])).toBe(true)
  })
})
