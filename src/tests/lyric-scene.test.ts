import { describe, expect, it } from 'vitest'
import {
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
