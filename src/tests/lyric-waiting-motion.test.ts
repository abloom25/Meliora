import { describe, expect, it } from 'vitest'
import type { LyricWaitingInterval } from '../core/lyrics/interlude'
import { resolveLyricWaitingMotion } from '../core/lyrics/waiting-motion'

const interval: LyricWaitingInterval = {
  kind: 'interlude',
  start: 10,
  end: 20,
  previousAnchor: 0,
  nextAnchor: 1,
}

describe('lyric waiting motion', () => {
  it('keeps the indicator inside its exact media interval', () => {
    for (const time of [9, 20, 21, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveLyricWaitingMotion(time, interval).opacity).toBe(0)
    }
    expect(resolveLyricWaitingMotion(10, interval).opacity).toBe(0)
    expect(resolveLyricWaitingMotion(10.1, interval).opacity).toBeGreaterThan(0)
  })

  it('enters with staggered dots and progressively fills them across the wait', () => {
    const entering = resolveLyricWaitingMotion(10.1, interval)
    expect(entering.dotOpacities[0]).toBeGreaterThan(entering.dotOpacities[1])
    expect(entering.dotOpacities[1]).toBeGreaterThan(entering.dotOpacities[2])
    const middle = resolveLyricWaitingMotion(15, interval)
    expect(middle.dotOpacities[0]).toBeCloseTo(0.9)
    expect(middle.dotOpacities[1]).toBeGreaterThan(0.2)
    expect(middle.dotOpacities[2]).toBeCloseTo(0.2)
  })

  it('breathes smoothly and joins the exit without a scale discontinuity', () => {
    expect(resolveLyricWaitingMotion(12.25, interval).scale).toBeCloseTo(1.25)
    const before = resolveLyricWaitingMotion(18.99999, interval)
    const exit = resolveLyricWaitingMotion(19, interval)
    expect(before.scale).toBeCloseTo(exit.scale, 6)
    expect(before.dotOpacities[2]).toBeCloseTo(exit.dotOpacities[2], 5)
  })

  it('finishes the last dot before shrinking and fading within the last second', () => {
    const charged = resolveLyricWaitingMotion(19.75, interval)
    const departing = resolveLyricWaitingMotion(19.875, interval)
    for (const opacity of charged.dotOpacities) expect(opacity).toBeCloseTo(0.9)
    expect(charged.scale).toBeCloseTo(1.25)
    expect(charged.opacity).toBe(1)
    expect(departing.scale).toBeLessThan(1.25)
    expect(departing.opacity).toBeGreaterThan(0)
    expect(departing.opacity).toBeLessThan(1)
    expect(resolveLyricWaitingMotion(20, interval).opacity).toBe(0)
  })

  it('keeps a short intro steady before its exit instead of squeezing in a breath', () => {
    const intro = { ...interval, kind: 'intro' as const, start: 0, end: 3, previousAnchor: -1 }
    expect(resolveLyricWaitingMotion(1, intro).scale).toBe(1)
    expect(resolveLyricWaitingMotion(1.9, intro).scale).toBe(1)
    expect(resolveLyricWaitingMotion(2.5, intro).scale).toBeGreaterThan(1)
  })

  it('freezes at the same media time and reproduces seeks without state', () => {
    const paused = resolveLyricWaitingMotion(15.7, interval)
    resolveLyricWaitingMotion(19.9, interval)
    resolveLyricWaitingMotion(10.1, interval)
    expect(resolveLyricWaitingMotion(15.7, interval)).toEqual(paused)
    expect(resolveLyricWaitingMotion(19.95, interval).opacity).toBeGreaterThan(0)
  })

  it('shows identical static dots with animation disabled until the actual end', () => {
    const still = resolveLyricWaitingMotion(10, interval, false)
    expect(still).toEqual({ opacity: 1, scale: 1, dotOpacities: [0.65, 0.65, 0.65] })
    expect(resolveLyricWaitingMotion(19.99, interval, false)).toEqual(still)
    expect(resolveLyricWaitingMotion(20, interval, false).opacity).toBe(0)
  })

  it('keeps all output finite and bounded, including tiny and invalid intervals', () => {
    for (const duration of [0.001, 0.2, 3, 7, 60]) {
      const candidate = { ...interval, start: 0, end: duration }
      for (let step = 0; step < 100; step += 1) {
        const motion = resolveLyricWaitingMotion((step / 100) * duration, candidate)
        expect(motion.scale).toBeGreaterThanOrEqual(0.4)
        expect(motion.scale).toBeLessThanOrEqual(1.25)
        for (const opacity of [motion.opacity, ...motion.dotOpacities]) {
          expect(opacity).toBeGreaterThanOrEqual(0)
          expect(opacity).toBeLessThanOrEqual(1)
        }
      }
    }
    for (const end of [10, 9, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveLyricWaitingMotion(10, { ...interval, end }).opacity).toBe(0)
    }
  })
})
