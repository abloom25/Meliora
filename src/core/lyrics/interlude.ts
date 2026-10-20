import type { LyricLine } from '../types'
import { createLyricGroupTimings, LYRIC_INTERLUDE_GAP_SECONDS } from './group-timing'
import { harmonyParentsOf } from './scene'

// 前奏没有旧句承接，更早给出等待提示；中段仍与高亮生命周期共用七秒门槛。
const MIN_INTRO_WAIT_SECONDS = 3

export interface LyricWaitingInterval {
  readonly kind: 'intro' | 'interlude'
  /** 媒体时间，单位为秒，区间是 [start, end)。 */
  readonly start: number
  readonly end: number
  /** 前奏为 -1，否则是等待前的主句组；和声不会成为独立锚点。 */
  readonly previousAnchor: number
  readonly nextAnchor: number
}

export interface LyricWaitingState {
  /** 同一等待区间始终复用此对象，可用引用变化驱动低频布局更新。 */
  readonly interval: LyricWaitingInterval
  /** 完全由媒体时间推导；暂停时保持，倒退或跳转时直接得到对应进度。 */
  readonly progress: number
}

export interface LyricWaitingTimeline {
  read: (time: number) => LyricWaitingState | null
  /** 严格晚于给定时间的下一次等待开始或结束；没有边界时返回 null。 */
  nextBoundary: (time: number) => number | null
}

function upperBound(values: readonly number[], time: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle]! <= time) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * 预计算有下一句接续的等待区间。使用演唱组的覆盖并集，因此长声部与尾随
 * 和声未结束时不会误报间奏，也不会把末句结束后的尾奏当成无限等待。
 * 只有构建时读取歌词；每次读取都二分定位，与播放/暂停/seek 的历史无关。
 */
export function createLyricWaitingTimeline(
  lines: readonly LyricLine[],
  parents: ReadonlyMap<number, number> = harmonyParentsOf(lines),
): LyricWaitingTimeline {
  const groups = createLyricGroupTimings(lines, parents)
  const intervals: LyricWaitingInterval[] = []
  let coveredEnd = 0
  let previousAnchor = -1
  for (const group of groups) {
    // 完全在媒体零点前的歌词不能把真正的前奏误标为中段间奏。
    if (group.end <= 0) continue
    const kind = previousAnchor < 0 ? 'intro' : 'interlude'
    const threshold = kind === 'intro' ? MIN_INTRO_WAIT_SECONDS : LYRIC_INTERLUDE_GAP_SECONDS
    if (Number.isFinite(coveredEnd) && group.start - coveredEnd >= threshold) {
      intervals.push(
        Object.freeze({
          kind,
          start: coveredEnd,
          end: group.start,
          previousAnchor,
          nextAnchor: group.row,
        }),
      )
    }
    coveredEnd = Math.max(coveredEnd, group.end)
    previousAnchor = group.row
  }
  const starts = intervals.map((interval) => interval.start)
  const boundaries = [
    ...new Set(intervals.flatMap((interval) => [interval.start, interval.end])),
  ].sort((left, right) => left - right)

  return {
    read(time) {
      if (!Number.isFinite(time) || time < 0) return null
      const interval = intervals[upperBound(starts, time) - 1]
      if (!interval || time >= interval.end) return null
      return {
        interval,
        progress: Math.max(
          0,
          Math.min(1, (time - interval.start) / (interval.end - interval.start)),
        ),
      }
    },
    nextBoundary(time) {
      if (!Number.isFinite(time)) return null
      return boundaries[upperBound(boundaries, time)] ?? null
    },
  }
}
