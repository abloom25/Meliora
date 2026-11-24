import { describe, expect, it } from 'vitest'
import { createBeatTimelineBuffer, createBeatTimelineBuilder } from '../core/analysis/beat-timeline'
import { equalPowerGains, measureMixSilence, planSmartMix } from '../core/audio/smart-mix'

function pulseTrack(duration: number, period: number, phase: number, energy = 0.2) {
  const timeline = createBeatTimelineBuffer(duration, 0.01)
  timeline.completedRanges = [{ startSeconds: 0, endSeconds: duration }]
  timeline.sustain.fill(energy)
  for (let beat = phase; beat < duration; beat += period)
    timeline.levels[1][Math.round(beat / timeline.stepSeconds)] = 1
  return { timeline }
}

describe('smart mix', () => {
  it('places two analysed PCM drum tracks on the same beat at normal playback speed', () => {
    const sampleRate = 24000
    const duration = 16
    function analyseDrums(firstBeat: number) {
      const samples = Float32Array.from({ length: sampleRate * duration }, (_, i) => {
        const time = i / sampleRate - firstBeat
        if (time < 0) return 0
        const beat = time % 0.5
        return 0.2 * Math.exp(-beat * 35) * Math.sin(2 * Math.PI * 100 * beat)
      })
      const builder = createBeatTimelineBuilder([samples], sampleRate)
      builder.process(Math.ceil(duration * 60) + 1)
      return { timeline: builder.finish() }
    }
    const mix = planSmartMix(duration, duration, analyseDrums(0.36), analyseDrums(0.14))!
    const phase = mix.startAt + 0.14 - 0.36
    expect(mix.seconds).toBeGreaterThan(1.25)
    expect(Math.abs(phase - Math.round(phase / 0.5) * 0.5)).toBeLessThan(0.04)
  })

  it('aligns the incoming first beat to an outgoing beat at the original tempo', () => {
    const plan = planSmartMix(60, 30, pulseTrack(60, 0.5, 0.28), pulseTrack(30, 0.5, 0.12))!
    expect((plan.startAt + 0.12 - 0.28) / 0.5).toBeCloseTo(
      Math.round((plan.startAt + 0.12 - 0.28) / 0.5),
    )
    expect(plan.seconds).toBeGreaterThan(3)
    expect(plan.seconds + plan.startAt).toBeCloseTo(60)
    expect(plan.offset).toBe(0)
  })

  it('limits competing beats and short clips, and rejects unknown durations', () => {
    expect(planSmartMix(60, 30, pulseTrack(60, 0.5, 0), pulseTrack(30, 0.68, 0))!.seconds).toBe(1)
    const unavailable = { timeline: null }
    expect(planSmartMix(60, 4, unavailable, unavailable)!.seconds).toBe(1)
    expect(planSmartMix(Infinity, 30, unavailable, unavailable)).toBeNull()
    expect(planSmartMix(60, 0, unavailable, unavailable)).toBeNull()
    const partial = pulseTrack(60, 0.5, 0)
    partial.timeline.completedRanges = [{ startSeconds: 0, endSeconds: 12 }]
    expect(planSmartMix(60, 30, partial, pulseTrack(30, 0.5, 0))!.seconds).toBe(1.25)
  })

  it('aligns supported beats despite a stray pickup, weak subdivisions and missing hits', () => {
    const head = pulseTrack(30, 0.5, 0.36)
    const tail = pulseTrack(60, 0.5, 0.18)
    head.timeline.levels[1][2] = 0.95
    for (let i = 61; i < 800; i += 50) head.timeline.levels[1][i] = 0.32
    for (const i of [136, 336, 536, 736]) head.timeline.levels[1][i] = 0
    const plan = planSmartMix(60, 30, tail, head)!
    const beat = (plan.startAt + 0.36 - 0.18) / 0.5
    expect(beat).toBeCloseTo(Math.round(beat))
    expect(plan.seconds).toBeGreaterThan(3)
    expect(plan.offset).toBe(0)
  })

  it('shortens the beat-aligned overlap to fit drift without discarding the intro', () => {
    const tail = pulseTrack(60, 0.5, 0.18)
    const head = pulseTrack(30, 0.515, 0.12)
    const plan = planSmartMix(60, 30, tail, head)!
    expect(plan.seconds).toBeGreaterThan(1.25)
    expect((plan.seconds / 0.515) * 0.015).toBeLessThanOrEqual(0.5 / 8)
    const beat = (plan.startAt + 0.12 - 0.18) / 0.5
    expect(beat).toBeCloseTo(Math.round(beat))
    expect(plan.offset).toBe(0)
  })

  it('waits for the next supported beat when a media update misses the ideal cue', () => {
    const tail = pulseTrack(60, 0.5, 0.28)
    const head = pulseTrack(30, 0.5, 0.12)
    const ideal = planSmartMix(60, 30, tail, head)!
    const late = planSmartMix(60, 30, tail, head, ideal.startAt + 0.13)!
    expect(late.startAt - ideal.startAt).toBeCloseTo(0.5)
    expect(late.startAt + late.seconds).toBeCloseTo(60)
  })

  it('uses a short handoff when the incoming beat starts after the overlap', () => {
    const head = pulseTrack(30, 0.5, 0.12)
    head.timeline.levels[1].fill(0, 0, 510)
    expect(planSmartMix(60, 30, pulseTrack(60, 0.5, 0), head)!.seconds).toBe(1)
  })

  it('preserves quiet material on either stereo channel and leaves a safety margin', () => {
    const left = new Float32Array(10000)
    const right = new Float32Array(10000)
    left.fill(0.1, 900, 8000)
    right.fill(0.0002, 500, 9500)
    const silence = measureMixSilence([left, right], 1000)
    expect(silence.leading).toBeCloseTo(0.45)
    expect(silence.trailing).toBeCloseTo(0.45)
    const track = { timeline: null, silence }
    const plan = planSmartMix(10, 10, track, track)!
    expect(plan.offset).toBeCloseTo(0.45)
    expect(plan.startAt + plan.seconds).toBeCloseTo(9.55)
  })

  it('maintains unit summed power throughout the overlap', () => {
    for (const t of [0, 0.1, 0.5, 0.7, 1]) {
      const gains = equalPowerGains(t)
      expect(gains.incoming ** 2 + gains.outgoing ** 2).toBeCloseTo(1)
    }
    expect(equalPowerGains(1)).toEqual({ incoming: 1, outgoing: 0 })
  })
})
