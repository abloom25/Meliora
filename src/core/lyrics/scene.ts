import type { LyricLine } from '../types'
import { findActiveLyricIndices } from './lyrics'
import { createLyricTimeIndex } from './time-index'
import { createLyricGroupTimings, LYRIC_INTERLUDE_GAP_SECONDS } from './group-timing'

// 歌词面板的纯逻辑层:给定歌词与播放位置,算出"此刻该亮哪些行、锚点是谁、
// 哪些和声行该露出来";给定各行高度,算出每一行在版面里的纵坐标。
// 这里不碰 DOM,弹簧与渲染在 useLyricsEngine 里。

export interface LyricScene {
  /** 正在唱的所有行；held 时仍兼容返回最近主句，不能把它当作正在发声。 */
  active: number[]
  /** 视觉高亮，与发声分开；短暂静默时保留最后结束的主句组，和声只在自己的时间内高亮。 */
  highlighted: number[]
  /** true 表示没有实际发声的歌词，active 仅保留最近主句。 */
  held: boolean
  /** 最早仍高亮的主句组；无高亮时保留最近主句位置，和声不单独抢焦点。 */
  anchor: number
  /** 各行的和声展开状态。非和声行恒为 false */
  harmonyOpen: boolean[]
  /** Sparse immutable open rows; indexed timelines materialize harmonyOpen only on demand. */
  openHarmonies?: readonly number[]
}

// 高亮色/模糊过渡的基准时长,行间隔短于它时按比例压缩
const HIGHLIGHT_BASE_DURATION_MS = 620
const MIN_TEMPO_SCALE = 0.18

/** 每一行和声所属的主句索引;主句自己与找不到主句的和声不在表里 */
export function harmonyParentsOf(lines: readonly LyricLine[]): Map<number, number> {
  const parents = new Map<number, number>()
  let parent = -1
  for (const [index, line] of lines.entries()) {
    if (line.background) {
      if (parent >= 0) parents.set(index, parent)
    } else {
      parent = index
    }
  }
  return parents
}

function lowerBound(values: readonly number[], time: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (values[middle]! < time) low = middle + 1
    else high = middle
  }
  return low
}

/**
 * 高亮生命周期以主句与所属和声为一组，不能被一句内部的和声起音截断。
 * 只在所有组都唱完后的短暂静默里延续最后一组，重叠演唱中已结束的组及时退亮。
 * 预先把“唱完后等下一句”转换成区间，所以直接 seek 与顺播具有相同结果。
 * 长空隙按所有重叠组的最晚结束计算，避免短声部结束时误判整首歌进入间奏。
 */
function createHighlightIndex(lines: readonly LyricLine[], parents: ReadonlyMap<number, number>) {
  const ordered = createLyricGroupTimings(lines, parents)
  const starts = ordered.map((group) => group.start)
  const latestEnds: number[] = []
  const interludeStarts: number[] = []
  let songEnd = Number.NEGATIVE_INFINITY
  for (const group of ordered) {
    if (Number.isFinite(songEnd) && group.start - songEnd >= LYRIC_INTERLUDE_GAP_SECONDS)
      interludeStarts.push(songEnd)
    songEnd = Math.max(songEnd, group.end)
    latestEnds.push(songEnd)
  }
  const highlightedLines: LyricLine[] = ordered.map((group) => {
    const nextStart = lowerBound(starts, group.end)
    // 已开始的其他组若仍在唱，当前组不能把高亮延长到之后另一句的起点。
    // 同起点的组也保留独立索引；只有共同结束时才一起保留短隙高亮。
    const overlapping = (latestEnds[nextStart - 1] ?? group.end) > group.end
    return {
      time: group.start,
      endTime: overlapping
        ? group.end
        : Math.min(
            starts[nextStart] ?? songEnd,
            interludeStarts[lowerBound(interludeStarts, group.end)] ?? songEnd,
            songEnd,
          ),
      text: '',
    }
  })
  const index = createLyricTimeIndex(highlightedLines)
  return {
    nextBoundary: index.nextBoundary,
    read(time: number): number[] {
      if (!Number.isFinite(time)) return []
      const state = index.read(time)
      return state.held
        ? []
        : state.indices.map((row) => ordered[row]!.row).sort((left, right) => left - right)
    },
  }
}

function highlightedRows(
  lines: readonly LyricLine[],
  groups: readonly number[],
  active: readonly number[],
  held: boolean,
): number[] {
  const highlighted = new Set(groups.filter((index) => !lines[index]?.background))
  // 主句延续高亮不应让已经唱完、收起的和声重新点亮。
  if (!held) for (const index of active) if (lines[index]?.background) highlighted.add(index)
  return [...highlighted].sort((left, right) => left - right)
}

function anchorOf(
  groups: readonly number[],
  active: readonly number[],
  parents: ReadonlyMap<number, number>,
): number {
  if (groups.length) return groups[0]!
  const fallback = active[active.length - 1]
  return fallback === undefined ? -1 : (parents.get(fallback) ?? fallback)
}

/**
 * 解析某一时刻的场景。和声行(Apple Music 的 x-bg)附在所属主句下方:
 * 主句唱到时才露出来,主句唱完(或和声自己唱完且主句已结束)就收走;
 * 间奏里主句虽然保留着高亮,和声早已唱完,不该继续挂在那儿。
 */
export function resolveLyricScene(
  lines: readonly LyricLine[],
  time: number,
  parents: ReadonlyMap<number, number> = harmonyParentsOf(lines),
): LyricScene {
  // 找不到所属主句的和声(文件本身异常)一律常驻显示,不然它永远出不来
  const harmonyOpen = lines.map((line, index) => Boolean(line.background) && !parents.has(index))
  if (!lines.length)
    return { active: [], highlighted: [], held: false, anchor: -1, harmonyOpen, openHarmonies: [] }

  const next = findActiveLyricIndices(lines as LyricLine[], time)
  const groups = createHighlightIndex(lines, parents).read(time)
  const activeSet = new Set(next.indices)
  for (const [index, parent] of parents) {
    harmonyOpen[index] = activeSet.has(index) || (!next.held && activeSet.has(parent))
  }
  return {
    active: next.indices,
    highlighted: highlightedRows(lines, groups, next.indices, next.held),
    held: next.held,
    anchor: anchorOf(groups, next.indices, parents),
    harmonyOpen,
    openHarmonies: harmonyOpen.flatMap((open, index) => (open ? [index] : [])),
  }
}

export interface LyricTimeline {
  /** 返回共享的区间快照,调用方不应修改其中的数组。歌词内容变化后需重建时间轴。 */
  read: (time: number) => LyricScene
  nextBoundary: (time: number) => number | null
}

/**
 * 场景只会在行首 / 行尾发生变化,逐字进度不参与场景计算。
 * 预先排序这些边界,同一区间内直接复用场景,避免每个动画帧扫描整首歌词。
 * 顺播只消费跨过的事件,远跳/倒退用区间索引定位,保留对唱与无结束时间的语义。
 * 只保存当前区间的稀疏快照,旧的 harmonyOpen 数组仅在兼容调用方读取时生成。
 */
export function createLyricTimeline(
  lines: readonly LyricLine[],
  parents: ReadonlyMap<number, number> = harmonyParentsOf(lines),
): LyricTimeline {
  const index = createLyricTimeIndex(lines)
  const highlightIndex = createHighlightIndex(lines, parents)
  const children = new Map<number, number[]>()
  const orphans: number[] = []
  for (let row = 0; row < lines.length; row += 1) {
    if (!lines[row]!.background) continue
    const parent = parents.get(row)
    if (parent === undefined) orphans.push(row)
    else {
      const group = children.get(parent) ?? []
      group.push(row)
      children.set(parent, group)
    }
  }
  let from = Number.NEGATIVE_INFINITY
  let until = Number.POSITIVE_INFINITY
  let cached: LyricScene | null = null

  function read(time: number): LyricScene {
    // NaN 与 ±Infinity 的比较行为不同于普通区间,保持原解析结果,
    // 且不能让异常时钟读数覆盖有限时间的缓存。
    if (!Number.isFinite(time)) return resolveLyricScene(lines, time, parents)
    if (cached && time >= from && time < until) return cached
    const interval = index.interval(time)
    from = interval.from
    until = interval.until
    if (!index.supported) cached = resolveLyricScene(lines, time, parents)
    else {
      const next = index.read(time)
      const groups = highlightIndex.read(time)
      const open = new Set(orphans)
      for (const row of next.indices) {
        if (lines[row]?.background) open.add(row)
        if (!next.held) for (const child of children.get(row) ?? []) open.add(child)
      }
      const openHarmonies = Object.freeze([...open].sort((a, b) => a - b))
      let dense: boolean[] | null = null
      cached = {
        active: next.indices,
        highlighted: highlightedRows(lines, groups, next.indices, next.held),
        held: next.held,
        anchor: anchorOf(groups, next.indices, parents),
        get harmonyOpen() {
          if (!dense) {
            dense = new Array<boolean>(lines.length).fill(false)
            for (const row of openHarmonies) dense[row] = true
          }
          return dense
        },
        openHarmonies,
      }
    }
    return cached
  }

  return {
    read,
    nextBoundary(time) {
      const next = index.nextBoundary(time)
      const highlight = highlightIndex.nextBoundary(time)
      if (next === null) return highlight
      return highlight === null ? next : Math.min(next, highlight)
    },
  }
}

export function isLyricHarmonyOpen(scene: LyricScene, index: number): boolean {
  return scene.openHarmonies
    ? scene.openHarmonies.includes(index)
    : Boolean(scene.harmonyOpen[index])
}

/** 已唱完与滚动焦点分开:间奏保留上一句的位置,但它已经不在演唱。 */
export function isLyricLineCompleted(
  line: LyricLine,
  index: number,
  time: number,
  scene: Pick<LyricScene, 'active' | 'held'>,
): boolean {
  if (
    !Number.isFinite(time) ||
    line.time === null ||
    !Number.isFinite(line.time) ||
    time < line.time
  )
    return false
  if (line.endTime !== undefined) {
    return Number.isFinite(line.endTime) && time >= line.endTime
  }
  // 只给行首时间的歌词沿用时间轴的让位规则,不能用行号比较破坏对唱。
  return scene.held || !scene.active.includes(index)
}

export function sameLyricScene(left: LyricScene, right: LyricScene): boolean {
  if (left === right) return true
  if (left.held !== right.held || left.anchor !== right.anchor) return false
  if (left.active.length !== right.active.length) return false
  if (left.highlighted.length !== right.highlighted.length) return false
  return (
    left.active.every((value, position) => value === right.active[position]) &&
    left.highlighted.every((value, position) => value === right.highlighted[position])
  )
}

/** 下一句主行的起始时间。背景和声属于当前这一句,不算"下一句" */
export function nextPrimaryTime(lines: readonly LyricLine[], index: number): number | null {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line?.background) continue
    return line?.time ?? null
  }
  return null
}

/**
 * 行间隔短于整套高亮过渡时长时按比例压缩,让快节奏歌词的高亮跟得上换行。
 * 位移不需要压缩——弹簧本身可被打断,新目标直接接管当前速度
 */
export function lyricTempoScale(lines: readonly LyricLine[], index: number): number {
  const current = lines[index]?.time
  if (current === null || current === undefined) return 1
  const next = nextPrimaryTime(lines, index)
  if (next === null) return 1
  const ratio = ((next - current) * 1000) / HIGHLIGHT_BASE_DURATION_MS
  return Math.max(MIN_TEMPO_SCALE, Math.min(1, ratio))
}

// ---- 版面 ----

export interface LyricLayoutInput {
  /** 各行的自然高度(像素)。和声行即使收起也传展开时的高度 */
  heights: readonly number[]
  /** 各行是否为背景和声 */
  background: readonly boolean[]
  /**
   * 各行的和声展开程度,0 = 收起、1 = 完全展开,中间值是正在开合的过程。
   * 引擎用一根弹簧推进它,版面随之连续变化,下面的行才不会与正在收回的和声重叠
   */
  open: readonly number[]
  /** 主行之间的间距 */
  gap: number
  /** 主句与它的和声之间的间距,通常比行距紧 */
  harmonyGap: number
}

export interface LyricLayout {
  /** 各行在版面里的纵坐标 */
  tops: number[]
  /** 各行占用的高度。收起的和声为 0 */
  heights: number[]
  /** 版面总高度 */
  total: number
}

/**
 * 从上到下排版。和声行按展开程度占位:收起时不占位,top 落在主句下沿;
 * 展开过程中它与主句的间距和自身高度都按比例长出来,正好是"从主句底下探出来",
 * 后面的行被连续地顶下去 / 收上来
 */
export function layoutLyricLines(input: LyricLayoutInput): LyricLayout {
  const count = input.heights.length
  const tops = new Array<number>(count)
  const heights = new Array<number>(count)
  let cursor = 0
  let first = true

  for (let index = 0; index < count; index += 1) {
    const background = input.background[index] ?? false
    const open = background ? Math.max(0, Math.min(1, input.open[index] ?? 0)) : 1
    if (background && open <= 0) {
      tops[index] = cursor
      heights[index] = 0
      continue
    }
    if (!first) cursor += background ? input.harmonyGap * open : input.gap
    first = false
    tops[index] = cursor
    const height = (input.heights[index] ?? 0) * open
    heights[index] = height
    cursor += height
  }

  return { tops, heights, total: cursor }
}

/** 让第 index 行的中线落在视口 anchorRatio 处所需的版面偏移。index < 0 时按第一行 */
export function lyricFocusOffset(
  layout: LyricLayout,
  index: number,
  viewportHeight: number,
  anchorRatio: number,
): number {
  if (!layout.tops.length) return 0
  const target = index >= 0 && index < layout.tops.length ? index : 0
  const top = layout.tops[target] ?? 0
  const height = layout.heights[target] ?? 0
  return top + height / 2 - viewportHeight * anchorRatio
}
