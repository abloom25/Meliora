import { describe, expect, it } from 'vitest'
import { createWindowedSpectrum } from '../core/analysis/windowed-spectrum'

// Independent O(N²) DFT reference, not the radix-2 implementation under test.
function reference(
  frame: Float32Array,
  previous: number[],
): { bytes: number[]; magnitudes: number[] } {
  const magnitudes = Array.from({ length: frame.length / 2 }, (_, bin) => {
    let real = 0
    let imaginary = 0
    for (let n = 0; n < frame.length; n += 1) {
      const phase = (2 * Math.PI * n) / frame.length
      const sample = frame[n]! * (0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase))
      real += sample * Math.cos(phase * bin)
      imaginary -= sample * Math.sin(phase * bin)
    }
    return 0.3 * (previous[bin] ?? 0) + (0.7 * Math.hypot(real, imaginary)) / frame.length
  })
  return {
    magnitudes,
    bytes: magnitudes.map((value) =>
      Math.max(0, Math.min(255, Math.floor((255 * (20 * Math.log10(value) + 100)) / 70))),
    ),
  }
}

describe('windowed spectrum', () => {
  it('matches independent Blackman DFT and successive magnitude smoothing', () => {
    const spectrum = createWindowedSpectrum(64)
    let previous: number[] = []
    for (const gain of [0.004, 0.02, 0, 0.001]) {
      const frame = Float32Array.from(
        { length: 64 },
        (_, index) =>
          gain * (Math.sin(index * 0.47) + 0.4 * Math.cos(index * 1.23) + (index === 9 ? 2 : 0)),
      )
      const expected = reference(frame, previous)
      expect(Array.from(spectrum.process(frame))).toEqual(expected.bytes)
      previous = expected.magnitudes
    }
  })

  it('keeps silence at zero and rejects malformed frames', () => {
    const spectrum = createWindowedSpectrum(32)
    expect(Array.from(spectrum.process(new Float32Array(32)))).toEqual(Array(16).fill(0))
    expect(() => createWindowedSpectrum(33)).toThrow()
    expect(() => spectrum.process(new Float32Array(31))).toThrow()
    const invalid = new Float32Array(32)
    invalid[8] = Number.NaN
    expect(() => spectrum.process(invalid)).toThrow('无效采样')
  })
})
