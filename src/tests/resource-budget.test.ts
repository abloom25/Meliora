import { describe, expect, it } from 'vitest'
import { createFrameBudget, shouldConserveAudioBuffer } from '../core/playback/resource-budget'

describe('adaptive playback budget', () => {
  it('requires sustained jank and recovers one step at a time after several smooth seconds', () => {
    const budget = createFrameBudget()
    let time = 1
    let level = 0
    const frames = (count: number, delta: number) => {
      for (let i = 0; i < count; i++) {
        time += delta
        level = budget.sample(time)
      }
    }
    frames(60, 16)
    frames(1, 120)
    frames(65, 16)
    expect(level).toBe(0)
    frames(50, 70)
    expect(level).toBe(2)
    frames(100, 16)
    expect(level).toBe(2)
    frames(400, 16)
    expect(level).toBe(1)
    frames(400, 16)
    expect(level).toBe(0)
  })
  it('ignores long suspension gaps rather than counting them as sustained jank', () => {
    const budget = createFrameBudget()
    expect(budget.sample(1)).toBe(0)
    expect(budget.sample(90000)).toBe(0)
    budget.reset()
    expect(budget.sample(120000)).toBe(0)
  })
  it('uses separate low/high buffer thresholds and permits fully buffered endings', () => {
    const sample = {
      wasConstrained: false,
      playing: true,
      waiting: false,
      bufferedSeconds: 2,
      remainingSeconds: 90,
    }
    expect(shouldConserveAudioBuffer(sample)).toBe(true)
    expect(shouldConserveAudioBuffer({ ...sample, bufferedSeconds: 5 })).toBe(false)
    expect(shouldConserveAudioBuffer({ ...sample, wasConstrained: true, bufferedSeconds: 5 })).toBe(
      true,
    )
    expect(shouldConserveAudioBuffer({ ...sample, wasConstrained: true, bufferedSeconds: 8 })).toBe(
      false,
    )
    expect(shouldConserveAudioBuffer({ ...sample, remainingSeconds: 2 })).toBe(false)
    expect(shouldConserveAudioBuffer({ ...sample, playing: false })).toBe(false)
    expect(shouldConserveAudioBuffer({ ...sample, bufferedSeconds: Infinity })).toBe(false)
  })
})
