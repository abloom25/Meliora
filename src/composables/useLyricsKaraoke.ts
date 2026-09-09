import type { LyricLine, LyricWord } from '../types/music'
import { wordFillProgress } from '../utils/lyrics'

// 逐字扫光。只有当前正在唱的行需要每帧写入;其余行由 CSS 的
// `.lyric-line { --lyric-word-fill: 1 }` 兜底为"整行已唱完"。
// 同一时刻只有一个音节处于"半亮"状态,写入前比对上一次的值,每帧实际只有一两个节点被改动。

export interface LyricsKaraokeOptions {
  getLines: () => readonly LyricLine[]
  getLineElements: () => readonly (HTMLElement | null | undefined)[]
  /**
   * 扫光本身就是动画,关掉「歌词动画」后不该继续跑。必须在 JS 侧拦住:
   * 每帧写入的是内联自定义属性,优先级高于任何 CSS 声明,CSS 关不掉它
   */
  isEnabled: () => boolean
}

// 前沿柔化宽度的收敛斜率:进度进入 [0, 1/斜率] 或 [1-1/斜率, 1] 时线性收到 0
const EDGE_FADE_SLOPE = 8

interface KaraokeTarget {
  element: HTMLElement
  word: LyricWord
  lastFill: string
  lastEdge: string
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function useLyricsKaraoke(options: LyricsKaraokeOptions) {
  let targets: KaraokeTarget[] = []
  // 已绑定的活跃行集合(以 "1,2" 形式记),用于判断要不要重绑
  let boundKey: string | null = null

  function release() {
    for (const target of targets) {
      if (!target.element.isConnected) continue
      target.element.style.removeProperty('--lyric-word-fill')
      target.element.style.removeProperty('--lyric-word-edge')
    }
    targets = []
    boundKey = null
  }

  /** 接管这些行的音节。节点还没跟上数据时保持未绑定,下一帧会自动重试 */
  function bind(active: readonly number[]) {
    release()
    const key = active.join(',')
    // 释放内联属性后整行回落到 CSS 的 --lyric-word-fill: 1,
    // 表现为整行一次性高亮,和没有逐字数据的行一致
    if (!options.isEnabled()) {
      boundKey = key
      return
    }
    const lines = options.getLines()
    const elements = options.getLineElements()
    const next: KaraokeTarget[] = []
    for (const index of active) {
      const line = lines[index]
      if (!line?.words?.length) continue
      const spans = elements[index]?.querySelectorAll<HTMLElement>('.lyric-word')
      if (!spans || spans.length !== line.words.length) return
      for (const [wordIndex, word] of line.words.entries()) {
        next.push({ element: spans[wordIndex]!, word, lastFill: '', lastEdge: '' })
      }
    }
    boundKey = key
    targets = next
  }

  /**
   * 确认绑定仍然有效,失效则重绑。行节点被 Vue 重建(切换译文显示、字号变化)后
   * 旧的音节引用会失效;空目标是合法状态(整行没有逐字数据、或扫光被关闭),
   * 不能当成失效反复重绑
   */
  function ensure(active: readonly number[]) {
    const head = targets[0]
    if (boundKey !== active.join(',') || (head && !head.element.isConnected)) bind(active)
  }

  function write(time: number) {
    for (const target of targets) {
      const progress = wordFillProgress(time, target.word)
      const fill = progress.toFixed(3)
      if (fill !== target.lastFill) {
        target.lastFill = fill
        target.element.style.setProperty('--lyric-word-fill', fill)
      }
      // 只有正在推进的词才有柔化前沿,已唱完和未开唱的词一律实色
      const edge = clamp01(Math.min(progress, 1 - progress) * EDGE_FADE_SLOPE).toFixed(3)
      if (edge !== target.lastEdge) {
        target.lastEdge = edge
        target.element.style.setProperty('--lyric-word-edge', edge)
      }
    }
  }

  return { bind, ensure, write, release }
}
