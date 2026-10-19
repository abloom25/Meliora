// Frontend used by CPJKU/beat_this (MIT): beat_this/preprocessing.py.
// Periodic Hann, centered reflection, magnitude / sqrt(n_fft), Slaney mel, log1p.
export const BEAT_THIS_SAMPLE_RATE = 22050
export const BEAT_THIS_HOP_SIZE = 441
export const BEAT_THIS_BANDS = 128
export const BEAT_THIS_FPS = 50
const FFT_SIZE = 1024
const FFT_BINS = FFT_SIZE / 2 + 1
const RESAMPLE_PHASES = 512

export interface BeatThisSpectrogram {
  frames: number
  data: Float32Array
}

export interface BeatThisFeaturesBuilder {
  /** Total frame count, known without processing the full song. */
  readonly frames: number
  readonly processedFrames: number
  process(maxFrames: number): number
  /** Computes only the requested absolute frame range; already cached frames are skipped. */
  processRange(startFrame: number, endFrame: number, maxFrames: number): number
  /** Copies a fully computed model window, padding beyond physical song boundaries only. */
  chunk(startFrame: number, frameCount: number): Float32Array
  /** Read-only view of the computed prefix; unbuilt future frames are not exposed. */
  view(): BeatThisSpectrogram
  finish(): BeatThisSpectrogram
}

/** Reflection matches torch.stft(center=True, pad_mode='reflect'). */
function reflect(index: number, length: number): number {
  if (length <= 1) return 0
  const period = 2 * (length - 1)
  const wrapped = ((index % period) + period) % period
  return wrapped < length ? wrapped : period - wrapped
}

interface MonoSignal {
  length: number
  ensure(firstIndex: number, lastIndex: number): void
  sample(index: number): number
}

/** A polyphase windowed-sinc resampler; avoids aliasing from a linear downsampler. */
function createMonoSignal(channels: readonly Float32Array[], sampleRate: number): MonoSignal {
  const inputLength = channels[0]!.length
  const ratio = sampleRate / BEAT_THIS_SAMPLE_RATE
  const length = Math.max(1, Math.round(inputLength / ratio))
  const output = new Float32Array(length)
  const mix = (index: number): number => {
    let value = 0
    for (const channel of channels) {
      const sample = channel[index]!
      if (!Number.isFinite(sample)) throw new Error('音频包含无效采样数据')
      value += sample
    }
    return value / channels.length
  }
  if (sampleRate === BEAT_THIS_SAMPLE_RATE) {
    return {
      length,
      ensure(firstIndex, lastIndex) {
        const end = Math.min(length, lastIndex + 1)
        for (let index = Math.max(0, firstIndex); index < end; index += 1)
          output[index] = mix(index)
      },
      sample: (index) => output[reflect(index, length)]!,
    }
  }
  const radius = Math.ceil(32 * Math.max(1, ratio))
  const taps = radius * 2
  const cutoff = Math.min(1, 1 / ratio) * 0.95
  const coefficients = new Float32Array((RESAMPLE_PHASES + 1) * taps)
  for (let phase = 0; phase <= RESAMPLE_PHASES; phase += 1) {
    const fraction = phase / RESAMPLE_PHASES
    let sum = 0
    for (let tap = 0; tap < taps; tap += 1) {
      const distance = tap - radius + 1 - fraction
      const scaled = cutoff * distance
      const sinc = Math.abs(scaled) < 1e-12 ? 1 : Math.sin(Math.PI * scaled) / (Math.PI * scaled)
      const window =
        0.42 +
        0.5 * Math.cos((Math.PI * distance) / radius) +
        0.08 * Math.cos((2 * Math.PI * distance) / radius)
      const weight = Math.abs(distance) <= radius ? cutoff * sinc * window : 0
      coefficients[phase * taps + tap] = weight
      sum += weight
    }
    for (let tap = 0; tap < taps; tap += 1) {
      coefficients[phase * taps + tap] = coefficients[phase * taps + tap]! / sum
    }
  }
  // Every input sample is averaged just once, even though adjacent sinc windows overlap.
  const ring = new Float32Array(taps + Math.ceil(ratio) + 2)
  const blockSize = 2048
  const cached = new Uint8Array(Math.ceil(length / blockSize))
  return {
    length,
    ensure(firstIndex, lastIndex) {
      const firstBlock = Math.floor(Math.max(0, firstIndex) / blockSize)
      const lastBlock = Math.floor(Math.min(length - 1, lastIndex) / blockSize)
      for (let block = firstBlock; block <= lastBlock; block += 1) {
        if (cached[block]) continue
        const first = block * blockSize
        const end = Math.min(length, first + blockSize)
        let mixed = Math.max(0, Math.floor(first * ratio) - radius)
        for (let index = first; index < end; index += 1) {
          const position = index * ratio
          const center = Math.floor(position)
          const needed = Math.min(inputLength, center + radius + 1)
          while (mixed < needed) {
            ring[mixed % ring.length] = mix(mixed)
            mixed += 1
          }
          const fractionalPhase = (position - center) * RESAMPLE_PHASES
          const phase = Math.min(RESAMPLE_PHASES - 1, Math.floor(fractionalPhase))
          const fraction = fractionalPhase - phase
          let value = 0
          for (let tap = 0; tap < taps; tap += 1) {
            const input = center - radius + 1 + tap
            if (input < 0 || input >= inputLength) continue
            const a = coefficients[phase * taps + tap]!
            const b = coefficients[(phase + 1) * taps + tap]!
            value += ring[input % ring.length]! * (a + fraction * (b - a))
          }
          output[index] = value
        }
        cached[block] = 1
      }
    },
    sample: (index) => output[reflect(index, length)]!,
  }
}

/** Builds all features in bounded batches; the large PCM never leaves its worker. */
export function createBeatThisFeaturesBuilder(
  channels: readonly Float32Array[],
  sampleRate: number,
  filterbank: Float32Array,
): BeatThisFeaturesBuilder {
  const length = channels[0]?.length ?? 0
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 192000 ||
    channels.length === 0 ||
    channels.length > 32 ||
    length === 0 ||
    channels.some((channel) => channel.length !== length)
  ) {
    throw new Error('音频声道数据无效')
  }
  if (
    filterbank.length !== FFT_BINS * BEAT_THIS_BANDS ||
    filterbank.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    throw new Error('Beat This! 频谱配置无效，请重新下载模型')
  }
  const signal = createMonoSignal(channels, sampleRate)
  const frames = Math.floor(signal.length / BEAT_THIS_HOP_SIZE) + 1
  const data = new Float32Array(frames * BEAT_THIS_BANDS)
  const real = new Float64Array(FFT_SIZE)
  const imaginary = new Float64Array(FFT_SIZE)
  const magnitude = new Float32Array(FFT_BINS)
  const window = new Float32Array(FFT_SIZE)
  const reverse = new Uint16Array(FFT_SIZE)
  const cosine = new Float64Array(FFT_SIZE / 2)
  const sine = new Float64Array(FFT_SIZE / 2)
  const filters = Array.from({ length: BEAT_THIS_BANDS }, (_, band) => {
    const bins: number[] = []
    const weights: number[] = []
    for (let bin = 0; bin < FFT_BINS; bin += 1) {
      const weight = filterbank[bin * BEAT_THIS_BANDS + band]!
      if (weight > 0) {
        bins.push(bin)
        weights.push(weight)
      }
    }
    return { bins, weights }
  })
  for (let index = 0; index < FFT_SIZE; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / FFT_SIZE)
    let source = index
    let reversed = 0
    for (let bit = 0; bit < 10; bit += 1) {
      reversed = (reversed << 1) | (source & 1)
      source >>= 1
    }
    reverse[index] = reversed
    if (index < FFT_SIZE / 2) {
      const angle = (2 * Math.PI * index) / FFT_SIZE
      cosine[index] = Math.cos(angle)
      sine[index] = -Math.sin(angle)
    }
  }
  let processed = 0
  let prefixFrames = 0
  const computed = new Uint8Array(frames)
  function processFrame(frame: number): void {
    const center = frame * BEAT_THIS_HOP_SIZE
    const firstSample = center - FFT_SIZE / 2
    const lastSample = center + FFT_SIZE / 2 - 1
    signal.ensure(
      signal.length <= FFT_SIZE
        ? 0
        : Math.max(0, Math.min(firstSample, 2 * (signal.length - 1) - lastSample)),
      signal.length <= FFT_SIZE
        ? signal.length - 1
        : Math.min(signal.length - 1, Math.max(lastSample, -firstSample)),
    )
    for (let index = 0; index < FFT_SIZE; index += 1) {
      const target = reverse[index]!
      real[target] = Math.fround(signal.sample(center - FFT_SIZE / 2 + index) * window[index]!)
      imaginary[target] = 0
    }
    for (let size = 2; size <= FFT_SIZE; size *= 2) {
      const half = size / 2
      const stride = FFT_SIZE / size
      for (let start = 0; start < FFT_SIZE; start += size) {
        for (let offset = 0; offset < half; offset += 1) {
          const left = start + offset
          const right = left + half
          const c = cosine[offset * stride]!
          const s = sine[offset * stride]!
          const r = real[right]! * c - imaginary[right]! * s
          const i = real[right]! * s + imaginary[right]! * c
          const lr = real[left]!
          const li = imaginary[left]!
          real[left] = lr + r
          imaginary[left] = li + i
          real[right] = lr - r
          imaginary[right] = li - i
        }
      }
    }
    for (let bin = 0; bin < FFT_BINS; bin += 1) {
      magnitude[bin] = Math.hypot(Math.fround(real[bin]! / 32), Math.fround(imaginary[bin]! / 32))
    }
    for (let band = 0; band < BEAT_THIS_BANDS; band += 1) {
      const filter = filters[band]!
      let power = 0
      for (let index = 0; index < filter.bins.length; index += 1) {
        power += magnitude[filter.bins[index]!]! * filter.weights[index]!
      }
      data[frame * BEAT_THIS_BANDS + band] = Math.log1p(Math.fround(1000 * Math.fround(power)))
    }
    computed[frame] = 1
    processed += 1
    while (prefixFrames < frames && computed[prefixFrames]) prefixFrames += 1
  }
  function processRange(startFrame: number, endFrame: number, maxFrames: number): number {
    if (!Number.isFinite(maxFrames) || maxFrames < 1) throw new Error('节拍分析批次大小无效')
    if (!Number.isInteger(startFrame) || !Number.isInteger(endFrame) || endFrame <= startFrame)
      throw new Error('节拍分析窗口无效')
    const first = Math.max(0, startFrame)
    const end = Math.min(frames, endFrame)
    let remaining = Math.floor(maxFrames)
    let complete = 0
    for (let frame = first; frame < end; frame += 1) {
      if (!computed[frame] && remaining > 0) {
        processFrame(frame)
        remaining -= 1
      }
      complete += computed[frame]!
    }
    return end <= first ? 1 : complete / (end - first)
  }
  return {
    frames,
    get processedFrames() {
      return processed
    },
    process(maxFrames) {
      processRange(0, frames, maxFrames)
      return processed / frames
    },
    processRange,
    chunk(startFrame, frameCount) {
      if (!Number.isInteger(startFrame) || !Number.isInteger(frameCount) || frameCount < 1)
        throw new Error('节拍分析窗口无效')
      const first = Math.max(0, startFrame)
      const end = Math.min(frames, startFrame + frameCount)
      if (computed.subarray(first, end).some((value) => !value))
        throw new Error('Beat This! 当前窗口特征尚未完成')
      const result = new Float32Array(frameCount * BEAT_THIS_BANDS)
      if (end > first)
        result.set(
          data.subarray(first * BEAT_THIS_BANDS, end * BEAT_THIS_BANDS),
          (first - startFrame) * BEAT_THIS_BANDS,
        )
      return result
    },
    view() {
      return { frames: prefixFrames, data: data.subarray(0, prefixFrames * BEAT_THIS_BANDS) }
    },
    finish() {
      if (processed !== frames) throw new Error('Beat This! 音频特征尚未构建完成')
      return { frames, data }
    },
  }
}
