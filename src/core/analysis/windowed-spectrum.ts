export interface WindowedSpectrum {
  /** Blackman-windowed FFT, magnitude smoothing, then the AnalyserNode byte dB mapping. */
  process(frame: Float32Array): Uint8Array
}

/** A reusable radix-2 FFT front end matching the existing Web Audio analyser settings. */
export function createWindowedSpectrum(size = 2048): WindowedSpectrum {
  if (!Number.isInteger(size) || size < 32 || size > 32768 || (size & (size - 1)) !== 0) {
    throw new Error('无效的频谱窗口大小')
  }
  const bins = size / 2
  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)
  const window = new Float64Array(size)
  const previous = new Float64Array(bins)
  const cosine = new Float64Array(bins)
  const sine = new Float64Array(bins)
  const reversed = new Uint16Array(size)
  const bytes = new Uint8Array(bins)
  const bits = Math.log2(size)
  for (let index = 0; index < size; index += 1) {
    const angle = (2 * Math.PI * index) / size
    window[index] = 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle)
    let source = index
    let target = 0
    for (let bit = 0; bit < bits; bit += 1) {
      target = (target << 1) | (source & 1)
      source >>= 1
    }
    reversed[index] = target
    if (index < bins) {
      cosine[index] = Math.cos(angle)
      sine[index] = -Math.sin(angle)
    }
  }

  return {
    process(frame) {
      if (frame.length !== size) throw new Error('音频分析窗口长度不匹配')
      for (let index = 0; index < size; index += 1) {
        const sample = frame[index]!
        if (!Number.isFinite(sample)) throw new Error('音频包含无效采样数据')
        const target = reversed[index]!
        real[target] = sample * window[index]!
        imaginary[target] = 0
      }
      for (let length = 2; length <= size; length *= 2) {
        const half = length / 2
        const stride = size / length
        for (let start = 0; start < size; start += length) {
          for (let offset = 0; offset < half; offset += 1) {
            const left = start + offset
            const right = left + half
            const twiddle = offset * stride
            const c = cosine[twiddle]!
            const s = sine[twiddle]!
            const tr = real[right]! * c - imaginary[right]! * s
            const ti = real[right]! * s + imaginary[right]! * c
            const lr = real[left]!
            const li = imaginary[left]!
            real[left] = lr + tr
            imaginary[left] = li + ti
            real[right] = lr - tr
            imaginary[right] = li - ti
          }
        }
      }
      for (let bin = 0; bin < bins; bin += 1) {
        const magnitude = Math.hypot(real[bin]!, imaginary[bin]!) / size
        const smoothed = 0.3 * previous[bin]! + 0.7 * magnitude
        previous[bin] = smoothed
        const db = 20 * Math.log10(smoothed)
        bytes[bin] = Math.max(0, Math.min(255, Math.floor((255 * (db + 100)) / 70)))
      }
      return bytes
    },
  }
}
