/// <reference types="node" />

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBeatThisFeaturesBuilder } from '../core/analysis/beat-this-features'
import official from './fixtures/beat-this-features.json'

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
  it('computes a middle window directly and matches sequential 48kHz resampling exactly', () => {
    const samples = Float32Array.from(
      { length: 48000 * 3 },
      (_, index) => Math.sin(index / 37) * 0.3,
    )
    const sequential = createBeatThisFeaturesBuilder([samples], 48000, sparseFilterbank())
    sequential.process(1000)
    const expected = sequential.finish()
    const random = createBeatThisFeaturesBuilder([samples], 48000, sparseFilterbank())
    while (random.processRange(100, 151, 17) < 1) {
      /* bounded random window */
    }
    expect(random.processedFrames).toBe(51)
    expect(random.view().frames).toBe(0)
    expect(random.chunk(100, 51)).toEqual(expected.data.slice(100 * 128))
    expect(() => random.chunk(0, 10)).toThrow('尚未完成')
    while (random.processRange(0, 100, 19) < 1) {
      /* backwards seek */
    }
    expect(random.finish()).toEqual(expected)
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
    expect(builder.view()).toEqual({ frames: 0, data: new Float32Array() })
    builder.process(3)
    const prefix = builder.view()
    expect(prefix.frames).toBe(3)
    expect(prefix.data.length).toBe(3 * 128)
    expect(builder.processedFrames).toBe(3)
    const copied = prefix.data.slice()
    builder.process(100)
    expect(builder.finish().data.slice(0, 3 * 128)).toEqual(copied)
    expect(prefix.data).toEqual(copied)
  })

  it('matches every bin and frame of the official torchaudio frontend fixture', () => {
    const bytes = readFileSync('public/models/beat-this/mel-filterbank-v1.bin')
    const filterbank = new Float32Array(new Uint8Array(bytes).buffer)
    const samples = Float32Array.from(
      { length: official.sampleCount },
      (_, index) => (((index * 37) % 257) - 128) / 512,
    )
    const builder = createBeatThisFeaturesBuilder([samples], official.sampleRate, filterbank)
    builder.process(100)
    const actual = builder.finish()
    expect(actual.frames).toBe(official.features.length)
    official.features.forEach((frame, frameIndex) => {
      frame.forEach((expected, band) => {
        expect(actual.data[frameIndex * 128 + band]).toBeCloseTo(expected, 4)
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
    expect(builder.process(2)).toBeCloseTo(2 / 11)
    expect(() => builder.finish()).toThrow('尚未构建完成')
    builder.process(100)
    const features = builder.finish()
    expect(features.frames).toBe(11)
    for (const frame of [0, 4, 10]) {
      bins.forEach((bin, band) => {
        expect(features.data[frame * 128 + band]).toBeCloseTo(
          reference(samples, frame * 441, bin),
          4,
        )
      })
    }
  })

  it('averages stereo, retains exact silence and is independent of batch boundaries', () => {
    const samples = Float32Array.from({ length: 2205 }, (_, index) => Math.sin(index / 10))
    const opposite = Float32Array.from(samples, (value) => -value)
    const silence = createBeatThisFeaturesBuilder([samples, opposite], 22050, sparseFilterbank())
    silence.process(100)
    expect(silence.finish().data.every((value) => value === 0)).toBe(true)
    const single = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank())
    const batched = createBeatThisFeaturesBuilder([samples], 22050, sparseFilterbank())
    single.process(100)
    while (batched.process(1) < 1) {
      /* bounded work */
    }
    expect(batched.finish()).toEqual(single.finish())
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
    expect(() => builder.process(1)).toThrow('无效采样')
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
      builder.process(100)
      const spect = builder.finish()
      expect(spect.frames).toBe(51)
      return spect.data[25 * 128]!
    }
    const audible = infer(1000)
    const ultrasonic = infer(18000)
    expect(audible).toBeGreaterThan(8)
    expect(ultrasonic).toBeLessThan(0.2)
  })
})
