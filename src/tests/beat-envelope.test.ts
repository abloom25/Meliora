import { describe, expect, it } from 'vitest'
import {
  BEAT_FLASH_RATE_STEPS,
  createBeatEnvelope,
  sanitizeBeatFlashRate,
  type BeatFlashRate,
} from '../utils/beat-envelope'

const DT = 1 / 60

// 合成低频打击功率:每拍一个"咚"(快起、指数衰减),叠一层持续的低音铺底
function runKicks(options: {
  bpm: number
  seconds: number
  pedestal?: number
  rate?: BeatFlashRate
  subdivide?: number
}) {
  const envelope = createBeatEnvelope()
  const period = 60000 / options.bpm
  const levels: number[] = []
  const frames = Math.round(options.seconds / DT)
  const hitSpacing = period / (options.subdivide ?? 1)
  for (let frame = 0; frame < frames; frame += 1) {
    const now = frame * DT * 1000
    const sinceHit = now % hitSpacing
    const kick = Math.exp(-sinceHit / 60)
    const power = (options.pedestal ?? 0) + kick * 0.02
    levels.push(
      envelope.update({
        power,
        dtSeconds: DT,
        nowMs: now,
        periodMs: period,
        rate: options.rate ?? 1,
      }),
    )
  }
  return { levels }
}

function rises(levels: number[]) {
  const out: number[] = []
  let last = -Infinity
  for (let i = 3; i < levels.length; i += 1) {
    const before = Math.min(levels[i - 1] ?? 0, levels[i - 2] ?? 0, levels[i - 3] ?? 0)
    if ((levels[i] ?? 0) - before > 0.35 && i - last >= 6) {
      out.push(i)
      last = i
    }
  }
  return out
}

describe('beat envelope', () => {
  it('pulses once per kick and falls back down between kicks', () => {
    const { levels } = runKicks({ bpm: 120, seconds: 10 })
    const late = levels.slice(300)
    const count = rises(late).length
    // 5s × 2 拍/s = 10 次起音
    expect(count).toBeGreaterThanOrEqual(9)
    expect(count).toBeLessThanOrEqual(11)
    expect(Math.max(...late)).toBeGreaterThan(0.85)
    // 拍间中点已经明显回落
    let mid = 0
    for (let i = 0; i < late.length; i += 1) if (i % 30 === 15) mid = Math.max(mid, late[i] ?? 0)
    expect(mid).toBeLessThan(0.5)
  })

  it('ignores a steady low pedestal', () => {
    const envelope = createBeatEnvelope()
    let level = 0
    for (let frame = 0; frame < 300; frame += 1) {
      level = envelope.update({
        power: 0.05,
        dtSeconds: DT,
        nowMs: frame * DT * 1000,
        periodMs: 500,
        rate: 1,
      })
    }
    expect(level).toBeLessThan(0.05)
  })

  it('re-scales to a much quieter section within a few seconds', () => {
    const envelope = createBeatEnvelope()
    const period = 500
    let now = 0
    const step = (power: number) => {
      now += DT * 1000
      return envelope.update({ power, dtSeconds: DT, nowMs: now, periodMs: period, rate: 1 })
    }
    // 4s 很响的段落
    for (let frame = 0; frame < 240; frame += 1) {
      const sinceHit = (frame * DT * 1000) % period
      step(Math.exp(-sinceHit / 60) * 1)
    }
    // 之后是响度只有 1/20 的段落:6s 后仍应满幅脉冲
    let peak = 0
    for (let frame = 0; frame < 360; frame += 1) {
      const sinceHit = (frame * DT * 1000) % period
      const level = step(Math.exp(-sinceHit / 60) * 0.05)
      if (frame > 240) peak = Math.max(peak, level)
    }
    expect(peak).toBeGreaterThan(0.8)
  })

  it('applies the flash-rate gate to dense eighth-note hits', () => {
    const perBeat = rises(
      runKicks({ bpm: 120, seconds: 10, subdivide: 2, rate: 1 }).levels.slice(300),
    ).length
    const perHalf = rises(
      runKicks({ bpm: 120, seconds: 10, subdivide: 2, rate: 2 }).levels.slice(300),
    ).length
    const perTwo = rises(
      runKicks({ bpm: 120, seconds: 10, subdivide: 2, rate: 0.5 }).levels.slice(300),
    ).length
    // 5s:八分音符 20 次击点;每拍档位只放 10 次左右,每半拍放全部,每 2 拍只放 5 次左右
    expect(perBeat).toBeGreaterThanOrEqual(9)
    expect(perBeat).toBeLessThanOrEqual(11)
    expect(perHalf).toBeGreaterThanOrEqual(18)
    expect(perTwo).toBeGreaterThanOrEqual(4)
    expect(perTwo).toBeLessThanOrEqual(6)
  })

  it('lengthens the release for slow tempos', () => {
    const fast = runKicks({ bpm: 160, seconds: 6 }).levels
    const slow = runKicks({ bpm: 60, seconds: 6 }).levels
    // 起音后 150ms 的残留亮度:慢歌留光更多
    const after = (levels: number[], period: number) => {
      const start = Math.round((4 * period) / (DT * 1000))
      return levels[start + 9] ?? 0
    }
    expect(after(slow, 1000)).toBeGreaterThan(after(fast, 375) + 0.1)
  })
  it('snaps arbitrary values to the nearest detent', () => {
    expect(sanitizeBeatFlashRate(0.6)).toBe(0.5)
    expect(sanitizeBeatFlashRate(1.3)).toBe(1)
    expect(sanitizeBeatFlashRate(2.6)).toBe(2)
    expect(sanitizeBeatFlashRate(9)).toBe(4)
    expect(sanitizeBeatFlashRate('nope')).toBe(1)
    expect(sanitizeBeatFlashRate(-1, 2)).toBe(2)
    expect(BEAT_FLASH_RATE_STEPS).toEqual([0.5, 1, 2, 4])
  })
})
