/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  BEAT_THIS_CHUNK_FRAMES,
  createBeatThisFeaturesBuilder,
} from '../core/analysis/beat-this-features'
import official from './fixtures/beat-this-features.json'
import { createBeatFeatureCache } from '../core/analysis/beat-feature-cache'

// Isolate FFT convention and scaling with a sparse filterbank. A direct O(N²) DFT
// reference is independent of the production radix-2 implementation.
const bins = [1, 4, 17, 48, 200, 511]
function sparseFilterbank(): Float32Array {
  const filters = new Float32Array(513 * 128)
  bins.forEach((bin, band) => {
    filters[bin * 128 + band] = 1
  })
  return filters
}

function reference(samples: Float32Array, center: number, bin: number): number {
  let real = 0
  let imaginary = 0
  for (let index = 0; index < 1024; index += 1) {
    let position = center - 512 + index
    if (position < 0) position = -position
    if (position >= samples.length) position = 2 * samples.length - 2 - position
    const hann = Math.fround(0.5 - 0.5 * Math.cos((2 * Math.PI * index) / 1024))
    const value = Math.fround(samples[position]! * hann)
    const angle = (2 * Math.PI * bin * index) / 1024
    real += value * Math.cos(angle)
    imaginary -= value * Math.sin(angle)
  }
  return Math.log1p(1000 * Math.hypot(real / 32, imaginary / 32))
}

describe('Beat This! log-mel frontend', () => {
  it.each([1050, 2250, 3450])('retains a full model window at unaligned frame %s', (start) => {
    const cache = createBeatFeatureCache()
    const frame = new Float32Array(128)
    for (let index = start; index < start + 1500; index++) {
      frame.fill(index)
      cache.write(index, frame, 0)
    }
    const restored = new Float32Array(128)
    let hits = 0
    for (let index = start; index < start + 1500; index++) {
      if (cache.read(index, restored, 0)) {
        hits++
        expect(restored[0]).toBe(index)
      } else {
        frame.fill(index)
        cache.write(index, frame, 0)
      }
    }
    expect(hits).toBe(1500)
    expect(cache.bytes).toBeLessThanOrEqual(25 * 64 * (128 * 4 + 1))
  })

  it('reuses exact cached frames across batches and recomputes evicted frames without changing output', () => {
    const samples = Float32Array.from({ length: 48000 * 6 }, (_, index) => Math.sin(index / 31))
    const filter = sparseFilterbank()
    const cache = createBeatFeatureCache(2)
    const first = createBeatThisFeaturesBuilder([samples], 48000, filter, cache)
    first.processRange(64, 128, 64)
    const expected = first.chunk(64, 64)
    const resumed = createBeatThisFeaturesBuilder([samples], 48000, filter, cache)
    resumed.processRange(64, 160, 96)
    expect(resumed.reusedFrames).toBe(64)
    expect(resumed.chunk(64, 64)).toEqual(expected)
    resumed.processRange(192, 300, 108)
    expect(cache.bytes).toBeLessThanOrEqual(2 * 64 * (128 * 4 + 1))
    const evicted = createBeatThisFeaturesBuilder([samples], 48000, filter, cache)
    evicted.processRange(64, 128, 64)
    expect(evicted.reusedFrames).toBe(0)
    expect(evicted.chunk(64, 64)).toEqual(expected)
    const copy = evicted.chunk(64, 64)
    copy.fill(123)
    const untouched = createBeatThisFeaturesBuilder([samples], 48000, filter, cache)
    untouched.processRange(64, 128, 64)
    expect(untouched.chunk(64, 64)).toEqual(expected)
  })

  it('rebuilds evicted mono blocks after backwards seeking and preserves reflected boundaries', () => {
    const samples = Float32Array.from({ length: 22050 * 4 }, (_, index) => Math.cos(index / 11))
    const reference = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank())
    reference.processRange(0, reference.frames, 1000)
    const random = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank())
    random.processRange(150, 201, 100)
    random.processRange(0, 150, 200)
    expect(random.chunk(0, random.frames)).toEqual(reference.chunk(0, reference.frames))
  })

  it('reuses the overlapping right edge before filling a backwards window into a full cache', () => {
    const samples = Float32Array.from({ length: 22050 * 6 }, (_, index) => Math.cos(index / 17))
    const cache = createBeatFeatureCache(2)
    const write = vi.spyOn(cache, 'write')
    const first = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank(), cache)
    first.processRange(64, 192, 128)
    const overlap = first.chunk(64, 64)

    const resumed = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank(), cache)
    write.mockClear()
    expect(resumed.processRange(0, 128, 128)).toBe(1)
    expect(resumed.reusedFrames).toBe(64)
    expect(write).toHaveBeenCalledTimes(64)
    expect(resumed.chunk(64, 64)).toEqual(overlap)
    write.mockRestore()
  })

  it('rebuilds evicted frequency pages without inflating unique work counts or aliasing an old input', () => {
    const samples = Float32Array.from({ length: 22050 * 6 }, (_, index) => Math.sin(index / 23))
    const cache = createBeatFeatureCache(2)
    const builder = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank(), cache)
    builder.processRange(0, 128, 128)
    const input = builder.chunk(0, 128)
    const expected = input.slice()
    builder.processRange(192, 300, 108)
    expect(builder.processedFrames).toBe(236)
    expect(builder.rangeProgress(0, 128)).toBe(0)
    expect(() => builder.chunk(0, 128)).toThrow('已被回收')
    expect(builder.processRange(0, 128, 25)).toBe(25 / 128)
    while (builder.processRange(0, 128, 25) < 1) {
      /* Rebuild after a backwards seek without resurrecting a stale completion flag. */
    }
    expect(builder.chunk(0, 128)).toEqual(expected)
    expect(input).toEqual(expected)
    expect(builder.processedFrames).toBe(236)
    expect(builder.reusedFrames).toBe(0)
    expect(builder.residentBytes).toBe(2 * 64 * 513)
    expect(builder.peakResidentBytes).toBe(builder.residentBytes)
  })

  it('bounds resident pages and recycles them across long-track windows without a full-song API', () => {
    const samples = new Float32Array(22050 * 120)
    const cache = createBeatFeatureCache()
    // Populate known log-mel frames to isolate allocation/eviction from FFT cost.
    const frame = new Float32Array(128)
    const builder = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank(), cache)
    expect(builder.frames).toBe(6001)
    expect(builder.residentBytes).toBe(0)
    for (let index = 3450; index < 4950; index++) cache.write(index, frame, 0)
    expect(builder).not.toHaveProperty('view')
    expect(builder).not.toHaveProperty('finish')
    expect(builder).not.toHaveProperty('process')
    const capacityBytes = 25 * 64 * 513
    expect(builder.residentBytes).toBe(capacityBytes)
    expect(builder.processRange(3450, 4950, 25)).toBe(1)
    expect(builder.reusedFrames).toBe(1500)
    const input = builder.chunk(3450, 1500)
    expect(input.byteLength).toBe(1500 * 128 * 4)
    for (const start of [1050, 3450, 2250, 4501, 0]) {
      cache.prepareRange(start, start + 1500)
      for (let index = start; index < start + 1500; index++) cache.write(index, frame, 0)
      expect(builder.processRange(start, start + 1500, 25)).toBe(1)
      expect(builder.chunk(start, 1500).every((value, index) => value === input[index])).toBe(true)
      expect(builder.residentBytes).toBe(capacityBytes)
      expect(builder.peakResidentBytes).toBe(capacityBytes)
    }
    expect(() => builder.processRange(0, builder.frames, 25)).toThrow('窗口无效')
    expect(() => builder.chunk(0, builder.frames)).toThrow('窗口无效')
  })

  it('rejects a window that cannot fit in a caller-supplied smaller cache', () => {
    const builder = createBeatThisFeaturesBuilder(
      [new Float32Array(22050 * 6)],
      22050,
      sparseFilterbank(),
      createBeatFeatureCache(2),
    )
    expect(() => builder.processRange(1, 129, 25)).toThrow('超过缓存容量')
    expect(builder.processRange(0, 128, 128)).toBe(1)
    expect(builder.rangeProgress(0, 128)).toBe(1)
  })

  it('never allocates a song-sized frequency buffer and recycles its 25 physical pages', () => {
    const samples = new Float32Array(22050 * 120)
    const allocatedLengths: number[] = []
    const ArrayType = Float32Array
    vi.stubGlobal(
      'Float32Array',
      new Proxy(ArrayType, {
        construct(target, argumentsList, newTarget) {
          if (typeof argumentsList[0] === 'number') allocatedLengths.push(argumentsList[0])
          return Reflect.construct(target, argumentsList, newTarget)
        },
      }),
    )
    try {
      const cache = createBeatFeatureCache()
      const builder = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank(), cache)
      const frame = new Float32Array(128)
      for (const start of [3450, 1050, 2250, 4501, 0]) {
        cache.prepareRange(start, start + 1500)
        for (let index = start; index < start + 1500; index++) cache.write(index, frame, 0)
        expect(builder.processRange(start, start + 1500, 25)).toBe(1)
        expect(builder.chunk(start, 1500).length).toBe(1500 * 128)
      }
      expect(Math.max(...allocatedLengths)).toBe(1500 * 128)
      expect(allocatedLengths.filter((length) => length === 64 * 128)).toHaveLength(25)
      expect(builder.peakResidentBytes).toBe(25 * 64 * 513)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('pads only physical boundaries and refuses to pad missing in-song feature pages', () => {
    const samples = Float32Array.from({ length: 4410 }, (_, index) => Math.sin(index / 13))
    const builder = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank())
    expect(() => builder.chunk(-6, BEAT_THIS_CHUNK_FRAMES)).toThrow('尚未完成')
    builder.processRange(-6, BEAT_THIS_CHUNK_FRAMES - 6, 100)
    const data = builder.chunk(0, builder.frames)
    const input = builder.chunk(-6, BEAT_THIS_CHUNK_FRAMES)
    expect(input.subarray(0, 6 * 128).every((value) => value === 0)).toBe(true)
    expect(input.slice(6 * 128, (6 + builder.frames) * 128)).toEqual(data)
    expect(input.subarray((6 + builder.frames) * 128).every((value) => value === 0)).toBe(true)
  })

  it('computes a middle window directly and matches sequential 48kHz resampling exactly', () => {
    const samples = Float32Array.from(
      { length: 48000 * 3 },
      (_, index) => Math.sin(index / 37) * 0.3,
    )
    const sequential = createBeatThisFeaturesBuilder([samples], 48000, sparseFilterbank())
    sequential.processRange(0, sequential.frames, 1000)
    const expected = sequential.chunk(0, sequential.frames)
    const random = createBeatThisFeaturesBuilder([samples], 48000, sparseFilterbank())
    while (random.processRange(100, 151, 17) < 1) {
      /* bounded random window */
    }
    expect(random.processedFrames).toBe(51)
    expect(random.rangeProgress(0, 100)).toBe(0)
    expect(random.chunk(100, 51)).toEqual(expected.slice(100 * 128))
    expect(() => random.chunk(0, 10)).toThrow('尚未完成')
    while (random.processRange(0, 100, 19) < 1) {
      /* backwards seek */
    }
    expect(random.chunk(0, random.frames)).toEqual(expected)
  })

  it('does not read irrelevant leading samples while building a later window', () => {
    const samples = new Float32Array(48000 * 6)
    samples[0] = Number.NaN
    const builder = createBeatThisFeaturesBuilder([samples], 48000, sparseFilterbank())
    expect(() => builder.processRange(200, 250, 50)).not.toThrow()
    expect(builder.processedFrames).toBe(50)
    expect(() => builder.processRange(0, 10, 10)).toThrow('无效采样')
  })

  it('exposes only computed feature frames while keeping the total length available for window planning', () => {
    const samples = Float32Array.from({ length: 4410 }, (_, index) => Math.sin(index / 7))
    const builder = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank())
    expect(builder.frames).toBe(11)
    expect(builder.rangeProgress(0, builder.frames)).toBe(0)
    builder.processRange(0, builder.frames, 3)
    const prefix = builder.chunk(0, 3)
    expect(prefix.length).toBe(3 * 128)
    expect(builder.processedFrames).toBe(3)
    const copied = prefix.slice()
    builder.processRange(0, builder.frames, 100)
    expect(builder.chunk(0, 3)).toEqual(copied)
    expect(prefix).toEqual(copied)
  })

  it('matches every bin and frame of the official torchaudio frontend fixture', () => {
    const bytes = readFileSync('public/models/beat-this/mel-filterbank-v1.bin')
    const filterbank = new Float32Array(new Uint8Array(bytes).buffer)
    const samples = Float32Array.from(
      { length: official.sampleCount },
      (_, index) => (((index * 37) % 257) - 128) / 512,
    )
    const builder = createBeatThisFeaturesBuilder([samples], official.sampleRate, filterbank)
    builder.processRange(0, builder.frames, 100)
    const actual = builder.chunk(0, builder.frames)
    expect(builder.frames).toBe(official.features.length)
    official.features.forEach((frame, frameIndex) => {
      frame.forEach((expected, band) => {
        expect(actual[frameIndex * 128 + band]).toBeCloseTo(expected, 4)
      })
    })
  })

  it('matches a direct DFT at both reflected boundaries and centered interior frames', () => {
    const samples = Float32Array.from(
      { length: 4410 },
      (_, index) =>
        0.2 * Math.sin((index * Math.PI * 2 * 97) / 22050) +
        0.1 * Math.cos((index * Math.PI * 2 * 1813) / 22050),
    )
    const builder = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank())
    expect(builder.processRange(0, builder.frames, 2)).toBeCloseTo(2 / 11)
    expect(() => builder.chunk(0, builder.frames)).toThrow('尚未完成')
    builder.processRange(0, builder.frames, 100)
    const features = builder.chunk(0, builder.frames)
    expect(builder.frames).toBe(11)
    for (const frame of [0, 4, 10]) {
      bins.forEach((bin, band) => {
        expect(features[frame * 128 + band]).toBeCloseTo(reference(samples, frame * 441, bin), 4)
      })
    }
  })

  it('averages stereo, retains exact silence and is independent of batch boundaries', () => {
    const samples = Float32Array.from({ length: 2205 }, (_, index) => Math.sin(index / 10))
    const opposite = Float32Array.from(samples, (value) => -value)
    const silence = createBeatThisFeaturesBuilder([samples, opposite], 22050, sparseFilterbank())
    silence.processRange(0, silence.frames, 100)
    expect(silence.chunk(0, silence.frames).every((value) => value === 0)).toBe(true)
    const single = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank())
    const batched = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank())
    single.processRange(0, single.frames, 100)
    while (batched.processRange(0, batched.frames, 1) < 1) {
      /* bounded work */
    }
    expect(batched.chunk(0, batched.frames)).toEqual(single.chunk(0, single.frames))
  })

  it('rejects malformed inputs and nonfinite PCM without producing model features', () => {
    expect(() => createBeatThisFeaturesBuilder([], 22050, sparseFilterbank())).toThrow(
      '声道数据无效',
    )
    expect(() =>
      createBeatThisFeaturesBuilder([new Float32Array(10)], 22050, new Float32Array(128)),
    ).toThrow('频谱配置无效')
    const samples = new Float32Array(1024)
    samples[0] = Number.NaN
    const builder = createBeatThisFeaturesBuilder([samples], 48000, sparseFilterbank())
    expect(() => builder.processRange(0, builder.frames, 1)).toThrow('无效采样')
  })

  it('resamples 48kHz low frequencies without shifting frame times or aliasing ultrasonic energy', () => {
    const filter = new Float32Array(513 * 128)
    for (let bin = 1; bin <= 512; bin += 1) filter[bin * 128] = 1
    const infer = (hz: number): number => {
      const signal = Float32Array.from(
        { length: 48000 },
        (_, index) => 0.3 * Math.sin((2 * Math.PI * hz * index) / 48000),
      )
      const builder = createBeatThisFeaturesBuilder([signal], 48000, filter)
      builder.processRange(0, builder.frames, 100)
      const spect = builder.chunk(0, builder.frames)
      expect(builder.frames).toBe(51)
      return spect[25 * 128]!
    }
    const audible = infer(1000)
    const ultrasonic = infer(18000)
    expect(audible).toBeGreaterThan(8)
    expect(ultrasonic).toBeLessThan(0.2)
  })
})
