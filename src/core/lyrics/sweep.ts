import type { LyricSyllable, LyricWord } from '../types'

interface SweepSegment {
  start: number
  end: number
  from: number
  to: number
}

export interface LyricWordGeometry {
  width: number
  syllableWidths?: readonly number[]
}

function sampleSegment(segment: SweepSegment, time: number): number {
  const progress =
    time < segment.start
      ? 0
      : segment.end <= segment.start
        ? 1
        : Math.max(0, Math.min(1, (time - segment.start) / (segment.end - segment.start)))
  return segment.from + (segment.to - segment.from) * progress
}

function sample(segments: readonly SweepSegment[], time: number): number {
  let low = 0
  let high = segments.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (segments[middle]!.start <= time) low = middle + 1
    else high = middle
  }
  const segment = segments[low - 1]
  if (!segment) return segments[0]?.from ?? 0
  return sampleSegment(segment, time)
}

/**
 * 从真实音节和字形宽度生成整句扫光路径。停顿是水平段，回退直接采样同一路径。
 * 重叠音节不能共用一个前沿，保留各音节独立推进，避免抹掉重叠演唱。
 * 几何由宿主一次性测量；逐帧只做时间查询，不读 DOM。
 */
export function createLyricSweep(
  words: readonly LyricWord[],
  geometry: readonly LyricWordGeometry[],
): { progress: (index: number, time: number) => number } {
  const paths: SweepSegment[][] = []
  const starts: number[] = []
  const widths: number[] = []
  const ordered: SweepSegment[] = []
  let total = 0
  let previousEnd = Number.NEGATIVE_INFINITY
  let sequential = true
  for (const [index, word] of words.entries()) {
    const syllables: readonly LyricSyllable[] = word.syllables?.length ? word.syllables : [word]
    const measured = geometry[index]
    const weights = syllables.map((syllable, slot) => {
      const value = measured?.syllableWidths?.[slot]
      return value !== undefined && Number.isFinite(value) && value > 0
        ? value
        : Math.max(1, Array.from(syllable.text).length)
    })
    const weight = weights.reduce((sum, value) => sum + value, 0)
    const width =
      measured && Number.isFinite(measured.width) && measured.width > 0 ? measured.width : weight
    starts.push(total)
    widths.push(width)
    const path: SweepSegment[] = []
    let position = total
    for (const [slot, syllable] of syllables.entries()) {
      const end = syllable.time + Math.max(0, syllable.duration)
      const next = position + (width * weights[slot]!) / weight
      const segment = { start: syllable.time, end, from: position, to: next }
      if (syllable.time < previousEnd) sequential = false
      previousEnd = Math.max(previousEnd, end)
      path.push(segment)
      ordered.push(segment)
      position = next
    }
    paths.push(path)
    total += width
  }
  return {
    progress(index, time) {
      const path = paths[index]
      if (!path?.length || !Number.isFinite(time)) return 0
      if (sequential) {
        return Math.max(0, Math.min(1, (sample(ordered, time) - starts[index]!) / widths[index]!))
      }
      // An overlapping voice has multiple simultaneous fronts, not a sorted single cursor.
      let filled = 0
      for (const segment of path) {
        filled += sampleSegment(segment, time) - segment.from
      }
      return Math.max(0, Math.min(1, filled / widths[index]!))
    },
  }
}
