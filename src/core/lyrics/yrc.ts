import type { LyricLine, LyricWord } from '../types'
import { MIN_WORD_DURATION, joinWords } from './lyrics'

// 网易云 YRC 与 QQ 音乐 QRC 两种逐字歌词格式。两者的行头都是 `[起始ms,时长ms]`,
// 区别只在音节的写法:
//   YRC  [1234,3000](1234,300,0)歌(1534,300,0)词     时间在前,文本在后
//   QRC  [1234,3000]歌(1234,300)词(1534,300)         文本在前,时间在后
// 解析结果统一落到 LyricLine.words,与 TTML / 增强型 LRC 共用同一套渲染。

const LINE_HEADER = /^\[(\d+),(\d+)\]/
// YRC:(start,duration,type) 后跟音节文本
const YRC_WORD = /\((\d+),(\d+),(-?\d+)\)/g
// QRC:音节文本后跟 (start,duration)
const QRC_WORD = /\((\d+),(\d+)\)/g

function toSeconds(milliseconds: number): number {
  return milliseconds / 1000
}

function pushWord(words: LyricWord[], text: string, startMs: number, durationMs: number) {
  const trimmed = text.trim()
  if (!trimmed) return
  const word: LyricWord = {
    time: toSeconds(startMs),
    duration: Math.max(MIN_WORD_DURATION, toSeconds(durationMs)),
    text: trimmed,
  }
  if (/\s$/.test(text)) word.trailingSpace = true
  words.push(word)
}

function parseYrcBody(body: string): LyricWord[] {
  const matches = [...body.matchAll(YRC_WORD)]
  if (!matches.length) return []
  const words: LyricWord[] = []

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const next = matches[index + 1]
    const text = body.slice(match.index + match[0].length, next ? next.index : body.length)
    pushWord(words, text, Number(match[1]), Number(match[2]))
  }

  return words
}

function parseQrcBody(body: string): LyricWord[] {
  const matches = [...body.matchAll(QRC_WORD)]
  if (!matches.length) return []
  const words: LyricWord[] = []
  let cursor = 0

  for (const match of matches) {
    const text = body.slice(cursor, match.index)
    cursor = match.index + match[0].length
    pushWord(words, text, Number(match[1]), Number(match[2]))
  }

  return words
}

/**
 * 解析 YRC / QRC 文本。两种格式自动识别:同一行里 `(` 紧跟在行头之后即为 YRC。
 * 没有任何合法行时返回空数组,由调用方回退到 LRC。
 */
export function parseWordTimedLyrics(source: string): LyricLine[] {
  const lines: LyricLine[] = []

  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    // YRC 把演职员表写成 JSON 行,不是歌词内容
    if (!line || line.startsWith('{')) continue

    const header = LINE_HEADER.exec(line)
    if (!header) continue
    const body = line.slice(header[0].length)
    if (!body.trim()) continue

    // YRC 的音节标记带第三个字段(类型位),QRC 只有两个字段
    const words = /^\s*\(\d+,\d+,-?\d+\)/.test(body) ? parseYrcBody(body) : parseQrcBody(body)
    if (!words.length) continue

    const start = toSeconds(Number(header[1]))
    const duration = toSeconds(Number(header[2]))
    const lastWordEnd = words[words.length - 1].time + words[words.length - 1].duration

    lines.push({
      // 行头时间偶尔比首个音节晚(网易的对齐误差),以更早的那个为准
      time: Math.min(start, words[0].time),
      text: joinWords(words),
      words,
      wordSource: 'native',
      endTime: Math.max(start + duration, lastWordEnd),
    })
  }

  if (!lines.length) return []
  return lines.sort((left, right) => (left.time ?? 0) - (right.time ?? 0))
}

/** 快速判断文本是否是 YRC / QRC,用于在同一个下载结果上选解析器 */
export function looksLikeWordTimedLyrics(source: string): boolean {
  return /^\[\d+,\d+\]/m.test(source)
}
