import { describe, expect, it } from 'vitest'
import { createTempoRuler } from '../core/analysis/tempo-ruler'

function createRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 音乐化的合成 ODF(10ms 槽):底鼓 1/3 拍、军鼓 2/4 拍、八分音符 hi-hat、贝斯推进,
// 外加随机游走底噪与散落的非节拍击点。干净的点击轨测不出八度歧义
function synthesizeOdf(bpm: number, seconds: number, seed: number) {
  const random = createRandom(seed)
  const total = seconds * 100
  const slots = new Float32Array(total)
  const period = 60000 / bpm
  const add = (timeMs: number, amplitude: number) => {
    const slot = Math.round(timeMs / 10)
    ;[1, 0.45, 0.15].forEach((factor, offset) => {
      const index = slot + offset
      if (index >= 0 && index < total) slots[index] = (slots[index] ?? 0) + amplitude * factor
    })
  }
  const jitter = () => (random() - 0.5) * 12
  for (let beat = 0; beat * period < seconds * 1000; beat += 1) {
    const at = beat * period
    add(at + jitter(), beat % 2 === 0 ? 1 : 0.85)
    add(at + jitter(), 0.3 + random() * 0.12)
    add(at + period / 2 + jitter(), 0.3 + random() * 0.12)
    add(at + jitter(), 0.35)
    if (random() < 0.5) add(at + period * 0.75 + jitter(), 0.25)
  }
  let floor = 0.05
  for (let slot = 0; slot < total; slot += 1) {
    floor = Math.max(0.02, Math.min(0.12, floor + (random() - 0.5) * 0.01))
    slots[slot] = (slots[slot] ?? 0) + floor + Math.sin(slot / 37) * 0.015 + 0.015
    if (random() < 0.008) add(slot * 10, 0.25 + random() * 0.3)
  }
  return slots
}

function runRuler(slots: Float32Array) {
  const ruler = createTempoRuler()
  for (let slot = 0; slot < slots.length; slot += 1) {
    ruler.pushSample(slot * 10 + 4, slots[slot] ?? 0)
    ruler.pushSample(slot * 10 + 10, 0)
  }
  return ruler.getState()
}

describe('tempo ruler', () => {
  for (const bpm of [90, 100, 110, 128, 140, 160, 175]) {
    it(`measures ${bpm} BPM within 2% on a dense groove`, () => {
      const state = runRuler(synthesizeOdf(bpm, 12, bpm))
      expect(state.locked).toBe(true)
      expect(Math.abs(state.bpm - bpm) / bpm).toBeLessThan(0.02)
    })
  }

  for (const bpm of [60, 75]) {
    it(`never drops below the beat level at ${bpm} BPM`, () => {
      // 慢歌允许落在八分音符层(尺子偏快无害),但不能落到半速
      const state = runRuler(synthesizeOdf(bpm, 12, bpm))
      expect(state.locked).toBe(true)
      const ratio = state.bpm / bpm
      expect(Math.abs(ratio - 1) < 0.02 || Math.abs(ratio - 2) < 0.02).toBe(true)
    })
  }

  it('stays unlocked on aperiodic noise', () => {
    const random = createRandom(7)
    const ruler = createTempoRuler()
    for (let slot = 0; slot < 1200; slot += 1) {
      ruler.pushSample(slot * 10 + 5, 0.05 + random() * 0.04)
    }
    expect(ruler.getState().locked).toBe(false)
  })

  it('lets confidence decay once the music stops', () => {
    const ruler = createTempoRuler()
    const slots = synthesizeOdf(120, 8, 3)
    for (let slot = 0; slot < 1500; slot += 1) {
      ruler.pushSample(slot * 10 + 5, slot < slots.length ? (slots[slot] ?? 0) : 0)
    }
    expect(ruler.getState().locked).toBe(false)
  })
})
