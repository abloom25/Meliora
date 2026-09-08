import { describe, expect, it } from 'vitest'
import { createRealtimeHpss } from '../utils/hpss'

const BINS = 64

// 持续的窄带音(横线):bin 20 附近能量常在
function toneFrame(level = 1) {
  const frame = new Float32Array(BINS).fill(0.02)
  frame[19] = level * 0.5
  frame[20] = level
  frame[21] = level * 0.5
  return frame
}

// 宽频瞬态(竖线):整段频谱同时抬升
function clickFrame(base: Float32Array, level = 0.8) {
  const frame = new Float32Array(base)
  for (let bin = 2; bin < BINS - 2; bin += 1) frame[bin] = (frame[bin] ?? 0) + level
  return frame
}

describe('realtime hpss', () => {
  it('assigns a sustained tone to the harmonic side once history fills', () => {
    const hpss = createRealtimeHpss({ bins: BINS, timeFrames: 9, frequencyHalfWidth: 4 })
    let mask = hpss.process(toneFrame()).percussiveMask
    for (let i = 0; i < 12; i += 1) mask = hpss.process(toneFrame()).percussiveMask
    expect(mask[20]).toBeLessThan(0.2)
  })

  it('assigns a broadband click to the percussive side without look-ahead', () => {
    const hpss = createRealtimeHpss({ bins: BINS, timeFrames: 9, frequencyHalfWidth: 4 })
    for (let i = 0; i < 12; i += 1) hpss.process(toneFrame())
    // 击点出现的当帧就应判为打击成分:时间中值还没被它污染
    const mask = hpss.process(clickFrame(toneFrame())).percussiveMask
    expect(mask[40]).toBeGreaterThan(0.8)
    // 音的 bin 上仍是谐波(击点只把该 bin 抬了一点)
    expect(mask[20]).toBeLessThan(0.6)
  })

  it('lets a click that persists drift back to harmonic', () => {
    const hpss = createRealtimeHpss({ bins: BINS, timeFrames: 5, frequencyHalfWidth: 4 })
    for (let i = 0; i < 8; i += 1) hpss.process(toneFrame())
    const frame = clickFrame(toneFrame())
    let mask = hpss.process(frame).percussiveMask
    const first = mask[40] ?? 0
    for (let i = 0; i < 6; i += 1) mask = hpss.process(frame).percussiveMask
    expect(first).toBeGreaterThan(0.8)
    expect(mask[40]).toBeLessThan(0.6)
  })

  it('reset clears the temporal history', () => {
    const hpss = createRealtimeHpss({ bins: BINS, timeFrames: 5, frequencyHalfWidth: 4 })
    for (let i = 0; i < 8; i += 1) hpss.process(toneFrame())
    hpss.reset()
    // 历史清空后第一帧只有自己,时间中值 = 自身,窄带音相对频率中值仍偏谐波但不会被旧历史左右
    const mask = hpss.process(clickFrame(toneFrame())).percussiveMask
    expect(Number.isFinite(mask[40] ?? Number.NaN)).toBe(true)
  })
})
