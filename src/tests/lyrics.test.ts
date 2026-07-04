import { describe, expect, it } from 'vitest'
import {
  findActiveLyricIndex,
  hasMeaningfulLyrics,
  isInstrumentalPlaceholder,
  parseLyrics,
  splitLyricTranslation,
} from '../utils/lyrics'

describe('parseLyrics', () => {
  it('parses millisecond timestamps, repeated tags, and sorts lines', () => {
    const result = parseLyrics('[ar:Meliora]\n[00:12.5]Second\n[00:02.250][00:08.25]First')
    expect(result).toEqual([
      { time: 2.25, text: 'First' },
      { time: 8.25, text: 'First' },
      { time: 12.5, text: 'Second' },
    ])
  })

  it('parses extended timestamps with a trailing sequence number', () => {
    expect(
      parseLyrics(['[00:00.00-1] 作曲 : KREZUS/KIXIA', '[00:12.35-2]First lyric'].join('\n')),
    ).toEqual([
      { time: 0, text: '作曲 : KREZUS/KIXIA' },
      { time: 12.35, text: 'First lyric' },
    ])
  })

  it('falls back to plain text lyrics', () => {
    expect(parseLyrics('Line one\nLine two')).toEqual([
      { time: null, text: 'Line one' },
      { time: null, text: 'Line two' },
    ])
  })

  it('removes enhanced LRC inline word timestamps from rendered text', () => {
    expect(parseLyrics('[00:01.00]<00:01.10>Hello <00:01.50>world')).toEqual([
      { time: 1, text: 'Hello world' },
    ])
  })

  it('merges same-timestamp bilingual lines into translation', () => {
    expect(parseLyrics('[00:10.00]Hello\n[00:10.00]你好')).toEqual([
      { time: 10, text: 'Hello', translation: '你好' },
    ])
  })

  it('keeps extra same-timestamp lines when a translation is already present', () => {
    expect(parseLyrics('[00:10.00]Hello (你好)\n[00:10.00]Bonjour')).toEqual([
      { time: 10, text: 'Hello', translation: '你好' },
      { time: 10, text: 'Bonjour' },
    ])
  })

  it('removes empty brackets, punctuation-only lines, and empty translations', () => {
    expect(
      parseLyrics(
        [
          '[00:01.00]()',
          '[00:02.00]【 】',
          '[00:03.00]...',
          '[00:04.00]Actual lyric ()',
          '（）',
          'Plain lyric (translation)',
        ].join('\n'),
      ),
    ).toEqual([{ time: 4, text: 'Actual lyric' }])

    expect(parseLyrics('()\n……\nPlain lyric (translation)')).toEqual([
      { time: null, text: 'Plain lyric', translation: 'translation' },
    ])
  })

  it('finds the active line for playback time', () => {
    const lines = parseLyrics('[00:01]One\n[00:03]Two\n[00:05]Three')
    expect(findActiveLyricIndex(lines, 0.5)).toBe(-1)
    expect(findActiveLyricIndex(lines, 3.2)).toBe(1)
    expect(findActiveLyricIndex(lines, 20)).toBe(2)
  })

  it('extracts only the final balanced translation group', () => {
    expect(splitLyricTranslation('xxx(xx)(xxx(xx))')).toEqual({
      text: 'xxx(xx)',
      translation: 'xxx(xx)',
    })
    expect(splitLyricTranslation('Hold me close (紧紧拥我入怀)')).toEqual({
      text: 'Hold me close',
      translation: '紧紧拥我入怀',
    })
    expect(splitLyricTranslation('Hold me close（紧紧拥我入怀）')).toEqual({
      text: 'Hold me close',
      translation: '紧紧拥我入怀',
    })
    expect(splitLyricTranslation('Unclosed (text')).toEqual({
      text: 'Unclosed (text',
    })
  })

  it('recognizes common instrumental placeholder variants', () => {
    expect(isInstrumentalPlaceholder('纯音乐，请欣赏')).toBe(true)
    expect(isInstrumentalPlaceholder('纯音乐, 请欣赏!')).toBe(true)
    expect(isInstrumentalPlaceholder(' 纯 音 乐……请欣赏～ ')).toBe(true)
    expect(isInstrumentalPlaceholder('Instrumental')).toBe(true)
    expect(isInstrumentalPlaceholder('本节目暂无字幕')).toBe(true)
    expect(isInstrumentalPlaceholder('请欣赏这一段歌词')).toBe(false)
  })

  it('treats credits plus an instrumental placeholder as unavailable lyrics', () => {
    const lines = parseLyrics(
      [
        '[00:00.00]作词：Meliora',
        '[00:01.00]作曲: Meliora',
        '[00:02.00]编曲：Meliora',
        '[00:04.00]纯音乐,请欣赏!',
      ].join('\n'),
    )

    expect(hasMeaningfulLyrics(lines)).toBe(false)
  })

  it('keeps lyrics available when real lyric content follows the credits', () => {
    const lines = parseLyrics(
      [
        '[00:00.00]作词：Meliora',
        '[00:01.00]作曲：Meliora',
        '[00:08.00]Hold me close (紧紧拥我入怀)',
      ].join('\n'),
    )

    expect(hasMeaningfulLyrics(lines)).toBe(true)
    expect(hasMeaningfulLyrics([])).toBe(false)
  })
})
