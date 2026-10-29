import type { LyricLine, LyricWord } from '../../core/types'
import { lyricCharacterEmphasis, lyricWordRise, wordEdgeSoftness } from '../../core/lyrics'
import {
  lyricCharacterSpread,
  lyricWordMotionEnd,
  type LyricWordMotionContext,
} from '../../core/lyrics/word-motion'
import { bindLyricSweep, type LyricSweepBinding } from './lyric-sweep'
import {
  createLyricBrightness,
  LYRIC_BRIGHTNESS_SETTLE_MS,
  type LyricBrightness,
} from './lyric-brightness'

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
  sweep: LyricSweepBinding
  sweepIndex: number
  lastFill: string
  lastEdge: string
  lastRise: string
  settledSide: 'before' | 'after' | null
  motion: LyricWordMotionContext
  motionEnd: number
  characters: Array<{
    element: HTMLElement
    visible: boolean
    lastEmphasis: string
    lastSpread: string
  }>
}

interface KaraokeBinding {
  words: readonly LyricWord[]
  element: HTMLElement | null
  content: HTMLElement | null
  targets: KaraokeTarget[]
  observer: MutationObserver | null
  dirty: boolean
}

const NO_WORDS: readonly LyricWord[] = []

export function createLyricKaraoke(options: LyricsKaraokeOptions) {
  const bindings = new Map<number, KaraokeBinding>()
  const brightness = new Map<number, { element: HTMLElement; layer: LyricBrightness }>()
  const retiring = new Map<
    number,
    { binding: KaraokeBinding; cancelTimer: () => void; frozenAt: number }
  >()
  let lastTime = 0
  let targets: KaraokeTarget[] = []
  let words: readonly LyricWord[] = []
  // 已绑定的活跃行集合(以 "1,2" 形式记),用于判断要不要重绑
  let boundKey: string | null = null

  function releaseTargets(previous: readonly KaraokeTarget[]) {
    for (const sweep of new Set(previous.map((target) => target.sweep))) sweep.clear()
    for (const target of previous) {
      target.element.style.removeProperty('--lyric-word-fill')
      target.element.style.removeProperty('--lyric-word-edge')
      target.element.style.removeProperty('--lyric-word-rise')
      for (const character of target.characters) {
        character.element.style.removeProperty('--lyric-char-emphasis')
        character.element.style.removeProperty('--lyric-char-spread')
      }
    }
  }

  function release() {
    releaseTargets(targets)
    for (const binding of bindings.values()) binding.observer?.disconnect()
    for (const entry of retiring.values()) {
      entry.cancelTimer()
      releaseTargets(entry.binding.targets)
      entry.binding.observer?.disconnect()
    }
    retiring.clear()
    for (const entry of brightness.values()) entry.layer.dispose()
    brightness.clear()
    bindings.clear()
    targets = []
    words = []
    boundKey = null
  }

  /** 逐行复用绑定,暂未挂载的和声不影响已经挂载的主句。 */
  function reconcile(active: readonly number[], remeasure = false) {
    const key = active.join(',')
    // 释放内联属性后整行回落到 CSS 的 --lyric-word-fill: 1,
    // 表现为整行一次性高亮,和没有逐字数据的行一致
    if (!options.isEnabled()) {
      if (bindings.size || retiring.size || brightness.size) release()
      boundKey = key
      return
    }
    const lines = options.getLines()
    const elements = options.getLineElement ? [] : options.getLineElements()
    for (const [index, entry] of retiring) {
      if (
        entry.binding.element?.isConnected &&
        (!options.getLineElement || options.getLineElement(index) === entry.binding.element)
      )
        continue
      entry.cancelTimer()
      releaseTargets(entry.binding.targets)
      entry.binding.observer?.disconnect()
      retiring.delete(index)
      brightness.get(index)?.layer.dispose()
      brightness.delete(index)
    }
    for (const [index, entry] of brightness) {
      if (!entry.element.isConnected || !entry.layer.original.isConnected) {
        entry.layer.dispose()
        brightness.delete(index)
      } else entry.layer.sync()
    }
    let changed = boundKey !== key
    if (changed) {
      const activeSet = new Set(active)
      for (const [index, binding] of bindings) {
        if (activeSet.has(index)) continue
        const layer = brightness.get(index)?.layer
        const stillOwned =
          !options.getLineElement || options.getLineElement(index) === binding.element
        if (layer && binding.element?.isConnected && stillOwned) {
          layer.setActive(false)
          const host = binding.element.ownerDocument.defaultView ?? window
          let timer = 0
          const entry = {
            binding,
            frozenAt: lastTime,
            cancelTimer: () => host.clearTimeout(timer),
          }
          timer = host.setTimeout(() => {
            if (retiring.get(index) !== entry) return
            releaseTargets(binding.targets)
            binding.observer?.disconnect()
            retiring.delete(index)
            // Once both copies look identical, return to a single resting text layer.
            brightness.get(index)?.layer.dispose()
            brightness.delete(index)
          }, LYRIC_BRIGHTNESS_SETTLE_MS)
          retiring.set(index, entry)
        } else {
          releaseTargets(binding.targets)
          binding.observer?.disconnect()
          layer?.dispose()
          brightness.delete(index)
        }
        bindings.delete(index)
      }
    }
    for (const index of active) {
      const exit = retiring.get(index)
      if (exit) {
        exit.cancelTimer()
        retiring.delete(index)
        bindings.set(index, exit.binding)
        changed = true
      }
      const lineWords = lines[index]?.words ?? NO_WORDS
      const element =
        (lineWords.length
          ? options.getLineElement
            ? options.getLineElement(index)
            : elements[index]
          : null) ?? null
      const previous = bindings.get(index)
      const priorLayer = brightness.get(index)
      if (priorLayer && priorLayer.element !== element) {
        priorLayer.layer.dispose()
        brightness.delete(index)
      }
      brightness.get(index)?.layer.setActive(true)
      if (previous?.observer?.takeRecords().length) previous.dirty = true
      if (
        previous?.words === lineWords &&
        previous.element === element &&
        previous.targets.length === lineWords.length &&
        !previous.dirty &&
        (previous.observer
          ? element?.isConnected && previous.content?.isConnected
          : previous.targets.every(
              (target, wordIndex) =>
                target.element.isConnected &&
                target.word === lineWords[wordIndex] &&
                target.element.childElementCount === target.characters.length &&
                target.characters.every((character) => character.element.isConnected),
            ))
      ) {
        if (remeasure)
          for (const sweep of new Set(previous.targets.map((target) => target.sweep)))
            sweep.refresh()
        continue
      }

      if (previous) {
        releaseTargets(previous.targets)
        previous.observer?.disconnect()
      }
      const next: KaraokeTarget[] = []
      const spans = element?.isConnected
        ? element.querySelectorAll<HTMLElement>('.lyric-word')
        : null
      if (spans?.length === lineWords.length) {
        const sweep = bindLyricSweep(Array.from(spans), lineWords)
        let lastVocal = -1
        for (let index = lineWords.length - 1; index >= 0; index--) {
          if (/[\p{L}\p{N}]/u.test(lineWords[index]!.text)) {
            lastVocal = index
            break
          }
        }
        for (const [wordIndex, word] of lineWords.entries()) {
          const element = spans[wordIndex]!
          const motion = {
            phraseEnd: wordIndex === lastVocal,
            background: lines[index]?.background,
          }
          next.push({
            element,
            word,
            sweep,
            sweepIndex: wordIndex,
            lastFill: '',
            lastEdge: '',
            lastRise: '',
            settledSide: null,
            motion,
            motionEnd: lyricWordMotionEnd(word, motion),
            characters: Array.from(
              element.querySelectorAll<HTMLElement>('.lyric-char'),
              (element) => ({
                element,
                visible: Boolean(element.textContent?.trim()),
                lastEmphasis: '',
                lastSpread: '',
              }),
            ),
          })
        }
        if (element && !brightness.has(index)) {
          const layer = createLyricBrightness(element)
          if (layer) {
            brightness.set(index, { element, layer })
            layer.setActive(true)
          }
        }
      }
      const binding: KaraokeBinding = {
        words: lineWords,
        element,
        content: element?.querySelector<HTMLElement>('.lyric-original') ?? element,
        targets: next,
        observer: null,
        dirty: false,
      }
      const Observer = element?.ownerDocument.defaultView?.MutationObserver
      if (element && Observer) {
        binding.observer = new Observer(() => {
          binding.dirty = true
        })
        // Style writes are deliberately excluded: only structural/text changes rebind words.
        binding.observer.observe(binding.content!, {
          childList: true,
          subtree: true,
          characterData: true,
        })
      }
      bindings.set(index, binding)
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
    reconcile(active, true)
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
    lastTime = time
    writeTargets(targets, time)
    for (const entry of retiring.values()) {
      // Natural phrase exits finish their motion; seeking fades the old visual sample in place.
      if (time >= entry.frozenAt && time - entry.frozenAt < 0.75)
        writeTargets(entry.binding.targets, time)
    }
  }

  function writeTargets(current: readonly KaraokeTarget[], time: number): void {
    for (const target of current) {
      if (!target.element.isConnected) continue
      const side = time < target.word.time ? 'before' : time >= target.motionEnd ? 'after' : null
      if (side && side === target.settledSide) continue
      target.settledSide = side
      const progress = target.sweep.write(target.sweepIndex, time)
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
        const emphasis = character.visible
          ? lyricCharacterEmphasis(
              time,
              target.word,
              index,
              target.characters.length,
              target.motion,
            ).toFixed(3)
          : '0.000'
        if (emphasis !== character.lastEmphasis) {
          character.lastEmphasis = emphasis
          character.element.style.setProperty('--lyric-char-emphasis', emphasis)
        }
        const spread = lyricCharacterSpread(
          Number(emphasis),
          index,
          target.characters.length,
        ).toFixed(4)
        if (spread !== character.lastSpread) {
          character.lastSpread = spread
          character.element.style.setProperty('--lyric-char-spread', spread)
        }
      }
    }
  }

  function getMotionEnd(time: number): number | null {
    let end: number | null = null
    const include = (current: readonly KaraokeTarget[]) => {
      for (const target of current)
        if (time >= target.word.time && time < target.motionEnd)
          end = Math.max(end ?? 0, target.motionEnd)
    }
    include(targets)
    for (const entry of retiring.values())
      if (time >= entry.frozenAt && time - entry.frozenAt < 0.75) include(entry.binding.targets)
    return end
  }

  return { bind, ensure, write, release, getWords: () => words, getMotionEnd }
}
