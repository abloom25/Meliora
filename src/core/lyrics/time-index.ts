import type { LyricLine } from '../types'
import type { ActiveLyricLines } from './lyrics'

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

/** Immutable timing index; moving the cursor never changes an earlier result. */
export function createLyricTimeIndex(lines: readonly LyricLine[]) {
  const records = lines.map((line, index) => ({
    index,
    start: line.time,
    end: line.endTime,
    background: Boolean(line.background),
  }))
  const supported = records.every(
    ({ start, end }) =>
      (start === null || Number.isFinite(start)) && (end === undefined || Number.isFinite(end)),
  )
  const primaryTimes = [
    ...new Set(
      records.filter((row) => row.start !== null && !row.background).map((row) => row.start!),
    ),
  ].sort((a, b) => a - b)
  const starts = records
    .filter((row) => row.start !== null && Number.isFinite(row.start))
    .sort((a, b) => a.start! - b.start! || a.index - b.index)
  const startTimes = starts.map((row) => row.start!)
  const lastAny: number[] = []
  const lastPrimary: number[] = []
  let any = -1
  let primary = -1
  for (const row of starts) {
    any = Math.max(any, row.index)
    if (!row.background) primary = Math.max(primary, row.index)
    lastAny.push(any)
    lastPrimary.push(primary)
  }
  const events = new Map<number, { add: number[]; remove: number[] }>()
  const eventAt = (time: number) => {
    let event = events.get(time)
    if (!event) {
      event = { add: [], remove: [] }
      events.set(time, event)
    }
    return event
  }
  // Preserve resolver boundaries even for malformed/untimed rows in the fallback path.
  for (const row of records) {
    if (row.start !== null && Number.isFinite(row.start)) eventAt(row.start)
    if (row.end !== undefined && Number.isFinite(row.end)) eventAt(row.end)
  }
  // Missing ends yield to the next strictly later primary start, including for
  // unordered input. Explicit zero/inverted intervals still affect gap fallback.
  const intervals = starts.map((row) => {
    const start = row.start!
    const end = row.end ?? primaryTimes[upperBound(primaryTimes, start)] ?? Number.POSITIVE_INFINITY
    eventAt(start)
    if (row.end !== undefined && Number.isFinite(row.end)) eventAt(row.end)
    if (end > start) {
      eventAt(start).add.push(row.index)
      if (Number.isFinite(end)) eventAt(end).remove.push(row.index)
    }
    return { index: row.index, start, end }
  })
  const boundaries = [...events.keys()].sort((a, b) => a - b)
  let capacity = 1
  while (capacity < intervals.length) capacity *= 2
  const maximumEnd = new Float64Array(capacity * 2).fill(Number.NEGATIVE_INFINITY)
  for (let index = 0; index < intervals.length; index += 1) {
    const row = intervals[index]!
    if (row.end > row.start) maximumEnd[capacity + index] = row.end
  }
  for (let node = capacity - 1; node > 0; node -= 1)
    maximumEnd[node] = Math.max(maximumEnd[node * 2]!, maximumEnd[node * 2 + 1]!)
  let cursor = -1
  let active = new Set<number>()
  function locate(time: number): void {
    active = new Set()
    const started = upperBound(startTimes, time)
    const visit = (node: number, first: number, end: number): void => {
      if (first >= started || maximumEnd[node]! <= time) return
      if (end - first === 1) {
        active.add(intervals[first]!.index)
        return
      }
      const middle = (first + end) / 2
      visit(node * 2, first, middle)
      visit(node * 2 + 1, middle, end)
    }
    visit(1, 0, capacity)
  }
  return {
    supported,
    nextBoundary(time: number): number | null {
      return boundaries[upperBound(boundaries, time)] ?? null
    },
    interval(time: number): { from: number; until: number } {
      const next = upperBound(boundaries, time)
      return {
        from: boundaries[next - 1] ?? Number.NEGATIVE_INFINITY,
        until: boundaries[next] ?? Number.POSITIVE_INFINITY,
      }
    },
    read(time: number): ActiveLyricLines {
      const next = upperBound(boundaries, time)
      // Nearby forward playback consumes only crossed events. A long seek uses
      // the interval tree instead of replaying every intervening lyric line.
      if (cursor >= 0 && next >= cursor && next - cursor <= 64) {
        for (let index = cursor; index < next; index += 1) {
          const event = events.get(boundaries[index]!)!
          for (const line of event.remove) active.delete(line)
          for (const line of event.add) active.add(line)
        }
      } else locate(time)
      cursor = next
      const indices = [...active].sort((a, b) => a - b)
      if (indices.length) return { indices, held: false }
      const started = upperBound(startTimes, time) - 1
      const fallback =
        (lastPrimary[started] ?? -1) >= 0 ? lastPrimary[started]! : (lastAny[started] ?? -1)
      return { indices: fallback >= 0 ? [fallback] : [], held: fallback >= 0 }
    },
  }
}
