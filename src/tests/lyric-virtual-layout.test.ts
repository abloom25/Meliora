import { describe, expect, it } from 'vitest'
import { layoutLyricLines } from '../core/lyrics'
import { VirtualLyricLayout } from '../core/lyrics/virtual-layout'

describe('VirtualLyricLayout', () => {
  it('matches the full variable-height layout, including leading and collapsed harmonies', () => {
    const heights = [24, 30, 75, 42, 60, 25, 110]
    const background = [true, true, false, true, false, true, false]
    const layout = new VirtualLyricLayout(heights.length)
    for (const open of [
      [0, 0, 0, 0, 0, 0, 0],
      [0.5, 1, 0, 0.25, 0, 0.8, 0],
      [1, 0, 0, 1, 0, 0, 0],
    ]) {
      const expected = layoutLyricLines({ heights, background, open, gap: 28, harmonyGap: 8 })
      heights.forEach((height, index) =>
        layout.set(index, height, background[index] ? 8 : 28, background[index] ? open[index] : 1),
      )
      heights.forEach((_, index) => {
        expect(layout.top(index)).toBeCloseTo(expected.tops[index]!, 8)
        expect(layout.height(index)).toBeCloseTo(expected.heights[index]!, 8)
      })
      expect(layout.window(35, 190)).toEqual(
        expected.tops.flatMap((top, index) =>
          expected.heights[index]! > 0 && top + expected.heights[index]! > 35 && top < 190
            ? [index]
            : [],
        ),
      )
    }
  })

  it('updates measurements and skips thousands of collapsed rows during window queries', () => {
    const layout = new VirtualLyricLayout(10002)
    layout.set(0, 40, 28)
    layout.set(10001, 80, 28)
    expect(layout.window(-50, 200)).toEqual([0, 10001])
    expect(layout.top(10001)).toBe(68)
    layout.set(0, 100, 28)
    expect(layout.top(10001)).toBe(128)
    expect(layout.window(110, 150)).toEqual([10001])
    layout.set(0, 100, 28, 0)
    expect(layout.top(10001)).toBe(0)
    expect(layout.window(0, 100)).toEqual([10001])
  })

  it('handles an empty layout without manufacturing visible rows', () => {
    const layout = new VirtualLyricLayout(0)
    expect(layout.window(-100, 500)).toEqual([])
    expect(layout.top(0)).toBe(0)
  })
})
