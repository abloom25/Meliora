import { BEAT_THIS_BANDS, BEAT_THIS_FPS, type BeatThisSpectrogram } from './beat-this-features'
import type { BeatTimeRange } from './beat-timeline'

export const BEAT_THIS_CHUNK_FRAMES = 1500
export const BEAT_THIS_BORDER_FRAMES = 6

export interface BeatThisPrediction {
  beats: number[]
  downbeats: number[]
}

export interface BeatThisWindow {
  index: number
  startFrame: number
  range: BeatTimeRange
}

/** Independent 24s display regions retain approximately 3s of model context on each side. */
export function beatThisWindows(frames: number, durationSeconds: number): BeatThisWindow[] {
  if (
    !Number.isInteger(frames) ||
    frames < 1 ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  )
    throw new Error('Beat This! 音频长度无效')
  let count = Math.ceil(durationSeconds / 24)
  // Avoid a redundant inference solely for a sub-two-second tail.
  if (count > 1 && durationSeconds - (count - 1) * 24 < 2) count -= 1
  const finalStart = Math.max(
    -BEAT_THIS_BORDER_FRAMES,
    frames - (BEAT_THIS_CHUNK_FRAMES - BEAT_THIS_BORDER_FRAMES),
  )
  return Array.from({ length: count }, (_, index) => ({
    index,
    startFrame: Math.min(
      Math.max(-BEAT_THIS_BORDER_FRAMES, index * 24 * BEAT_THIS_FPS - 150),
      finalStart,
    ),
    range: {
      startSeconds: index * 24,
      endSeconds: index + 1 === count ? durationSeconds : (index + 1) * 24,
    },
  }))
}

/** Prefer the current region, then upcoming audio; wrap only after all later regions finish. */
export function nextBeatThisWindow(
  windows: readonly BeatThisWindow[],
  completed: ReadonlySet<number>,
  timeSeconds: number,
): BeatThisWindow | undefined {
  const time = Math.max(0, Number.isFinite(timeSeconds) ? timeSeconds : 0)
  return (
    windows.find((window) => !completed.has(window.index) && window.range.endSeconds > time) ??
    windows.find((window) => !completed.has(window.index))
  )
}

/** Crop only the official six-frame untrained edges, retaining context outside the visible tile. */
export function postprocessBeatThisWindow(
  beat: Float32Array,
  downbeat: Float32Array,
  startFrame: number,
): BeatThisPrediction {
  if (beat.length !== BEAT_THIS_CHUNK_FRAMES || downbeat.length !== BEAT_THIS_CHUNK_FRAMES)
    throw new Error('Beat This! 模型输出长度不匹配')
  const beats = beat.slice()
  const downbeats = downbeat.slice()
  for (const logits of [beats, downbeats]) {
    logits.fill(-1000, 0, BEAT_THIS_BORDER_FRAMES)
    logits.fill(-1000, BEAT_THIS_CHUNK_FRAMES - BEAT_THIS_BORDER_FRAMES)
  }
  const result = postprocessBeatThis(beats, downbeats)
  const offset = startFrame / BEAT_THIS_FPS
  return {
    beats: result.beats.map((time) => time + offset),
    downbeats: result.downbeats.map((time) => time + offset),
  }
}

/** Exact binary-fraction probe, generated identically by the reproducible export script. */
export function createBeatThisProbe(): Float32Array {
  return Float32Array.from(
    { length: BEAT_THIS_CHUNK_FRAMES * BEAT_THIS_BANDS },
    (_, index) =>
      ((Math.floor(index / BEAT_THIS_BANDS) * 17 + (index % BEAT_THIS_BANDS) * 37) % 101) / 32,
  )
}

/** Driver bugs can return finite but incorrect WebGPU logits. Verify against CPU references. */
export function matchesBeatThisProbe(
  beat: Float32Array,
  downbeat: Float32Array,
  expected: { beat: readonly number[]; downbeat: readonly number[] },
): boolean {
  return (
    beat.length === BEAT_THIS_CHUNK_FRAMES &&
    downbeat.length === BEAT_THIS_CHUNK_FRAMES &&
    expected.beat.length === 32 &&
    expected.downbeat.length === 32 &&
    expected.beat.every((value, index) => Math.abs(beat[index * 47]! - value) < 0.01) &&
    expected.downbeat.every((value, index) => Math.abs(downbeat[index * 47]! - value) < 0.01)
  )
}

/** Same shifted final window as official split_piece(avoid_short_end=True). */
export function beatThisChunkStarts(frames: number): number[] {
  if (!Number.isInteger(frames) || frames < 1) throw new Error('Beat This! 音频特征长度无效')
  const starts: number[] = []
  const stride = BEAT_THIS_CHUNK_FRAMES - 2 * BEAT_THIS_BORDER_FRAMES
  for (
    let start = -BEAT_THIS_BORDER_FRAMES;
    start < frames - BEAT_THIS_BORDER_FRAMES;
    start += stride
  ) {
    starts.push(start)
  }
  if (frames > stride)
    starts[starts.length - 1] = frames - (BEAT_THIS_CHUNK_FRAMES - BEAT_THIS_BORDER_FRAMES)
  return starts
}

/** Short tracks are zero padded to the fixed exported graph's 30-second context. */
export function beatThisChunk(spectrogram: BeatThisSpectrogram, start: number): Float32Array {
  const chunk = new Float32Array(BEAT_THIS_CHUNK_FRAMES * BEAT_THIS_BANDS)
  const first = Math.max(0, start)
  const end = Math.min(spectrogram.frames, start + BEAT_THIS_CHUNK_FRAMES)
  chunk.set(
    spectrogram.data.subarray(first * BEAT_THIS_BANDS, end * BEAT_THIS_BANDS),
    (first - start) * BEAT_THIS_BANDS,
  )
  return chunk
}

/** Sequential aggregation keeps the first window at seams, as the official inference does. */
export function createBeatThisAggregator(frames: number): {
  push(start: number, beat: Float32Array, downbeat: Float32Array): void
  prefix(): { beat: Float32Array; downbeat: Float32Array }
  finish(): { beat: Float32Array; downbeat: Float32Array }
} {
  const beat = new Float32Array(frames).fill(-1000)
  const downbeat = new Float32Array(frames).fill(-1000)
  const written = new Uint8Array(frames)
  let contiguous = 0
  return {
    push(start, beats, downbeats) {
      if (beats.length !== BEAT_THIS_CHUNK_FRAMES || downbeats.length !== BEAT_THIS_CHUNK_FRAMES) {
        throw new Error('Beat This! 模型输出长度不匹配')
      }
      for (
        let offset = BEAT_THIS_BORDER_FRAMES;
        offset < BEAT_THIS_CHUNK_FRAMES - BEAT_THIS_BORDER_FRAMES;
        offset += 1
      ) {
        const frame = start + offset
        if (frame < 0 || frame >= frames || written[frame]) continue
        if (!Number.isFinite(beats[offset]) || !Number.isFinite(downbeats[offset])) {
          throw new Error('Beat This! 模型输出无效')
        }
        beat[frame] = beats[offset]!
        downbeat[frame] = downbeats[offset]!
        written[frame] = 1
      }
      while (contiguous < frames && written[contiguous]) contiguous += 1
    },
    prefix() {
      return { beat: beat.slice(0, contiguous), downbeat: downbeat.slice(0, contiguous) }
    },
    finish() {
      if (written.some((value) => value === 0)) throw new Error('Beat This! 节拍预测尚未完成')
      return { beat, downbeat }
    },
  }
}

/** CPJKU's minimal postprocessor: 7-frame max pool, logit > 0, adjacent-peak mean. */
function peakTimes(logits: Float32Array): number[] {
  const peaks: number[] = []
  for (let index = 0; index < logits.length; index += 1) {
    const value = logits[index]!
    if (!Number.isFinite(value)) throw new Error('Beat This! 模型输出无效')
    if (value <= 0) continue
    let peak = true
    for (
      let other = Math.max(0, index - 3);
      other <= Math.min(logits.length - 1, index + 3);
      other += 1
    ) {
      if (logits[other]! > value) {
        peak = false
        break
      }
    }
    if (peak) peaks.push(index)
  }
  if (peaks.length === 0) return []
  const times: number[] = []
  let mean = peaks[0]!
  let count = 1
  for (let index = 1; index < peaks.length; index += 1) {
    const next = peaks[index]!
    if (next - mean <= 1) {
      count += 1
      mean += (next - mean) / count
    } else {
      times.push(mean / BEAT_THIS_FPS)
      mean = next
      count = 1
    }
  }
  times.push(mean / BEAT_THIS_FPS)
  return times
}

export function postprocessBeatThis(
  beat: Float32Array,
  downbeat: Float32Array,
): BeatThisPrediction {
  if (beat.length !== downbeat.length) throw new Error('Beat This! 模型输出长度不匹配')
  const beats = peakTimes(beat)
  const rawDownbeats = peakTimes(downbeat)
  let nearest = 0
  const downbeats = rawDownbeats.map((time) => {
    if (beats.length === 0) return time
    while (
      nearest + 1 < beats.length &&
      Math.abs(beats[nearest + 1]! - time) < Math.abs(beats[nearest]! - time)
    ) {
      nearest += 1
    }
    return beats[nearest]!
  })
  return { beats, downbeats: [...new Set(downbeats)] }
}
