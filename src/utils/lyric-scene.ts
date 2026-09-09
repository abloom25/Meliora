import type { LyricLine } from '../types/music'
import { findActiveLyricIndices } from './lyrics'

// 歌词面板的纯逻辑层:给定歌词与播放位置,算出"此刻该亮哪些行、锚点是谁、
// 哪些和声行该露出来";给定各行高度,算出每一行在版面里的纵坐标。
// 这里不碰 DOM,弹簧与渲染在 useLyricsEngine 里。

export interface LyricScene {
  /** 正在唱的所有行(对唱双声部、背景和声可以同时在唱) */
  active: number[]
  /** true 表示间奏里保留的高亮,而不是真的有行在唱 */
  held: boolean
  /** 锚点行:活跃集合里最靠后的主行。高亮距离、居中、节奏压缩都以它为准 */
  anchor: number
  /** 各行的和声展开状态。非和声行恒为 false */
  harmonyOpen: boolean[]
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

// 锚点:活跃集合里最靠后的主行。背景和声属于它前面那一句,让和声当锚会让
// 画面在主行与和声之间来回拉;但和声自己的高亮不受影响,它按自己的时间轴亮
function anchorOf(lines: readonly LyricLine[], indices: readonly number[]): number {
  for (let cursor = indices.length - 1; cursor >= 0; cursor -= 1) {
    const index = indices[cursor]
    if (index !== undefined && !lines[index]?.background) return index
  }
  return indices.length ? (indices[indices.length - 1] ?? -1) : -1
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
  if (!lines.length) return { active: [], held: false, anchor: -1, harmonyOpen }

  const next = findActiveLyricIndices(lines as LyricLine[], time)
  const activeSet = new Set(next.indices)
  for (const [index, parent] of parents) {
    harmonyOpen[index] = activeSet.has(index) || (!next.held && activeSet.has(parent))
  }
  return {
    active: next.indices,
    held: next.held,
    anchor: anchorOf(lines, next.indices),
    harmonyOpen,
  }
}

export function sameLyricScene(left: LyricScene, right: LyricScene): boolean {
  if (left.held !== right.held || left.anchor !== right.anchor) return false
  if (left.active.length !== right.active.length) return false
  return left.active.every((value, position) => value === right.active[position])
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
