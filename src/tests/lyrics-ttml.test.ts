import { describe, expect, it } from 'vitest'
import { decodeXmlEntities, parseTtmlLyrics, parseTtmlTime } from '../utils/lyrics-ttml'

const SAMPLE = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/></metadata></head>
<body dur="00:20.000"><div begin="00:01.000" end="00:20.000">
<p begin="00:01.000" end="00:03.000" ttm:agent="v1" itunes:key="L1"><span begin="00:01.000" end="00:01.500">Hello</span> <span begin="00:01.500" end="00:03.000">world</span><span ttm:role="x-translation" xml:lang="zh-CN">你好世界</span><span ttm:role="x-roman">hello world</span></p>
<p begin="00:04.000" end="00:06.000" ttm:agent="v2"><span begin="00:04.000" end="00:05.000">Second</span><span begin="00:05.000" end="00:06.000">voice</span></p>
<p begin="00:07.000" end="00:09.000" ttm:agent="v1"><span begin="00:07.000" end="00:08.000">Main</span><span ttm:role="x-bg" begin="00:08.000" end="00:09.000"><span begin="00:08.000" end="00:08.500">ooh</span><span begin="00:08.500" end="00:09.000">ah</span></span></p>
</div></body></tt>`

describe('parseTtmlTime', () => {
  it('parses clock and offset forms', () => {
    expect(parseTtmlTime('00:01.500')).toBeCloseTo(1.5, 5)
    expect(parseTtmlTime('01:02:03.250')).toBeCloseTo(3723.25, 5)
    expect(parseTtmlTime('2.5s')).toBeCloseTo(2.5, 5)
    expect(parseTtmlTime('340ms')).toBeCloseTo(0.34, 5)
    expect(parseTtmlTime('90')).toBeCloseTo(90, 5)
  })

  it('returns null for unusable values', () => {
    // 帧/刻度需要 tick rate 才能换算,当前歌词源不使用
    expect(parseTtmlTime('12f')).toBeNull()
    expect(parseTtmlTime('not-a-time')).toBeNull()
    expect(parseTtmlTime(undefined)).toBeNull()
    expect(parseTtmlTime('   ')).toBeNull()
  })
})

describe('decodeXmlEntities', () => {
  it('decodes named and numeric references', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#65; &#x42;')).toBe(
      'a & b <c> "d" A B',
    )
  })

  it('leaves unknown entities untouched', () => {
    expect(decodeXmlEntities('&bogus; &amp;')).toBe('&bogus; &')
  })
})

describe('parseTtmlLyrics', () => {
  it('builds a syllable timeline with translation and romanisation', () => {
    const lines = parseTtmlLyrics(SAMPLE)
    const first = lines[0]

    expect(first?.text).toBe('Hello world')
    expect(first?.wordSource).toBe('native')
    expect(first?.translation).toBe('你好世界')
    expect(first?.roman).toBe('hello world')
    expect(first?.endTime).toBeCloseTo(3, 5)
    expect(first?.words?.map((word) => word.text)).toEqual(['Hello', 'world'])
    expect(first?.words?.[0]?.duration).toBeCloseTo(0.5, 5)
    expect(first?.words?.[0]?.trailingSpace).toBe(true)
  })

  it('marks every agent after the first one as the second voice', () => {
    const lines = parseTtmlLyrics(SAMPLE)

    expect(lines[0]?.agent).toBeUndefined()
    expect(lines[1]?.agent).toBe('secondary')
  })

  it('splits background vocals into their own line', () => {
    const lines = parseTtmlLyrics(SAMPLE)
    const background = lines.find((line) => line.background)

    expect(background?.text).toBe('oohah')
    expect(background?.time).toBeCloseTo(8, 5)
    expect(background?.words).toHaveLength(2)
    // 背景和声有独立的音节时间轴,合进主行会打乱扫光顺序
    expect(lines.find((line) => line.text === 'Main')?.words).toHaveLength(1)
  })

  it('returns lines sorted by time', () => {
    const lines = parseTtmlLyrics(SAMPLE)
    const times = lines.map((line) => line.time ?? 0)

    expect([...times].sort((left, right) => left - right)).toEqual(times)
  })

  it('returns an empty array for non-TTML or timeless documents', () => {
    expect(parseTtmlLyrics('[00:01.00]just an lrc line')).toEqual([])
    expect(parseTtmlLyrics('<tt><body><div><p>no timing</p></div></body></tt>')).toEqual([])
  })

  it('decodes entities inside syllables', () => {
    const lines = parseTtmlLyrics(
      '<tt><body><div><p begin="00:00.000" end="00:01.000"><span begin="00:00.000" end="00:00.500">rock</span><span begin="00:00.500" end="00:01.000">&amp;roll</span></p></div></body></tt>',
    )

    expect(lines[0]?.text).toBe('rock&roll')
  })
})
