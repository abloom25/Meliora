import type { LyricLine } from '../types'

/** 高亮生命周期与等待提示共享同一个长间奏阈值。单位为秒。 */
export const LYRIC_INTERLUDE_GAP_SECONDS = 7

export interface LyricGroupTiming {
  /** 主句索引；没有所属主句的和声以自身为组。 */
  readonly row: number
  readonly start: number
  readonly end: number
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
 * 将主句与附属和声合为连续的演唱组。没有结束时间时保守延续到下一主句，
 * 不能仅凭相邻行首相隔很久就推断中间无人演唱。
 */
export function createLyricGroupTimings(
  lines: readonly LyricLine[],
  parents: ReadonlyMap<number, number>,
): readonly LyricGroupTiming[] {
  const records = lines.map((line, index) => ({
    index,
    start: line.time,
    end: line.endTime,
    background: Boolean(line.background),
  }))
  const primaryStarts = [
    ...new Set(
      records
        .filter((row) => row.start !== null && Number.isFinite(row.start) && !row.background)
        .map((row) => row.start!),
    ),
  ].sort((left, right) => left - right)
  const groups = new Map<number, { row: number; start: number; end: number }>()
  for (const record of records) {
    const start = record.start
    if (start === null || !Number.isFinite(start)) continue
    const end =
      record.end ?? primaryStarts[upperBound(primaryStarts, start)] ?? Number.POSITIVE_INFINITY
    if (Number.isNaN(end) || end <= start) continue
    const row = parents.get(record.index) ?? record.index
    const group = groups.get(row)
    if (group) {
      group.start = Math.min(group.start, start)
      group.end = Math.max(group.end, end)
    } else groups.set(row, { row, start, end })
  }
  return [...groups.values()].sort(
    (left, right) => left.start - right.start || left.row - right.row,
  )
}
