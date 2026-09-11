import { describe, expect, it } from 'vitest'
import { looksLikeWordTimedLyrics, parseWordTimedLyrics } from '../core/lyrics/yrc'
import { detectLyricFormat, parseAnyLyrics } from '../core/lyrics/source'

const YRC = `{"t":0,"c":[{"tx":"作词: 某人"}]}
[1000,1200](1000,400,0)你(1400,400,0)好(1800,400,0)啊
[3000,900](3000,450,0)世(3450,450,0)界`

const QRC = `[1000,1200]你(1000,400)好(1400,400)啊(1800,400)
[3000,900]世(3000,450)界(3450,450)`

describe('parseWordTimedLyrics', () => {
  it('parses netease YRC into a syllable timeline', () => {
    const lines = parseWordTimedLyrics(YRC)

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ time: 1, text: '你好啊', wordSource: 'native' })
    expect(lines[0]?.words?.map((word) => word.text)).toEqual(['你', '好', '啊'])
    expect(lines[0]?.words?.[0]?.duration).toBeCloseTo(0.4, 5)
    expect(lines[0]?.endTime).toBeCloseTo(2.2, 5)
  })

  it('parses QQ QRC where the text precedes the timing', () => {
    const lines = parseWordTimedLyrics(QRC)

    expect(lines[0]?.text).toBe('你好啊')
    expect(lines[0]?.words?.map((word) => word.time)).toEqual([1, 1.4, 1.8])
  })

  it('skips the JSON credit rows YRC puts in front of the lyrics', () => {
    expect(parseWordTimedLyrics(YRC).every((line) => !line.text.includes('作词'))).toBe(true)
  })

  it('uses the earlier of the line header and the first syllable', () => {
    // 网易的行头时间偶尔比首个音节晚,取更早的那个才不会漏掉起唱
    const lines = parseWordTimedLyrics('[1200,800](1000,400,0)喂(1400,400,0)喂')

    expect(lines[0]?.time).toBeCloseTo(1, 5)
  })

  it('returns an empty array for plain LRC', () => {
    expect(parseWordTimedLyrics('[00:01.00]plain line')).toEqual([])
  })

  it('detects the format from a header sample', () => {
    expect(looksLikeWordTimedLyrics(YRC)).toBe(true)
    expect(looksLikeWordTimedLyrics('[00:01.00]plain')).toBe(false)
  })
})

describe('parseAnyLyrics format dispatch', () => {
  it('routes each source format to its parser', () => {
    expect(detectLyricFormat('<tt xmlns="x"><body/></tt>')).toBe('ttml')
    expect(detectLyricFormat(YRC)).toBe('word-timed')
    expect(detectLyricFormat('[00:01.00]hello')).toBe('lrc')
  })

  it('keeps native word timings from a YRC payload', () => {
    const lines = parseAnyLyrics(YRC)

    expect(lines[0]?.wordSource).toBe('native')
    expect(lines[0]?.words).toHaveLength(3)
  })

  it('falls back to LRC when the dedicated parser finds nothing', () => {
    // 行头长得像 YRC 但没有音节标记:专用解析器交白卷时必须回落到 LRC,
    // 而不是把整首歌判成"无歌词"
    const lines = parseAnyLyrics(
      ['[1000,900]no syllables here', '[00:03.00]actual lrc'].join(String.fromCharCode(10)),
    )

    expect(lines[0]).toMatchObject({ time: 3, text: 'actual lrc' })
  })

  it('drops placeholder lyrics entirely', () => {
    expect(parseAnyLyrics('[00:00.00]纯音乐,请欣赏')).toEqual([])
  })
})
