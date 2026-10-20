import type { LyricLine, LyricWord } from '../core/types'
import {
  lyricCharacterEmphasis,
  lyricWordRise,
  wordEdgeSoftness,
  wordFillProgress,
} from '../core/lyrics'

// 逐字扫光。只有当前正在唱的行需要每帧写入;其余行由 CSS 的
// `.lyric-line { --lyric-word-fill: 1 }` 兜底为"整行已唱完"。
// 对唱和和声可同时推进;写入前比对上一次的值,只更新进度发生变化的音节。

export interface LyricsKaraokeOptions {
  getLines: () => readonly LyricLine[]
  getLineElements: () => readonly (HTMLElement | null | undefined)[]
  getLineElement?: (index: number) => HTMLElement | null | undefined
  /**
   * 扫光本身就是动画,关掉「歌词动画」后不该继续跑。必须在 JS 侧拦住:
   * 每帧写入的是内联自定义属性,优先级高于任何 CSS 声明,CSS 关不掉它
   */
  isEnabled: () => boolean
}

interface KaraokeTarget {
  element: HTMLElement
  word: LyricWord
  lastFill: string
  lastEdge: string
  lastRise: string
  characters: Array<{ element: HTMLElement; lastEmphasis: string }>
}

interface KaraokeBinding {
  words: readonly LyricWord[]
  element: HTMLElement | null
  targets: KaraokeTarget[]
}

const NO_WORDS: readonly LyricWord[] = []

export function useLyricsKaraoke(options: LyricsKaraokeOptions) {
  const bindings = new Map<number, KaraokeBinding>()
  let targets: KaraokeTarget[] = []
  let words: readonly LyricWord[] = []
  // 已绑定的活跃行集合(以 "1,2" 形式记),用于判断要不要重绑
  let boundKey: string | null = null

  function releaseTargets(previous: readonly KaraokeTarget[]) {
    for (const target of previous) {
      target.element.style.removeProperty('--lyric-word-fill')
      target.element.style.removeProperty('--lyric-word-edge')
      target.element.style.removeProperty('--lyric-word-rise')
      for (const character of target.characters)
        character.element.style.removeProperty('--lyric-char-emphasis')
    }
  }

  function release() {
    releaseTargets(targets)
    bindings.clear()
    targets = []
    words = []
    boundKey = null
  }

  /** 逐行复用绑定,暂未挂载的和声不影响已经挂载的主句。 */
  function reconcile(active: readonly number[]) {
    const key = active.join(',')
    // 释放内联属性后整行回落到 CSS 的 --lyric-word-fill: 1,
    // 表现为整行一次性高亮,和没有逐字数据的行一致
    if (!options.isEnabled()) {
      if (bindings.size) release()
      boundKey = key
      return
    }
    const lines = options.getLines()
    const elements = options.getLineElement ? [] : options.getLineElements()
    let changed = boundKey !== key
    if (changed) {
      const activeSet = new Set(active)
      for (const [index, binding] of bindings) {
        if (activeSet.has(index)) continue
        releaseTargets(binding.targets)
        bindings.delete(index)
      }
    }
    for (const index of active) {
      const lineWords = lines[index]?.words ?? NO_WORDS
      const element =
        (lineWords.length
          ? options.getLineElement
            ? options.getLineElement(index)
            : elements[index]
          : null) ?? null
      const previous = bindings.get(index)
      if (
        previous?.words === lineWords &&
        previous.element === element &&
        previous.targets.length === lineWords.length &&
        previous.targets.every(
          (target, wordIndex) =>
            target.element.isConnected &&
            target.word === lineWords[wordIndex] &&
            target.element.childElementCount === target.characters.length &&
            target.characters.every((character) => character.element.isConnected),
        )
      )
        continue

      if (previous) releaseTargets(previous.targets)
      const next: KaraokeTarget[] = []
      const spans = element?.isConnected
        ? element.querySelectorAll<HTMLElement>('.lyric-word')
        : null
      if (spans?.length === lineWords.length) {
        for (const [wordIndex, word] of lineWords.entries()) {
          const element = spans[wordIndex]!
          next.push({
            element,
            word,
            lastFill: '',
            lastEdge: '',
            lastRise: '',
            characters: Array.from(
              element.querySelectorAll<HTMLElement>('.lyric-char'),
              (element) => ({
                element,
                lastEmphasis: '',
              }),
            ),
          })
        }
      }
      bindings.set(index, { words: lineWords, element, targets: next })
      changed = true
    }
    if (changed) {
      targets = active.flatMap((index) => bindings.get(index)?.targets ?? [])
      // 调度依据歌词时间轴,不依赖 Vue 是否已把全部 active 行挂载到 DOM。
      words = active.flatMap((index) => bindings.get(index)?.words ?? NO_WORDS)
    }
    boundKey = key
  }

  /** 显式重测后接管当前节点,并允许用冻结的媒体时钟重写进度。 */
  function bind(active: readonly number[]) {
    release()
    reconcile(active)
  }

  /**
   * 检查每个活跃声部的节点与歌词数据;虚拟列表只替换后续声部或音节时,
   * 首个音节可能仍连接在文档中。稳定帧不重复查询音节或清除内联样式。
   */
  function ensure(active: readonly number[]) {
    reconcile(active)
  }

  function write(time: number) {
    if (!options.isEnabled()) {
      release()
      return
    }
    if (!Number.isFinite(time)) return
    for (const target of targets) {
      const progress = wordFillProgress(time, target.word)
      const fill = progress.toFixed(3)
      if (fill !== target.lastFill) {
        target.lastFill = fill
        target.element.style.setProperty('--lyric-word-fill', fill)
      }
      const edge = wordEdgeSoftness(progress).toFixed(3)
      if (edge !== target.lastEdge) {
        target.lastEdge = edge
        target.element.style.setProperty('--lyric-word-edge', edge)
      }
      const rise = lyricWordRise(time, target.word).toFixed(3)
      if (rise !== target.lastRise) {
        target.lastRise = rise
        target.element.style.setProperty('--lyric-word-rise', rise)
      }
      for (const [index, character] of target.characters.entries()) {
        const emphasis = character.element.textContent?.trim()
          ? lyricCharacterEmphasis(time, target.word, index, target.characters.length).toFixed(3)
          : '0.000'
        if (emphasis !== character.lastEmphasis) {
          character.lastEmphasis = emphasis
          character.element.style.setProperty('--lyric-char-emphasis', emphasis)
        }
      }
    }
  }

  return { bind, ensure, write, release, getWords: () => words }
}
