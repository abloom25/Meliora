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
    expect(partial.builtUntilSeconds).toBeCloseTo(2 - 0.05 - 1 / 60)
    expect(partial.levels[0].length).toBe(117)
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

  it('does not publish the last corrected beat before its future release is known', () => {
    const basic = baseline()
    basic.levels[3][117] = 0.8 // Last prediction at 2s corrects 50ms earlier.
    const partial = createBeatThisPartialTimeline(basic, { beats: [1.5, 2], downbeats: [] }, 2.5)!
    const complete = blendBeatThisTimeline(basic, {
      beats: [1.5, 2, 2.8],
      downbeats: [],
    })
    expect(partial.builtUntilSeconds).toBeLessThan(1.95)
    partial.levels.forEach((values, index) =>
      expect(values).toEqual(complete.levels[index]!.slice(0, values.length)),
    )
    expect(complete.levels[1][117]).toBeCloseTo(0.8)
  })

  it('stays dark on silent audio even if the model hallucinates a regular beat grid', () => {
    const basic = baseline()
    const result = blendBeatThisTimeline(basic, { beats: [0, 0.5, 1, 1.5, 2], downbeats: [0] })
    expect(result.levels.every((level) => level.every((value) => value === 0))).toBe(true)
    expect(result.sustain).toBe(basic.sustain)
  })

  it('refines model time to sharp rises, preserving relative DSP strengths and four densities', () => {
    const basic = baseline()
    // Sharp envelope rises land 33ms after the model beat, within the correction limit.
    basic.levels[3][32] = 0.3
    basic.levels[3][62] = 0.8
    basic.levels[3][92] = 0.5
    basic.levels[3][47] = 0.45 // real offbeat near 0.75s
    const original = basic.levels[3].slice()
    const result = blendBeatThisTimeline(basic, { beats: [0.5, 1, 1.5], downbeats: [0.5] })
    expect(result.levels[1][32]).toBeCloseTo(0.3 * 1.12)
    expect(result.levels[1][62]).toBeCloseTo(0.8)
    expect(result.levels[1][31]).toBe(0)
    expect(result.levels[1][33]).toBeLessThan(result.levels[1][32]!)
    expect(result.levels[0][60]).toBeLessThan(0.1) // second beat is skipped at 0.5×
    expect(result.levels[2][47]).toBeCloseTo(0.45)
    expect(result.levels[1][47]).toBeLessThan(result.levels[2][47]!)
    expect(new Set(result.levels.map((values) => values.buffer)).size).toBe(4)
    expect(basic.levels[3]).toEqual(original)
  })

  it.each([57, 63])('moves a model beat to the reliable nearby rise at frame %i', (frame) => {
    const basic = baseline()
    for (let index = frame; index < 100; index += 1)
      basic.levels[3][index] = 0.8 * Math.exp(-(index - frame) / 10)
    const result = blendBeatThisTimeline(basic, { beats: [1], downbeats: [1] })
    expect(result.levels[1][frame - 1]).toBe(0)
    expect(result.levels[1][frame]).toBeCloseTo(0.8 * 1.12)
    expect(result.levels[1][frame + 1]).toBeLessThan(result.levels[1][frame]!)
  })

  it('keeps model timing without a reliable rise, including slow attacks and long decay tails', () => {
    const steady = baseline()
    steady.levels[3].fill(0.6)
    const slowAttack = baseline()
    for (let frame = 54; frame <= 70; frame += 1) slowAttack.levels[3][frame] = (frame - 54) * 0.05
    const decay = baseline()
    for (let frame = 40; frame < 100; frame += 1)
      decay.levels[3][frame] = Math.exp(-(frame - 40) / 40)
    for (const basic of [steady, slowAttack, decay]) {
      const result = blendBeatThisTimeline(basic, { beats: [1], downbeats: [] })
      expect(result.levels[1][59]).toBe(0)
      expect(result.levels[1][60]).toBeGreaterThan(0)
      expect(result.levels[1][61]).toBeLessThan(result.levels[1][60]!)
    }
  })

  it('keeps sharp transients outside the correction radius from moving a model beat', () => {
    const basic = baseline()
    basic.levels[3].fill(0.2)
    basic.levels[3][56] = 0.8 // 66.7ms early, outside the permitted window.
    const result = blendBeatThisTimeline(basic, { beats: [1], downbeats: [] })
    expect(result.levels[1][59]).toBe(0)
    expect(result.levels[1][60]).toBeCloseTo(0.2)
  })

  it('does not choose arbitrarily between equally plausible transients but accepts a clear one', () => {
    const basic = baseline()
    basic.levels[3][58] = 0.7
    basic.levels[3][62] = 0.7
    const ambiguous = blendBeatThisTimeline(basic, { beats: [1], downbeats: [] })
    expect(ambiguous.levels[1][59]).toBe(0)
    expect(ambiguous.levels[1][60]).toBeCloseTo(0.7)
    basic.levels[3][62] = 0.2
    const clear = blendBeatThisTimeline(basic, { beats: [1], downbeats: [] })
    expect(clear.levels[1][57]).toBe(0)
    expect(clear.levels[1][58]).toBeCloseTo(0.7)
  })

  it('keeps onset ownership and downbeat parity when adjacent predictions are unusually close', () => {
    const basic = baseline()
    basic.levels[3][60] = 0.7
    basic.levels[3][64] = 0.4
    const result = blendBeatThisTimeline(basic, {
      beats: [1.03, 0.97, 0.97, 1.5],
      downbeats: [1.03],
    })
    // The midpoint transient belongs to neither beat; it must not collapse both
    // predictions into a single onset. Sorting/deduplication retains downbeat identity.
    expect(result.levels[1][58]).toBeGreaterThan(0)
    expect(result.levels[1][64]).toBeGreaterThan(result.levels[1][63]!)
    expect(result.levels[0][64]).toBeGreaterThan(result.levels[0][63]!)
  })

  it('never treats missing range context as an onset or carries pulses through unbuilt holes', () => {
    const basic = baseline()
    basic.completedRanges = [
      { startSeconds: 1, endSeconds: 1.3 },
      { startSeconds: 2, endSeconds: 2.5 },
    ]
    basic.levels[3].fill(0.9)
    basic.levels[3][59] = 0 // Unavailable preceding sample cannot imply an onset at the boundary.
    const result = blendBeatThisTimeline(basic, {
      beats: [0.97, 1.03, 1.28, 1.98],
      downbeats: [],
    })
    expect(result.levels[1][60]).toBe(0)
    expect(result.levels[1][62]).toBeCloseTo(0.9)
    expect(result.levels[1].slice(79, 120).every((value) => value === 0)).toBe(true)
    expect(result.levels[1].slice(120).every((value) => value === 0)).toBe(true)
  })

  it('keeps corrected seam pulses identical across window completion and checkpoint order', () => {
    const windows = beatThisWindows(3251, 65)
    const createPart = (
      startSeconds: number,
      endSeconds: number,
      modelBeat: number,
    ): BeatTimeline => {
      const basic = createBeatTimelineBuffer(65)
      basic.completedRanges = [{ startSeconds, endSeconds }]
      for (let frame = 1441; frame < 1480; frame += 1)
        basic.levels[3][frame] = 0.8 * Math.exp(-(frame - 1441) / 10)
      return blendBeatThisTimeline(basic, {
        beats: [23.5, modelBeat, 24.5],
        downbeats: [modelBeat],
      })
    }
    // Both model windows resolve to the same observed sharp rise at 24.0167s.
    const left = createPart(0, 30, 24)
    const right = createPart(21, 51, 24.04)
    const forward = createBeatThisTimelineAssembler(65, windows)
    forward.add(windows[0]!, left)
    expect(sampleBeatTimeline(forward.timeline, 24, 1).level).toBe(0)
    const saved = createBeatCheckpoint(
      { sampleRate: 22050, sampleCount: 22050 * 65, channels: 1, modelId: 'small' },
      forward.timeline,
      new Set([0]),
      100,
      forward.snapshotSeams(),
    )
    const resumed = createBeatThisTimelineAssembler(65, windows, saved)
    forward.add(windows[1]!, right)
    resumed.add(windows[1]!, right)
    const reverse = createBeatThisTimelineAssembler(65, windows)
    reverse.add(windows[1]!, right)
    reverse.add(windows[0]!, left)
    expect(forward.timeline).toEqual(resumed.timeline)
    expect(forward.timeline).toEqual(reverse.timeline)
    const values = forward.timeline.levels[1]
    expect(values[1440]).toBe(0)
    expect(values[1441]).toBeCloseTo(0.8 * 1.12)
    expect(values[1442]).toBeLessThan(values[1441]!)
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
