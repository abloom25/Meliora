import type { LyricLine, LyricWord } from '../types/music'

const timestampPattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?(?:-\d+)?\]/g
const enhancedTimestampPattern = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g
// 增强型 LRC 的内联音节标签,带捕获组供逐字解析使用
const enhancedWordPattern = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g

/** 音节最短时长(秒):零时长音节会让扫光出现除零与瞬间跳变 */
export const MIN_WORD_DURATION = 0.04
// 插值兜底时单位权重对应的估算时长,用于给最后一行和超长间隔封顶
const SECONDS_PER_WEIGHT = 0.42
const metadataPattern = /^\[(ar|al|ti|by|offset|re|ve):/i
const creditPattern =
  /^(?:作词|填词|词|作曲|曲|编曲|制作人|制作|监制|混音|母带|录音|人声|演唱|和声|吉他|贝斯|鼓|弦乐|键盘|钢琴|笛子|二胡|发行|出品|版权|op|sp|lyrics?|lyricist|composer|composed\s+by|arranger|arranged\s+by|producer|produced\s+by|mix(?:ed)?\s+by|master(?:ed)?\s+by|record(?:ed)?\s+by|vocal(?:s)?|written\s+by)\s*[:：]/i
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
  const close = text.endsWith(')') ? ')' : text.endsWith('）') ? '）' : ''
  if (!close) return { text }
  const open = close === ')' ? '(' : '（'

  let depth = 0
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text[index]
    if (character === close) {
      depth += 1
      continue
    }
    if (character !== open) continue
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

function mergeTimedLines(lines: LyricLine[]): LyricLine[] {
  const sorted = lines.sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
  const merged: LyricLine[] = []

  for (const line of sorted) {
    const previous = merged.at(-1)
    const sameTime =
      previous?.time !== null &&
      previous?.time !== undefined &&
      line.time !== null &&
      Math.abs(previous.time - line.time) < 0.001

    if (sameTime && !previous.translation && !line.translation) {
      previous.translation = line.text
      continue
    }

    merged.push(line)
  }

  return merged
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

interface EnhancedBody {
  words: LyricWord[]
  text: string
  endTime: number | null
}

// 增强型 LRC 的内联音节:`[00:12.00]<00:12.00>Hel<00:12.30>lo <00:12.80>world<00:13.40>`
// 每个标签的时间作用于其后的文本,直到下一个标签为止;末尾不带文本的标签是行结束时间。
// 只有两个以上标签才算逐字数据,单个标签通常只是复制行首时间戳的噪声。
function parseEnhancedBody(body: string): EnhancedBody | null {
  const matches = [...body.matchAll(enhancedWordPattern)]
  if (matches.length < 2) return null

  const words: LyricWord[] = []
  let endTime: number | null = null

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    const start = Number(match[1]) * 60 + Number(match[2]) + fractionToMilliseconds(match[3]) / 1000
    const next = matches[index + 1]
    const segment = body.slice(match.index + match[0].length, next ? next.index : body.length)
    const text = segment.replace(/\u200B/g, '').trim()
    if (!text) {
      // 末尾空标签是行结束时间;中间的连续空标签直接跳过
      if (!next) endTime = start
      continue
    }
    const word: LyricWord = { time: start, duration: MIN_WORD_DURATION, text }
    if (/\s$/.test(segment)) word.trailingSpace = true
    words.push(word)
  }

  if (words.length < 2) return null
  sealWordDurations(words, endTime)
  return { words, text: joinWords(words), endTime }
}

/** 用后一个音节的起点回填前一个音节的时长,最后一个音节用行结束时间兜底 */
function sealWordDurations(words: LyricWord[], endTime: number | null) {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const next = words[index + 1]
    const stop = next ? next.time : (endTime ?? word.time + SECONDS_PER_WEIGHT)
    word.duration = Math.max(MIN_WORD_DURATION, stop - word.time)
  }
}

export function joinWords(words: readonly LyricWord[]): string {
  return words
    .map((word) => (word.trailingSpace ? `${word.text} ` : word.text))
    .join('')
    .trim()
}

export function parseLyrics(source: string): LyricLine[] {
  const timed: LyricLine[] = []
  const plain: LyricLine[] = []

  for (const rawLine of source.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || metadataPattern.test(line)) continue

    const timestamps = [...line.matchAll(timestampPattern)]
    const body = line.replace(timestampPattern, '')
    const rawText = body.replace(enhancedTimestampPattern, '').trim()

    if (timestamps.length) {
      if (!rawText) continue
      const enhanced = parseEnhancedBody(body)
      if (enhanced && !cleanLyricPart(enhanced.text)) continue
      const lyric = enhanced ? { text: enhanced.text } : cleanLyric(rawText)
      if (!lyric || !lyric.text) continue
      let baseTime: number | null = null
      for (const match of timestamps) {
        const time =
          Number(match[1]) * 60 + Number(match[2]) + fractionToMilliseconds(match[3]) / 1000
        if (baseTime === null) baseTime = time
        if (!enhanced) {
          timed.push({ time, ...lyric })
          continue
        }
        // 同一行挂多个时间戳(重复段落)时,音节整体平移到该次出现的位置。
        // 基准是第一个行时间戳而不是第一个音节:行标记与首个音节之间通常有起唱间隙,
        // 拿音节当基准会把这段间隙一并抹掉,首次出现的音节时间就被改错了
        const shift = time - baseTime
        timed.push({
          time,
          ...lyric,
          words: enhanced.words.map((word) => ({ ...word, time: word.time + shift })),
          wordSource: 'native',
          ...(enhanced.endTime === null ? {} : { endTime: enhanced.endTime + shift }),
        })
      }
    } else {
      const lyric = cleanLyric(line)
      if (lyric) plain.push({ time: null, ...lyric })
    }
  }

  if (timed.length) return mergeTimedLines(timed)
  return plain
}

function normalizeLyricMessage(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s,，。.!！?？、~～…·:：;；'"“”‘’()[\]{}（）【】<>《》_\-—]/g, '')
}

export function isInstrumentalPlaceholder(value: string): boolean {
  const normalized = normalizeLyricMessage(value)
  if (!normalized) return false

  return (
    normalized === '纯音乐' ||
    (normalized.includes('纯音乐') && normalized.includes('欣赏')) ||
    normalized === 'instrumental' ||
    normalized === '暂无歌词' ||
    normalized === '无歌词' ||
    normalized === '本节目暂无字幕'
  )
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

export interface WeightedToken {
  text: string
  /** 相对权重:决定该 token 在整行时长中占多少比例 */
  weight: number
  trailingSpace: boolean
}

// 表意文字按字计权,拉丁词按词计权。Script 属性必须先判 CJK 再判通用 Letter,
// 因为 \p{Letter} 同样命中汉字
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const WORD_CHAR = /[\p{Letter}\p{Number}'’_-]/u
const WHITESPACE_CHAR = /\s/
// 独立成 token 的标点只占很小的时间片,避免逗号句号吃掉可见的扫光时长
const PUNCTUATION_WEIGHT = 0.2
// 拉丁词权重按字符数线性估算音节数,并做上下封顶
const LATIN_MIN_WEIGHT = 0.8
const LATIN_MAX_WEIGHT = 3.2

function latinWeight(length: number): number {
  return Math.min(LATIN_MAX_WEIGHT, Math.max(LATIN_MIN_WEIGHT, 0.5 + length * 0.34))
}

/** 把一行歌词切成带权重的音节 token,是插值逐字与时长估算的共同基础 */
export function tokenizeLyricText(text: string): WeightedToken[] {
  const tokens: WeightedToken[] = []
  const chars = [...text]
  let index = 0

  while (index < chars.length) {
    const char = chars[index]
    if (WHITESPACE_CHAR.test(char)) {
      const last = tokens.at(-1)
      if (last) last.trailingSpace = true
      index += 1
      continue
    }
    if (CJK_CHAR.test(char)) {
      tokens.push({ text: char, weight: 1, trailingSpace: false })
      index += 1
      continue
    }
    if (WORD_CHAR.test(char)) {
      let word = ''
      while (index < chars.length) {
        const next = chars[index]
        if (!WORD_CHAR.test(next) || CJK_CHAR.test(next)) break
        word += next
        index += 1
      }
      tokens.push({ text: word, weight: latinWeight([...word].length), trailingSpace: false })
      continue
    }
    // 标点并入前一个 token(与 Apple Music 一致:标点跟随它前面的音节一起点亮),
    // 前面已有空格或没有前序 token 时才自成一个低权重 token
    const last = tokens.at(-1)
    if (last && !last.trailingSpace) {
      last.text += char
    } else {
      tokens.push({ text: char, weight: PUNCTUATION_WEIGHT, trailingSpace: false })
    }
    index += 1
  }

  return tokens
}

// 拉丁字母音节:歌词源常把一个英文单词拆成多个音节(beau / ti / ful),
// 但高亮的推进单位应该是"词",中文才是"字"。这里把同一个词的音节合回去
const LATIN_SYLLABLE = /^[A-Za-z'’-]+$/

/**
 * 把字级时间轴上的音节合并成显示用的推进单位:
 * 英文按词、中文按字。合并后该词的时间跨度是它全部音节的首尾,
 * 扫光在整个词上连续推进,而不是一个字母一个字母地跳。
 */
export function mergeSyllablesIntoWords(words: readonly LyricWord[]): LyricWord[] {
  const merged: LyricWord[] = []

  for (const word of words) {
    const previous = merged.at(-1)
    const mergeable =
      previous !== undefined &&
      !previous.trailingSpace &&
      LATIN_SYLLABLE.test(previous.text) &&
      LATIN_SYLLABLE.test(word.text)

    if (mergeable) {
      const end = Math.max(previous.time + previous.duration, word.time + word.duration)
      previous.text += word.text
      previous.duration = Math.max(MIN_WORD_DURATION, end - previous.time)
      if (word.trailingSpace) previous.trailingSpace = true
      continue
    }
    merged.push({ ...word })
  }

  return merged
}

export function lineWeight(text: string): number {
  return tokenizeLyricText(text).reduce((sum, token) => sum + token.weight, 0)
}

// 无法从歌曲自身估算演唱速率时的缺省值(秒/权重),约等于每字 0.42s
const FALLBACK_LINE_GAP_RATIO = 3
const MAX_SYNTHETIC_LINE_SECONDS = 12

/**
 * 估算这首歌自身的演唱速率(秒/权重)。直接用"到下一行的间隔"当行时长,
 * 在间奏前的最后一行会把扫光拉成一整段空转;先用中位间隔剔除间奏,
 * 再用剩余行的实际耗时反推速率,慢歌快歌都能自适应。
 */
function estimateSecondsPerWeight(lines: readonly LyricLine[]): number {
  const samples: Array<{ gap: number; weight: number }> = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]
    const next = lines[index + 1]
    if (line.time === null || next.time === null) continue
    const gap = next.time - line.time
    const weight = lineWeight(line.text)
    if (gap > 0 && weight > 0) samples.push({ gap, weight })
  }
  if (!samples.length) return SECONDS_PER_WEIGHT

  const gaps = samples.map((sample) => sample.gap).sort((left, right) => left - right)
  const median = gaps[Math.floor(gaps.length / 2)]
  const limit = median * FALLBACK_LINE_GAP_RATIO
  let totalGap = 0
  let totalWeight = 0
  for (const sample of samples) {
    if (sample.gap > limit) continue
    totalGap += sample.gap
    totalWeight += sample.weight
  }
  if (totalWeight <= 0) return SECONDS_PER_WEIGHT
  return totalGap / totalWeight
}

/**
 * 补齐每行的结束时间与音节序列,让渲染层拿到的永远是完整的逐字时间轴。
 * 已有真实音节(wordSource === 'native')的行只补结束时间,不覆盖原始数据。
 */
export function resolveLyricTimings(lines: LyricLine[], trackDuration?: number): LyricLine[] {
  if (!lines.length || lines[0].time === null) return lines

  const secondsPerWeight = estimateSecondsPerWeight(lines)

  // 背景和声(x-bg)属于它前面那一句,不能当成"下一行"去截断主行的结束时间
  const nextPrimaryStart = (index: number): number | null => {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor]?.background) continue
      return lines[cursor]?.time ?? null
    }
    return null
  }

  return lines.map((line, index) => {
    const start = line.time
    if (start === null) return line

    const nextStart = line.background ? (lines[index + 1]?.time ?? null) : nextPrimaryStart(index)
    const estimated = Math.min(
      Math.max(lineWeight(line.text) * secondsPerWeight, MIN_WORD_DURATION),
      MAX_SYNTHETIC_LINE_SECONDS,
    )
    // 真实音节的结束时间以最后一个音节为准,否则用估算时长;
    // 两者都不得越过下一行的起点
    const nativeEnd = line.words?.length
      ? Math.max(...line.words.map((word) => word.time + word.duration))
      : null
    const preferredEnd = line.endTime ?? nativeEnd ?? start + estimated
    const hardLimit = nextStart ?? trackDuration ?? start + estimated
    const endTime = Math.max(start + MIN_WORD_DURATION, Math.min(preferredEnd, hardLimit))

    // 只有歌词源自带字级时间轴的行才有 words。没有真实逐字数据时不做插值合成:
    // 猜出来的扫光在长拖音、换气处必然对不上,不如老老实实整行高亮
    if (!line.words?.length) return { ...line, endTime }
    return { ...line, endTime, words: mergeSyllablesIntoWords(line.words) }
  })
}

// 翻译行的时间戳与主歌词几乎一致但不保证精确相等,匹配时给一个容差
const TRANSLATION_MATCH_TOLERANCE = 0.6

/**
 * 把 `donor` 里的翻译补进 `lines` 中缺翻译的行。
 * 逐字歌词库的 TTML 不一定带译文,而同一首歌的 LRC 往往有;
 * 两边按时间就近配对即可把译文接回来,不影响已有译文。
 */
export function mergeLyricTranslations(
  lines: LyricLine[],
  donor: readonly LyricLine[],
): LyricLine[] {
  const candidates = donor.filter(
    (line): line is LyricLine & { time: number } => line.time !== null && Boolean(line.translation),
  )
  if (!candidates.length) return lines

  let cursor = 0
  return lines.map((line) => {
    if (line.translation || line.time === null || line.background) return line
    const time = line.time
    // 两边都按时间升序,用游标线性推进,不需要每行二分
    while (cursor < candidates.length - 1 && candidates[cursor + 1].time <= time) cursor += 1

    let best: (LyricLine & { time: number }) | null = null
    for (
      let index = Math.max(0, cursor - 1);
      index <= Math.min(candidates.length - 1, cursor + 1);
      index += 1
    ) {
      const candidate = candidates[index]
      const distance = Math.abs(candidate.time - time)
      if (distance > TRANSLATION_MATCH_TOLERANCE) continue
      if (!best || distance < Math.abs(best.time - time)) best = candidate
    }

    return best ? { ...line, translation: best.translation } : line
  })
}

// ---- 逐字扫光包络 ----
// 主面板与歌词小窗共用同一套计算,保证两个窗口的扫光完全同相

/** 该音节在给定时刻的演唱进度(0…1) */
export function wordFillProgress(time: number, word: LyricWord): number {
  if (word.duration <= 0) return time >= word.time ? 1 : 0
  const ratio = (time - word.time) / word.duration
  return ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio
}
