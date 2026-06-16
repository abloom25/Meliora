import type { LyricLine } from '../types/music'

const timestampPattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?(?:-\d+)?\]/g
const metadataPattern = /^\[(ar|al|ti|by|offset|re|ve):/i
const creditPattern = /^(?:作词|填词|词|作曲|曲|编曲|制作人|制作|监制|混音|母带|录音|人声|演唱|和声|吉他|贝斯|鼓|弦乐|键盘|钢琴|笛子|二胡|发行|出品|版权|op|sp|lyrics?|lyricist|composer|composed\s+by|arranger|arranged\s+by|producer|produced\s+by|mix(?:ed)?\s+by|master(?:ed)?\s+by|record(?:ed)?\s+by|vocal(?:s)?|written\s+by)\s*[:：]/i
const roleLabelPattern = /^[\p{Script=Han}a-z\d\s·.&/]{1,12}\s*[:：]$/iu
const emptyLyricPattern = /^[\s()[\]{}（）【】<>《》"'“”‘’.,，。!！?？、~～…·:：;；_\-—|/\\]*$/u

function fractionToMilliseconds(value = ''): number {
  if (!value) return 0
  if (value.length === 1) return Number(value) * 100
  if (value.length === 2) return Number(value) * 10
  return Number(value.slice(0, 3))
}

export function splitLyricTranslation(value: string): {
  text: string
  translation?: string
} {
  const text = value.trim()
  if (!text.endsWith(')')) return { text }

  let depth = 0
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text[index]
    if (character === ')') {
      depth += 1
      continue
    }
    if (character !== '(') continue
    depth -= 1
    if (depth < 0) return { text }
    if (depth !== 0) continue

    const mainText = text.slice(0, index).trim()
    const translation = text.slice(index + 1, -1).trim()
    if (!mainText || !translation) return { text }
    return { text: mainText, translation }
  }
  return { text }
}

function cleanLyricPart(value: string): string {
  const cleaned = value
    .replace(/\u200B/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return emptyLyricPattern.test(cleaned) ? '' : cleaned
}

function cleanLyric(value: string): {
  text: string
  translation?: string
} | null {
  const withoutEmptySuffix = value
    .replace(/\(\s*\)\s*$/u, '')
    .replace(/（\s*）\s*$/u, '')
    .trim()
  const lyric = splitLyricTranslation(withoutEmptySuffix)
  const text = cleanLyricPart(lyric.text)
  const translation = lyric.translation ? cleanLyricPart(lyric.translation) : ''
  if (!text) return null
  return translation ? { text, translation } : { text }
}

export function parseLyrics(source: string): LyricLine[] {
  const timed: LyricLine[] = []
  const plain: LyricLine[] = []

  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || metadataPattern.test(line)) continue

    const timestamps = [...line.matchAll(timestampPattern)]
    const rawText = line.replace(timestampPattern, '').trim()

    if (timestamps.length) {
      if (!rawText) continue
      const lyric = cleanLyric(rawText)
      if (!lyric) continue
      for (const match of timestamps) {
        const minutes = Number(match[1])
        const seconds = Number(match[2])
        timed.push({
          time: minutes * 60 + seconds + fractionToMilliseconds(match[3]) / 1000,
          ...lyric,
        })
      }
    } else {
      const lyric = cleanLyric(line)
      if (lyric) plain.push({ time: null, ...lyric })
    }
  }

  if (timed.length) return timed.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  return plain
}

function normalizeLyricMessage(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s,，。.!！?？、~～…·:：;；'"“”‘’()[\]{}（）【】<>《》_\-—]/g, '')
}

export function isInstrumentalPlaceholder(value: string): boolean {
  const normalized = normalizeLyricMessage(value)
  if (!normalized) return false

  return normalized === '纯音乐'
    || (normalized.includes('纯音乐') && normalized.includes('欣赏'))
    || normalized === 'instrumental'
    || normalized === '暂无歌词'
    || normalized === '无歌词'
    || normalized === '本节目暂无字幕'
}

function isCreditLine(line: LyricLine): boolean {
  const text = line.text.trim()
  if (creditPattern.test(text) || roleLabelPattern.test(text)) return true

  const combined = line.translation ? `${text} ${line.translation}` : text
  return creditPattern.test(combined)
}

export function hasMeaningfulLyrics(lines: LyricLine[]): boolean {
  return lines.some((line) => {
    if (isCreditLine(line)) return false
    if (isInstrumentalPlaceholder(line.text)) return false
    if (line.translation && isInstrumentalPlaceholder(line.translation)) return false
    return Boolean(line.text.trim())
  })
}

export function findActiveLyricIndex(lines: LyricLine[], currentTime: number): number {
  let low = 0
  let high = lines.length - 1
  let active = -1

  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const time = lines[middle]?.time
    if (time === null || time === undefined || time > currentTime) {
      high = middle - 1
    } else {
      active = middle
      low = middle + 1
    }
  }
  return active
}
