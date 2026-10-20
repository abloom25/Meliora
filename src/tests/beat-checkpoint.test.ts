import { describe, expect, it } from 'vitest'
import {
  createBeatCheckpoint,
  nextBufferedBeatWindow,
  validateBeatCheckpoint,
  beatCheckpointBuffers,
  type BeatCheckpointSignature,
} from '../core/analysis/beat-checkpoint'
import { createBeatTimelineBuffer } from '../core/analysis/beat-timeline'
import { beatThisWindows } from '../core/analysis/beat-this-prediction'

const signature: BeatCheckpointSignature = {
  modelId: 'small',
  sampleRate: 22050,
  sampleCount: 22050 * 80,
  channels: 2,
}

describe('bounded beat checkpoints', () => {
  it('copies published samples independently and rejects another audio or model', () => {
    const timeline = createBeatTimelineBuffer(80)
    timeline.completedRanges = [{ startSeconds: 0, endSeconds: 23.75 }]
    timeline.levels[0][1] = 0.7
    const checkpoint = createBeatCheckpoint(signature, timeline, new Set([0]), 4300)
    validateBeatCheckpoint(checkpoint, signature, 4)
    checkpoint.timeline.levels[0][1] = 0
    expect(timeline.levels[0][1]).toBeCloseTo(0.7)
    expect(beatCheckpointBuffers(checkpoint)).toHaveLength(5)
    for (const changed of [
      { modelId: 'standard' as const },
      { sampleCount: signature.sampleCount + 1 },
      { channels: 1 },
      { sampleRate: 48000 },
    ])
      expect(() => validateBeatCheckpoint(checkpoint, { ...signature, ...changed }, 4)).toThrow(
        '不匹配',
      )
  })

  it('rejects corrupt completion indices, sample values and oversized seam checkpoints', () => {
    const create = () =>
      createBeatCheckpoint(signature, createBeatTimelineBuffer(80), new Set([0]), 0)
    const duplicate = create()
    duplicate.completedWindows.push(0)
    expect(() => validateBeatCheckpoint(duplicate, signature, 4)).toThrow('不匹配')
    const outside = create()
    outside.completedWindows = [4]
    expect(() => validateBeatCheckpoint(outside, signature, 4)).toThrow('不匹配')
    const invalid = create()
    invalid.timeline.levels[1][10] = Number.NaN
    expect(() => validateBeatCheckpoint(invalid, signature, 4)).toThrow('不匹配')
    const large = create()
    large.seams = [
      {
        windowIndex: 0,
        side: 'right',
        firstFrame: 1425,
        levels: [
          new Float32Array(100),
          new Float32Array(100),
          new Float32Array(100),
          new Float32Array(100),
        ],
        sustain: new Float32Array(100),
      },
    ]
    expect(() => validateBeatCheckpoint(large, signature, 4)).toThrow('接缝')
  })

  it('builds only the requested range and selects missing neighbours to repair exact-boundary holes', () => {
    const ranges = beatThisWindows(4001, 80).map((window) => window.range)
    const timeline = createBeatTimelineBuffer(80)
    expect(nextBufferedBeatWindow(ranges, new Set(), timeline, 0, 20, 3, 0.25)).toBe(0)
    timeline.completedRanges = [{ startSeconds: 24.25, endSeconds: 47.75 }]
    expect(nextBufferedBeatWindow(ranges, new Set([1]), timeline, 24, 20, 3, 0.25)).toBe(0)
    expect(nextBufferedBeatWindow(ranges, new Set([1]), timeline, 25, 20, 3, 0.25)).toBeNull()
    timeline.completedRanges = [{ startSeconds: 0, endSeconds: 23.75 }]
    expect(nextBufferedBeatWindow(ranges, new Set([0]), timeline, 0, 20, 1, 0.25)).toBeNull()
    expect(nextBufferedBeatWindow(ranges, new Set([0]), timeline, 23.9, 10, 3, 0.25)).toBe(1)
    expect(nextBufferedBeatWindow(ranges, new Set([0]), timeline, 23.9, undefined, 3, 0.25)).toBe(3)
    expect(nextBufferedBeatWindow(ranges, new Set([0]), timeline, 80, 20, 1, 0.25)).toBeNull()
  })
})
