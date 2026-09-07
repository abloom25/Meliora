import { describe, expect, it } from 'vitest'
import { createLyricClock } from '../utils/lyric-clock'

describe('createLyricClock', () => {
  it('stays frozen until resumed', () => {
    const clock = createLyricClock()
    clock.anchor(12, 1000)

    expect(clock.running).toBe(false)
    expect(clock.read(5000)).toBe(12)
  })

  it('extrapolates linearly from the anchor while running', () => {
    const clock = createLyricClock()
    clock.resume(10, 1000)

    expect(clock.read(1000)).toBeCloseTo(10, 5)
    expect(clock.read(1500)).toBeCloseTo(10.5, 5)
  })

  it('caps extrapolation so a stalled buffer cannot run ahead of the audio', () => {
    const clock = createLyricClock({ maxDriftSeconds: 1 })
    clock.resume(10, 1000)

    // timeupdate 停发 5s:读数最多超前 1s,恢复后不会整体回跳
    expect(clock.read(6000)).toBeCloseTo(11, 5)
  })

  it('re-anchors on every timeupdate so drift is corrected', () => {
    const clock = createLyricClock()
    clock.resume(10, 1000)
    expect(clock.read(1300)).toBeCloseTo(10.3, 5)

    clock.anchor(10.5, 1300)
    expect(clock.read(1300)).toBeCloseTo(10.5, 5)
  })

  it('does not jump across the pause when resuming', () => {
    const clock = createLyricClock()
    clock.resume(10, 1000)
    clock.freeze()

    // 暂停 60s 后恢复:必须以当前播放位置重锚,否则首帧会跳到未来
    clock.resume(10, 61000)
    expect(clock.read(61000)).toBeCloseTo(10, 5)
  })

  it('scales extrapolation with the playback rate', () => {
    const clock = createLyricClock()
    clock.resume(0, 0)
    clock.setRate(2)

    expect(clock.read(500)).toBeCloseTo(1, 5)
  })

  it('ignores invalid anchors, rates and timestamps', () => {
    const clock = createLyricClock()
    clock.resume(4, 0)
    clock.anchor(Number.NaN, 100)
    clock.setRate(0)
    clock.setRate(Number.NaN)

    expect(clock.read(1000)).toBeCloseTo(5, 5)
    expect(clock.read(Number.NaN)).toBe(4)
  })

  it('never runs backwards when a stamp predates the anchor', () => {
    const clock = createLyricClock()
    clock.resume(20, 5000)

    expect(clock.read(4000)).toBe(20)
  })
})
