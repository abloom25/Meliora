import { describe, expect, it } from 'vitest'
import {
  createLyricTimeline,
  harmonyParentsOf,
  layoutLyricLines,
  lyricFocusOffset,
  lyricTempoScale,
  resolveLyricScene,
  sameLyricScene,
} from '../core/lyrics/scene'
import type { LyricLine } from '../core/types'

// Apple Music 规格的 TTML:两个声部同时开唱,背景和声有自己的 begin/end
const duetLines: LyricLine[] = [
  { time: 0, endTime: 6, text: 'main voice', agent: 'primary' },
  { time: 0, endTime: 6, text: 'other voice', agent: 'secondary' },
  { time: 3, endTime: 5, text: 'ooh', background: true },
  { time: 8, endTime: 10, text: 'next line' },
  { time: 9, endTime: 12, text: 'aah', background: true },
]

describe('resolveLyricScene', () => {
  it('lights both voices of a duet and anchors on the last primary line', () => {
    const scene = resolveLyricScene(duetLines, 1)
    expect(scene.active).toEqual([0, 1])
    expect(scene.anchor).toBe(1)
    expect(scene.held).toBe(false)
  })

  it('opens a harmony line as soon as its parent sentence starts, before it sings', () => {
    // 和声 3s 才开口,但它属于 0s 开始的这一句:主句一亮它就该露出来
    const scene = resolveLyricScene(duetLines, 1)
    expect(scene.active).not.toContain(2)
    expect(scene.harmonyOpen[2]).toBe(true)
    expect(scene.harmonyOpen[4]).toBe(false)
  })

  it('lights the harmony on its own timeline while keeping the parent as anchor', () => {
    const scene = resolveLyricScene(duetLines, 3.5)
    expect(scene.active).toEqual([0, 1, 2])
    expect(scene.anchor).toBe(1)
  })

  it('keeps the last primary line lit through an instrumental gap and closes its harmony', () => {
    const scene = resolveLyricScene(duetLines, 7)
    expect(scene.held).toBe(true)
    expect(scene.anchor).toBe(1)
    expect(scene.harmonyOpen[2]).toBe(false)
  })

  it('keeps a harmony open while it is still singing after its parent ended', () => {
    // 第 4 行和声唱到 12s,主句 10s 就结束了:和声自己还在唱就不收
    const scene = resolveLyricScene(duetLines, 11)
    expect(scene.active).toEqual([4])
    expect(scene.harmonyOpen[4]).toBe(true)
    expect(scene.anchor).toBe(4)
  })

  it('shows an orphan harmony line permanently instead of never', () => {
    const lines: LyricLine[] = [
      { time: 0, endTime: 1, text: 'lost harmony', background: true },
      { time: 2, endTime: 3, text: 'first real line' },
    ]
    expect(harmonyParentsOf(lines).size).toBe(0)
    expect(resolveLyricScene(lines, 2.5).harmonyOpen[0]).toBe(true)
  })

  it('lets a line without an end time give way to the next sung line', () => {
    // 歌词源只给行首时间戳时没有 endTime。不让位的话每一行都会一直算在"正在唱"里,
    // 越往后堆得越多(resolveLyricTimings 正常会补上 endTime,这里是数据不完整的兜底)
    const lines: LyricLine[] = [
      { time: 0, text: 'first' },
      { time: 5, text: 'second' },
      { time: 10, text: 'third' },
    ]
    expect(resolveLyricScene(lines, 7).active).toEqual([1])
    expect(resolveLyricScene(lines, 12).active).toEqual([2])
    // 同一时刻开唱的对唱双声部仍然一起亮
    const duet: LyricLine[] = [
      { time: 0, text: 'main', agent: 'primary' },
      { time: 0, text: 'other', agent: 'secondary' },
      { time: 5, text: 'next' },
    ]
    expect(resolveLyricScene(duet, 1).active).toEqual([0, 1])
  })

  it('reports an empty scene before the first line', () => {
    const scene = resolveLyricScene(duetLines, -1)
    expect(scene).toMatchObject({ active: [], held: false, anchor: -1 })
  })

  it('compares scenes by active set, hold state and anchor', () => {
    expect(sameLyricScene(resolveLyricScene(duetLines, 1), resolveLyricScene(duetLines, 2))).toBe(
      true,
    )
    expect(sameLyricScene(resolveLyricScene(duetLines, 1), resolveLyricScene(duetLines, 3.5))).toBe(
      false,
    )
    expect(sameLyricScene(resolveLyricScene(duetLines, 5.5), resolveLyricScene(duetLines, 7))).toBe(
      false,
    )
  })
})

describe('createLyricTimeline', () => {
  it('changes scenes at exact starts and ends while retaining overlapping voices', () => {
    const timeline = createLyricTimeline(duetLines)
    expect(timeline.read(-0.001).active).toEqual([])
    expect(timeline.read(0).active).toEqual([0, 1])
    expect(timeline.read(3).active).toEqual([0, 1, 2])
    expect(timeline.read(5).active).toEqual([0, 1])
    expect(timeline.read(6)).toMatchObject({ active: [1], held: true, anchor: 1 })
    expect(timeline.read(8)).toMatchObject({ active: [3], held: false, anchor: 3 })
    expect(timeline.read(10)).toMatchObject({ active: [4], held: false, anchor: 4 })
    expect(timeline.read(12)).toMatchObject({ active: [3], held: true, anchor: 3 })
  })

  it('matches the scene resolver across boundaries, reverse seeks and unordered input', () => {
    const incomplete: LyricLine[] = [
      { time: 6, text: 'later primary first in source order' },
      { time: 7, text: 'open-ended harmony', background: true },
      { time: 0, endTime: 2, text: 'earlier primary later in source order' },
      { time: null, text: 'untimed note' },
      { time: 6, text: 'simultaneous second voice', agent: 'secondary' },
      { time: 9, endTime: 9, text: 'zero duration' },
      { time: 12, endTime: 10, text: 'inverted interval' },
    ]
    // 密集的重叠、相同时间戳、乱序与缺少结束时间混在一起,
    // 可防止把区间集合误简化成“最后开唱的一行”。
    const dense: LyricLine[] = Array.from({ length: 120 }, (_, index) => {
      const time = ((index * 37) % 30) / 2
      return {
        time: index % 13 === 0 ? null : time,
        endTime: index % 7 === 0 ? undefined : time + (index % 5) / 2,
        background: index % 3 === 0,
        text: `Line ${index}`,
      }
    })
    const fixtures: LyricLine[][] = [
      [],
      [{ time: null, text: 'unsynchronized lyric' }],
      duetLines,
      incomplete,
      dense,
    ]
    for (const lines of fixtures) {
      const timeline = createLyricTimeline(lines)
      const boundaries = lines.flatMap((line) =>
        [line.time, line.endTime].filter((time): time is number => typeof time === 'number'),
      )
      const samples = [
        -100,
        ...boundaries.flatMap((time) => [time - 0.000001, time, time + 0.000001]),
        100,
      ].sort((left, right) => left - right)
      for (const time of [...samples, ...[...samples].reverse(), 12, -10, 3.5, 7, 0, 100]) {
        expect(timeline.read(time)).toEqual(resolveLyricScene(lines, time))
      }
    }
  })

  it('keeps non-finite query and lyric timestamps equivalent without poisoning its cache', () => {
    const lines: LyricLine[] = [
      { time: Number.NEGATIVE_INFINITY, endTime: -2, text: 'negative infinity' },
      { time: Number.NaN, endTime: 3, text: 'invalid start', background: true },
      { time: 0, endTime: Number.NaN, text: 'invalid end' },
      { time: 2, text: 'open-ended' },
      { time: 4, endTime: Number.POSITIVE_INFINITY, text: 'infinite end' },
      { time: Number.POSITIVE_INFINITY, text: 'infinite start' },
    ]
    const timeline = createLyricTimeline(lines)
    const cached = timeline.read(0.5)
    for (const time of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(timeline.read(time)).toEqual(resolveLyricScene(lines, time))
      expect(timeline.read(0.5)).toBe(cached)
    }
    for (const time of [-100, -2, 0, 2, 3, 4, 100, -1, 3, 1]) {
      expect(timeline.read(time)).toEqual(resolveLyricScene(lines, time))
    }
  })

  it('does not scan lyric timings again for animation frames inside the current interval', () => {
    let timingReads = 0
    const lines: LyricLine[] = Array.from({ length: 1000 }, (_, index) => ({
      get time() {
        timingReads += 1
        return index * 10
      },
      get endTime() {
        timingReads += 1
        return index * 10 + 8
      },
      text: `Line ${index}`,
    }))
    const timeline = createLyricTimeline(lines)
    const scene = timeline.read(5000)
    const readsAtBoundary = timingReads
    for (let frame = 1; frame < 480; frame += 1) {
      expect(timeline.read(5000 + frame / 60)).toBe(scene)
    }
    expect(timingReads).toBe(readsAtBoundary)
    expect(timeline.read(5008)).toMatchObject({ active: [500], held: true })
  })

  it('keeps earlier snapshots stable and rebuilds boundaries for replacement lyrics', () => {
    const timeline = createLyricTimeline(duetLines)
    const earlier = timeline.read(1)
    timeline.read(11)
    expect(earlier).toEqual(resolveLyricScene(duetLines, 1))
    const replacement: LyricLine[] = [
      { time: 0, endTime: 0.5, text: 'replacement first' },
      { time: 0.5, endTime: 2, text: 'replacement second' },
    ]
    expect(createLyricTimeline(replacement).read(1).active).toEqual([1])
    expect(timeline.read(1)).toEqual(earlier)
  })
})

describe('lyricTempoScale', () => {
  it('measures the interval from the next sung line, not its harmony line', () => {
    // 把和声当成"下一句"会把间隔算成 0.2s,高亮过渡被压到最小值
    const lines: LyricLine[] = [
      { time: 0, endTime: 4, text: 'main line' },
      { time: 0.2, endTime: 4, text: 'ooh', background: true },
      { time: 6, endTime: 10, text: 'next line' },
    ]
    expect(lyricTempoScale(lines, 0)).toBe(1)
  })

  it('compresses when lines arrive faster than the base transition', () => {
    const lines: LyricLine[] = Array.from({ length: 4 }, (_, index) => ({
      time: index * 0.31,
      text: `Fast ${index}`,
    }))
    const scale = lyricTempoScale(lines, 1)
    expect(scale).toBeGreaterThan(0.18)
    expect(scale).toBeLessThan(1)
  })

  it('never compresses the last line', () => {
    expect(lyricTempoScale([{ time: 0, text: 'only' }], 0)).toBe(1)
  })
})

describe('layoutLyricLines', () => {
  const heights = [40, 40, 24, 40]
  const background = [false, false, true, false]

  it('stacks lines with the gap between them', () => {
    const layout = layoutLyricLines({
      heights,
      background,
      open: [0, 0, 1, 0],
      gap: 30,
      harmonyGap: 8,
    })
    expect(layout.tops).toEqual([0, 70, 118, 172])
    expect(layout.heights).toEqual([40, 40, 24, 40])
    expect(layout.total).toBe(212)
  })

  it('gives a collapsed harmony no room and lets the next line move up', () => {
    const layout = layoutLyricLines({
      heights,
      background,
      open: [0, 0, 0, 0],
      gap: 30,
      harmonyGap: 8,
    })
    // 收起的和声停在主句下沿,后面的行直接接上来
    expect(layout.tops).toEqual([0, 70, 110, 140])
    expect(layout.heights[2]).toBe(0)
    expect(layout.total).toBe(180)
  })

  it('grows a harmony and the gap above it in proportion while it opens', () => {
    const layout = layoutLyricLines({
      heights,
      background,
      open: [0, 0, 0.5, 0],
      gap: 30,
      harmonyGap: 8,
    })
    // 间距 8 × 0.5 = 4,高度 24 × 0.5 = 12:下一行只被顶下去 16
    expect(layout.tops).toEqual([0, 70, 114, 156])
    expect(layout.heights[2]).toBe(12)
  })

  it('places the focused line at the anchor ratio of the viewport', () => {
    const layout = layoutLyricLines({
      heights,
      background,
      open: [0, 0, 0, 0],
      gap: 30,
      harmonyGap: 8,
    })
    // 第 1 行中线在 90,视口 600 的 42% 处是 252 → 偏移 -162
    expect(lyricFocusOffset(layout, 1, 600, 0.42)).toBe(-162)
    // 没有锚点时按第一行
    expect(lyricFocusOffset(layout, -1, 600, 0.42)).toBe(20 - 252)
    expect(lyricFocusOffset({ tops: [], heights: [], total: 0 }, 0, 600, 0.42)).toBe(0)
  })
})
