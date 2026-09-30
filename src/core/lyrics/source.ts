import type { LyricLine } from '../types'
import { hasMeaningfulLyrics, parseLyrics, resolveLyricTimings } from './lyrics'
import { parseTtmlLyrics } from './ttml'
import { looksLikeWordTimedLyrics, parseWordTimedLyrics } from './yrc'

// 歌词格式分发层。歌词文件的扩展名不可靠(后台上传的 .lrc 里可能是 QRC,
// Meting 返回的也可能是增强型 LRC),统一按内容特征选解析器。
// 单独成文件是为了避免 lyrics.ts ↔ lyrics-ttml.ts 的循环依赖。

export type LyricSourceFormat = 'ttml' | 'word-timed' | 'lrc'

export function detectLyricFormat(source: string): LyricSourceFormat {
  const head = source.slice(0, 4096)
  if (/<tt[\s>]/.test(head) || /<\/tt>/.test(source)) return 'ttml'
  if (looksLikeWordTimedLyrics(head)) return 'word-timed'
  return 'lrc'
}

/**
 * 解析任意支持的歌词文本并补齐逐字时间轴。
 * 返回空数组表示没有可用歌词(纯占位、演职员表、解析失败)。
 */
export function parseAnyLyrics(source: string, trackDuration?: number): LyricLine[] {
  const format = detectLyricFormat(source)
  let lines: LyricLine[] = []

  if (format === 'ttml') lines = parseTtmlLyrics(source)
  else if (format === 'word-timed') lines = parseWordTimedLyrics(source)

  // 专用解析器解析不出内容时回退到 LRC:有些源会在 TTML 外壳里塞纯文本
  if (!lines.length) lines = parseLyrics(source)
  if (!hasMeaningfulLyrics(lines)) return []

  return resolveLyricTimings(lines, trackDuration)
}
