import { describe, expect, it } from 'vitest'
import {
  beatThisChunk,
  beatThisChunkStarts,
  createBeatThisAggregator,
  postprocessBeatThis,
  beatThisWindows,
  nextBeatThisWindow,
  postprocessBeatThisWindow,
} from '../core/analysis/beat-this-prediction'

describe('Beat This! full-song windowing', () => {
  it('plans independent regions with full model context and prioritizes the playhead', () => {
    const windows = beatThisWindows(5001, 100)
    expect(windows.map((window) => window.range)).toEqual([
      { startSeconds: 0, endSeconds: 24 },
      { startSeconds: 24, endSeconds: 48 },
      { startSeconds: 48, endSeconds: 72 },
      { startSeconds: 72, endSeconds: 96 },
      { startSeconds: 96, endSeconds: 100 },
    ])
    expect(windows[2]!.startFrame).toBe(2250)
    expect(windows[4]!.startFrame).toBe(3507)
    const completed = new Set<number>()
    expect(nextBeatThisWindow(windows, completed, 50)?.index).toBe(2)
    completed.add(2)
    expect(nextBeatThisWindow(windows, completed, 50)?.index).toBe(3)
    expect(nextBeatThisWindow(windows, completed, 5)?.index).toBe(0)
    expect(beatThisWindows(51, 1)).toHaveLength(1)
    expect(beatThisWindows(2451, 49).map((window) => window.range.endSeconds)).toEqual([24, 49])
  })

  it('converts independent-window predictions to absolute song times and excludes untrained edges', () => {
    const beat = new Float32Array(1500).fill(-1)
    beat[1] = 10
    beat[100] = 3
    beat[1498] = 10
    const downbeat = new Float32Array(1500).fill(-1)
    downbeat[101] = 2
    expect(postprocessBeatThisWindow(beat, downbeat, 2250)).toEqual({
      beats: [47],
      downbeats: [47],
    })
  })

  it('preserves the official shifted final chunk and keeps earlier seam predictions', () => {
    expect(beatThisChunkStarts(1488)).toEqual([-6])
    expect(beatThisChunkStarts(1489)).toEqual([-6, -5])
    expect(beatThisChunkStarts(3100)).toEqual([-6, 1482, 1606])
    const aggregate = createBeatThisAggregator(3100)
    beatThisChunkStarts(3100).forEach((start, index) => {
      aggregate.push(
        start,
        new Float32Array(1500).fill(index + 1),
        new Float32Array(1500).fill(-(index + 1)),
      )
      const prefix = aggregate.prefix()
      expect(prefix.beat.length).toBe([1488, 2976, 3100][index])
      prefix.beat.fill(99)
    })
    const result = aggregate.finish()
    expect(result.beat[0]).toBe(1)
    expect(result.beat[1487]).toBe(1)
    expect(result.beat[1488]).toBe(2)
    expect(result.beat[2975]).toBe(2)
    expect(result.beat[2976]).toBe(3)
    expect(result.beat[3099]).toBe(3)
    expect(result.downbeat[3099]).toBe(-3)
  })

  it('pads the graph input without inserting padding into song timestamps', () => {
    const data = Float32Array.from({ length: 10 * 128 }, (_, index) => index + 1)
    const chunk = beatThisChunk({ frames: 10, data }, -6)
    expect(chunk.length).toBe(1500 * 128)
    expect(chunk.subarray(0, 6 * 128).every((value) => value === 0)).toBe(true)
    expect(chunk.slice(6 * 128, 16 * 128)).toEqual(data)
    expect(chunk.subarray(16 * 128).every((value) => value === 0)).toBe(true)
    const aggregate = createBeatThisAggregator(10)
    const beat = new Float32Array(1500).fill(-1)
    beat[6] = 5
    beat[15] = 4
    aggregate.push(-6, beat, new Float32Array(1500).fill(-1))
    const logits = aggregate.finish()
    expect(postprocessBeatThis(logits.beat, logits.downbeat).beats).toEqual([0, 0.18])
  })

  it('never publishes incomplete or malformed model output', () => {
    const aggregate = createBeatThisAggregator(3100)
    expect(() => aggregate.finish()).toThrow('尚未完成')
    expect(() => aggregate.push(-6, new Float32Array(12), new Float32Array(12))).toThrow(
      '长度不匹配',
    )
    const invalid = new Float32Array(1500)
    invalid[6] = Number.NaN
    expect(() => aggregate.push(-6, invalid, invalid)).toThrow('输出无效')
  })
})

describe('Beat This! official minimal peak picking', () => {
  it('uses positive logits, a seven-frame max pool and adjacent-peak averages', () => {
    const beat = new Float32Array(40).fill(-2)
    beat[0] = 0
    beat[3] = 1
    beat[5] = 3
    beat[12] = 4
    beat[13] = 4
    beat[25] = 2
    const downbeat = new Float32Array(40).fill(-1)
    downbeat[11] = 3
    downbeat[17] = 2
    expect(postprocessBeatThis(beat, downbeat)).toEqual({
      beats: [0.1, 0.25, 0.5],
      downbeats: [0.25],
    })
  })

  it('handles silence and no-beat downbeats without inventing a beat grid', () => {
    expect(postprocessBeatThis(new Float32Array(10), new Float32Array(10))).toEqual({
      beats: [],
      downbeats: [],
    })
    const downbeat = new Float32Array(10).fill(-1)
    downbeat[3] = 1
    expect(postprocessBeatThis(new Float32Array(10), downbeat)).toEqual({
      beats: [],
      downbeats: [0.06],
    })
  })
})
