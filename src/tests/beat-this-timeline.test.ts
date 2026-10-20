import { describe, expect, it } from 'vitest'
import {
  createBeatTimelineBuffer,
  sampleBeatTimeline,
  type BeatTimeline,
} from '../core/analysis/beat-timeline'
import {
  blendBeatThisTimeline,
  createBeatThisPartialTimeline,
  createBeatThisTimelineAssembler,
} from '../core/analysis/beat-this-timeline'
import { beatThisWindows } from '../core/analysis/beat-this-prediction'
import { createBeatCheckpoint, validateBeatCheckpoint } from '../core/analysis/beat-checkpoint'

function baseline(): BeatTimeline {
  return {
    durationSeconds: 4,
    stepSeconds: 1 / 60,
    levels: [
      new Float32Array(241),
      new Float32Array(241),
      new Float32Array(241),
      new Float32Array(241),
    ],
    sustain: new Float32Array(241),
  }
}

describe('Beat This! timing with the original HPSS appearance', () => {
  it('restores compact seam checkpoints with identical pixels and never retains full per-window timelines', () => {
    const windows = beatThisWindows(3251, 65)
    const signature = {
      sampleRate: 22050,
      sampleCount: 22050 * 65,
      channels: 1,
      modelId: 'small' as const,
    }
    const part = (offset: number) => {
      const result = createBeatTimelineBuffer(65)
      for (const values of [...result.levels, result.sustain])
        for (let index = 0; index < values.length; index++)
          values[index] = ((index + offset) % 100) / 100
      return result
    }
    const original = createBeatThisTimelineAssembler(65, windows)
    original.add(windows[1]!, part(10))
    const checkpoint = createBeatCheckpoint(
      signature,
      original.timeline,
      new Set([1]),
      1234,
      original.snapshotSeams(),
    )
    validateBeatCheckpoint(checkpoint, signature, windows.length)
    expect(checkpoint.seams).toHaveLength(2)
    expect(checkpoint.seams!.every((seam) => seam.sustain.length === 31)).toBe(true)
    const resumed = createBeatThisTimelineAssembler(65, windows, checkpoint)
    for (const index of [0, 2]) {
      const value = part(index * 20)
      original.add(windows[index]!, value)
      resumed.add(windows[index]!, value)
    }
    expect(resumed.timeline).toEqual(original.timeline)
    expect(resumed.snapshotSeams()).toEqual([])
    expect(() =>
      createBeatThisTimelineAssembler(65, windows, { ...checkpoint, seams: [] }),
    ).toThrow('缺少接缝')
    expect(() =>
      createBeatThisTimelineAssembler(65, windows, {
        ...checkpoint,
        seams: checkpoint.seams!.map((seam) => ({ ...seam, firstFrame: seam.firstFrame + 1 })),
      }),
    ).toThrow('接缝位置无效')
  })

  it('preserves completed middle regions and fills smooth seams in any completion order', () => {
    const windows = beatThisWindows(3251, 65)
    const assembled = createBeatThisTimelineAssembler(65, windows)
    const part = (value: number) => {
      const result = createBeatTimelineBuffer(65)
      for (const level of result.levels) level.fill(value)
      result.sustain.fill(value / 2)
      return result
    }
    assembled.add(windows[1]!, part(0.8))
    expect(assembled.timeline.completedRanges).toEqual([{ startSeconds: 24.25, endSeconds: 47.75 }])
    expect(sampleBeatTimeline(assembled.timeline, 30, 1).level).toBeCloseTo(0.8)
    expect(sampleBeatTimeline(assembled.timeline, 10, 1)).toEqual({ level: 0, sustain: 0 })
    expect(sampleBeatTimeline(assembled.timeline, 24, 1)).toEqual({ level: 0, sustain: 0 })
    const stable = assembled.timeline.levels[0].slice(1455, 2865)
    assembled.add(windows[0]!, part(0.2))
    expect(assembled.timeline.completedRanges).toEqual([{ startSeconds: 0, endSeconds: 47.75 }])
    expect(sampleBeatTimeline(assembled.timeline, 24, 1).level).toBeCloseTo(0.5)
    expect(assembled.timeline.levels[0].slice(1455, 2865)).toEqual(stable)
    assembled.add(windows[2]!, part(0.4))
    expect(assembled.timeline.completedRanges).toEqual([{ startSeconds: 0, endSeconds: 65 }])
    expect(sampleBeatTimeline(assembled.timeline, 48, 1).level).toBeCloseTo(0.6)
    const copy = assembled.timeline.levels[0].slice()
    assembled.add(windows[1]!, part(0))
    expect(assembled.timeline.levels[0]).toEqual(copy)
  })

  it('publishes an independent stable prefix and leaves unbuilt playback positions dark', () => {
    const basic = baseline()
    basic.sustain.fill(0.2)
    basic.levels[3].fill(0.6)
    const prediction = { beats: [0.5, 1, 1.5, 2], downbeats: [0.5] }
    const partial = createBeatThisPartialTimeline(basic, prediction, 2.5)!
    expect(partial.durationSeconds).toBe(4)
    expect(partial.builtUntilSeconds).toBeCloseTo(2 - 1 / 60)
    expect(partial.levels[0].length).toBe(120)
    expect(sampleBeatTimeline(partial, 1, 1).level).toBeGreaterThan(0)
    expect(sampleBeatTimeline(partial, 2.1, 1)).toEqual({ level: 0, sustain: 0 })
    const complete = blendBeatThisTimeline(basic, {
      beats: [...prediction.beats, 2.5, 3],
      downbeats: [0.5, 2.5],
    })
    partial.levels.forEach((level, index) =>
      expect(level).toEqual(complete.levels[index]!.slice(0, level.length)),
    )
    partial.sustain.fill(0)
    expect(basic.sustain[0]).toBeCloseTo(0.2)
  })

  it('advances silent prefixes without predicting nonexistent beats near the window boundary', () => {
    const partial = createBeatThisPartialTimeline(baseline(), { beats: [], downbeats: [] }, 2)!
    expect(partial.builtUntilSeconds).toBeCloseTo(1.8)
    expect(partial.levels.every((values) => values.every((value) => value === 0))).toBe(true)
    expect(createBeatThisPartialTimeline(baseline(), { beats: [0], downbeats: [] }, 0.1)).toBeNull()
  })

  it('stays dark on silent audio even if the model hallucinates a regular beat grid', () => {
    const basic = baseline()
    const result = blendBeatThisTimeline(basic, { beats: [0, 0.5, 1, 1.5, 2], downbeats: [0] })
    expect(result.levels.every((level) => level.every((value) => value === 0))).toBe(true)
    expect(result.sustain).toBe(basic.sustain)
  })

  it('aligns flashes to model time, preserves relative DSP strengths and four densities', () => {
    const basic = baseline()
    // The legacy detector peaks 33ms after each model beat.
    basic.levels[3][32] = 0.3
    basic.levels[3][62] = 0.8
    basic.levels[3][92] = 0.5
    basic.levels[3][47] = 0.45 // real offbeat near 0.75s
    const original = basic.levels[3].slice()
    const result = blendBeatThisTimeline(basic, { beats: [0.5, 1, 1.5], downbeats: [0.5] })
    expect(result.levels[1][30]).toBeCloseTo(0.3 * 1.12)
    expect(result.levels[1][60]).toBeCloseTo(0.8)
    expect(result.levels[1][29]).toBe(0)
    expect(result.levels[1][31]).toBeLessThan(result.levels[1][30]!)
    expect(result.levels[0][60]).toBeLessThan(0.1) // second beat is skipped at 0.5×
    expect(result.levels[2][45]).toBeCloseTo(0.45)
    expect(result.levels[1][45]).toBeLessThan(result.levels[2][45]!)
    expect(new Set(result.levels.map((values) => values.buffer)).size).toBe(4)
    expect(basic.levels[3]).toEqual(original)
  })

  it('does not fabricate higher-density subdivisions from the decay of one drum hit', () => {
    const basic = baseline()
    for (let frame = 30; frame < 100; frame += 1)
      basic.levels[3][frame] = Math.exp(-(frame - 30) / 12)
    const result = blendBeatThisTimeline(basic, { beats: [0.5, 1.5], downbeats: [] })
    for (const level of result.levels) {
      for (let frame = 32; frame < 89; frame += 1)
        expect(level[frame]).toBeLessThanOrEqual(level[frame - 1]!)
    }
  })
})
