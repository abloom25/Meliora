import type { LyricWord } from '../types'

const MIN_RISE_SECONDS = 1
const MIN_EMPHASIS_SECONDS = 1
const MAX_EMPHASIS_CHARACTERS = 8
const CHARACTER_STAGGER_RATIO = 0.16
export interface LyricWordMotionContext {
  phraseEnd?: boolean
  background?: boolean
}

function emphasisTail(word: LyricWord, context?: LyricWordMotionContext): number {
  return context?.phraseEnd && hasWordMotion(word) && word.duration >= MIN_EMPHASIS_SECONDS
    ? Math.min(0.36, word.duration * 0.15)
    : 0
}
const graphemeSegmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

function hasWordMotion(word: LyricWord): boolean {
  return (
    Number.isFinite(word.time) &&
    Number.isFinite(word.duration) &&
    word.duration > 0 &&
    Boolean(word.text.trim())
  )
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** 词上浮独立于扫光，短音节也留出至少一秒的舒展时间。单位均为秒。 */
export function lyricWordRise(time: number, word: LyricWord): number {
  if (!Number.isFinite(time) || !hasWordMotion(word)) return 0
  const progress = clampProgress((time - word.time) / Math.max(MIN_RISE_SECONDS, word.duration))
  return 1 - (1 - progress) ** 3
}

/** 调度器需要覆盖扫光结束后仍在继续的上浮；无时长的字不创建额外动画。 */
export function lyricWordMotionEnd(word: LyricWord, context?: LyricWordMotionContext): number {
  return hasWordMotion(word)
    ? word.time + Math.max(MIN_RISE_SECONDS, word.duration + emphasisTail(word, context))
    : word.time
}

/**
 * 只有确有长音时间的短词才拆字强调，不把逐行歌词插值成演唱数据。
 * 保留原始空白与 grapheme 边界，组合字和 emoji 不会被拆成残缺字符。
 */
export function lyricWordCharacters(word: LyricWord): readonly string[] | null {
  if (!hasWordMotion(word) || word.duration < MIN_EMPHASIS_SECONDS) return null
  let characters: string[]
  if (graphemeSegmenter) {
    characters = Array.from(graphemeSegmenter.segment(word.text), ({ segment }) => segment)
  } else {
    // 老运行时无法可靠识别复杂字素时保持完整文本，宁可不强调也不拆坏字符。
    if (
      /(?:\p{Mark}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200d|\ufe0e|\ufe0f)/u.test(word.text)
    )
      return null
    characters = Array.from(word.text)
  }
  const visibleCount = characters.filter((character) => character.trim()).length
  return visibleCount > 0 && visibleCount <= MAX_EMPHASIS_CHARACTERS ? characters : null
}

/**
 * 长音字符的轻微强调：相邻字符错峰抬起、放大后回落。
 * 包络由媒体时间直接求值，暂停、回退和跨段跳转都不需要追赶旧动画。
 */
export function lyricCharacterEmphasis(
  time: number,
  word: LyricWord,
  index: number,
  count: number,
  context?: LyricWordMotionContext,
): number {
  if (
    !Number.isFinite(time) ||
    !hasWordMotion(word) ||
    word.duration < MIN_EMPHASIS_SECONDS ||
    !Number.isInteger(index) ||
    !Number.isInteger(count) ||
    count < 1 ||
    index < 0 ||
    index >= count
  )
    return 0
  const offset = count > 1 ? (index / (count - 1)) * CHARACTER_STAGGER_RATIO : 0
  const duration = word.duration + emphasisTail(word, context)
  const progress = clampProgress(
    (time - word.time - word.duration * offset) / (duration - word.duration * offset),
  )
  if (progress === 0 || progress === 1) return 0
  const strength = (context?.phraseEnd ? 1.15 : 1) * (context?.background ? 1.08 : 1)
  const amount = Math.min(
    1.15,
    Math.min(1, 0.6 + (word.duration - MIN_EMPHASIS_SECONDS) * 0.2) * strength,
  )
  return Math.sin(progress * Math.PI) ** 2 * amount
}

/** Small symmetric expansion, independent of layout width and source word boundaries. */
export function lyricCharacterSpread(emphasis: number, index: number, count: number): number {
  if (!Number.isFinite(emphasis) || emphasis <= 0 || count < 2 || index < 0 || index >= count)
    return 0
  return Math.max(-0.025, Math.min(0.025, (index - (count - 1) / 2) * 0.006 * emphasis))
}
