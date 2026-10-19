import { BEAT_FLASH_RATE_STEPS, createBeatEnvelope, sanitizeBeatFlashRate } from './beat-envelope'
import { createRealtimeHpss } from './hpss'
import { createTempoRuler } from './tempo-ruler'
import { createWindowedSpectrum } from './windowed-spectrum'

export interface BeatTimeRange {
  startSeconds: number
  endSeconds: number
}

export interface BeatTimeline {
  durationSeconds: number
  stepSeconds: number
  /** In BEAT_FLASH_RATE_STEPS order: 0.5, 1, 2, 4. */
  levels: [Float32Array, Float32Array, Float32Array, Float32Array]
  sustain: Float32Array
  /** Exclusive playable prefix. Omitted on a completed timeline. */
  builtUntilSeconds?: number
  /** Half-open ranges. When present, these supersede the legacy prefix marker. */
  completedRanges?: BeatTimeRange[]
}

export interface BeatBuildStatus {
  phase:
    | 'idle'
    | 'loading-model'
    | 'fetching'
    | 'decoding'
    | 'analysing'
    | 'buffered'
    | 'ready'
    | 'error'
  progress: number
  error: string | null
  availableSeconds?: number
  durationSeconds?: number
  completedRanges?: BeatTimeRange[]
  activeRange?: BeatTimeRange
  playbackSeconds?: number
  adjacent?: readonly BeatPreloadStatus[]
}

/** Real neighbouring playback slots, not a second prediction of the queue. */
export interface BeatPreloadTarget {
  direction: 'previous' | 'next'
  source: string
  title: string
  durationSeconds?: number
}

export interface BeatPreloadStatus extends BeatPreloadTarget {
  phase: BeatBuildStatus['phase']
  progress: number
  error: string | null
  availableSeconds?: number
  completedRanges?: BeatTimeRange[]
}

export interface BeatTimelineSample {
  level: number
  sustain: number
}

export interface BeatTimelineBuilder {
  /** Processes a bounded batch and returns completion from zero to one. */
  process(maxFrames: number): number
  /** Copies the completed prefix so a worker can transfer it without detaching the builder. */
  snapshot(): BeatTimeline
  /** Only returns a timeline once every frame has been built. */
  finish(): BeatTimeline
}

const FFT_SIZE = 2048
const STEP_SECONDS = 1 / 60
const HPSS_HALF_WIDTH = 8
/** Covers the tempo ruler's six-second history and the shorter envelope filters. */
const WARMUP_SECONDS = 6
const LINEAR_MAGNITUDE_LUT = Float32Array.from({ length: 256 }, (_, index) =>
  Math.pow(10, (-100 + (index / 255) * 70) / 20),
)

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function normalizeBeatRanges(
  ranges: readonly BeatTimeRange[],
  durationSeconds: number,
): BeatTimeRange[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return []
  const sorted = ranges
    .filter((range) => Number.isFinite(range.startSeconds) && Number.isFinite(range.endSeconds))
    .map((range) => ({
      startSeconds: clamp(range.startSeconds, 0, durationSeconds),
      endSeconds: clamp(range.endSeconds, 0, durationSeconds),
    }))
    .filter((range) => range.endSeconds > range.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds)
  const result: BeatTimeRange[] = []
  for (const range of sorted) {
    const previous = result.at(-1)
    if (previous && range.startSeconds <= previous.endSeconds + 1e-8)
      previous.endSeconds = Math.max(previous.endSeconds, range.endSeconds)
    else result.push({ ...range })
  }
  return result
}

export function beatRangesDuration(ranges: readonly BeatTimeRange[]): number {
  const duration = ranges.reduce(
    (maximum, range) => Math.max(maximum, Number.isFinite(range.endSeconds) ? range.endSeconds : 0),
    0,
  )
  return normalizeBeatRanges(ranges, duration).reduce(
    (sum, range) => sum + range.endSeconds - range.startSeconds,
    0,
  )
}

export function isBeatTimelineReadyAt(timeline: BeatTimeline, timeSeconds: number): boolean {
  if (
    !Number.isFinite(timeline.durationSeconds) ||
    timeline.durationSeconds <= 0 ||
    !Number.isFinite(timeSeconds) ||
    timeSeconds < 0 ||
    timeSeconds >= timeline.durationSeconds
  )
    return false
  if (timeline.completedRanges)
    return timeline.completedRanges.some(
      (range) => timeSeconds >= range.startSeconds && timeSeconds < range.endSeconds,
    )
  return timeSeconds < (timeline.builtUntilSeconds ?? timeline.durationSeconds)
}

/** Mutable worker-owned destination, indexed by absolute media time. */
export function createBeatTimelineBuffer(
  durationSeconds: number,
  stepSeconds = STEP_SECONDS,
): BeatTimeline {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(stepSeconds) ||
    stepSeconds <= 0
  )
    throw new Error('节拍时间轴长度无效')
  const frames = Math.ceil(durationSeconds / stepSeconds) + 1
  return {
    durationSeconds,
    stepSeconds,
    levels: [
      new Float32Array(frames),
      new Float32Array(frames),
      new Float32Array(frames),
      new Float32Array(frames),
    ],
    sustain: new Float32Array(frames),
    completedRanges: [],
  }
}

/** Copies only verified time ranges; overlapping completed frames are kept stable. */
export function mergeBeatTimelineRange(
  target: BeatTimeline,
  part: BeatTimeline,
  range?: BeatTimeRange,
): void {
  if (target.durationSeconds !== part.durationSeconds || target.stepSeconds !== part.stepSeconds)
    throw new Error('节拍时间轴范围不匹配')
  const previous = target.completedRanges ?? []
  const ranges = normalizeBeatRanges(
    range
      ? [range]
      : (part.completedRanges ?? [
          { startSeconds: 0, endSeconds: part.builtUntilSeconds ?? part.durationSeconds },
        ]),
    target.durationSeconds,
  )
  for (const completed of ranges) {
    const first = Math.max(0, Math.floor(completed.startSeconds / target.stepSeconds))
    const end = Math.min(
      target.sustain.length - 1,
      part.sustain.length - 1,
      Math.ceil(completed.endSeconds / target.stepSeconds),
    )
    for (let frame = first; frame <= end; frame += 1) {
      // A published interval also owns its interpolation support samples. Protect
      // these inclusive endpoints when an adjacent interval is completed later.
      if (
        previous.some(
          (known) =>
            frame >= Math.floor(known.startSeconds / target.stepSeconds) &&
            frame <= Math.ceil(known.endSeconds / target.stepSeconds),
        )
      )
        continue
      for (let density = 0; density < target.levels.length; density += 1)
        target.levels[density]![frame] = part.levels[density]![frame] ?? 0
      target.sustain[frame] = part.sustain[frame] ?? 0
    }
  }
  target.completedRanges = normalizeBeatRanges([...previous, ...ranges], target.durationSeconds)
  target.builtUntilSeconds =
    target.completedRanges[0]?.startSeconds === 0 ? target.completedRanges[0].endSeconds : 0
}

/** Independent snapshot; transferring this never detaches the accumulated result. */
export function snapshotBeatTimeline(timeline: BeatTimeline): BeatTimeline {
  return {
    ...timeline,
    completedRanges: timeline.completedRanges?.map((range) => ({ ...range })),
    levels: timeline.levels.map((values) => values.slice()) as BeatTimeline['levels'],
    sustain: timeline.sustain.slice(),
  }
}

/** Picks the priority segment, then walks forward and wraps to fill earlier holes. */
export function createBeatRangeScheduler(durationSeconds: number, segmentSeconds = 10) {
  if (
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !Number.isFinite(segmentSeconds) ||
    segmentSeconds <= 0
  )
    throw new Error('节拍分析范围无效')
  const count = Math.ceil(durationSeconds / segmentSeconds)
  const scheduled = new Uint8Array(count)
  let cursor = 0
  return {
    prioritize(timeSeconds: number): void {
      if (Number.isFinite(timeSeconds))
        cursor = clamp(Math.floor(timeSeconds / segmentSeconds), 0, count - 1)
    },
    next(): BeatTimeRange | null {
      for (let offset = 0; offset < count; offset += 1) {
        const index = (cursor + offset) % count
        if (scheduled[index]) continue
        scheduled[index] = 1
        cursor = (index + 1) % count
        return {
          startSeconds: index * segmentSeconds,
          endSeconds: Math.min(durationSeconds, (index + 1) * segmentSeconds),
        }
      }
      return null
    },
  }
}

function bandEnergy(bytes: Uint8Array, from: number, to: number): number {
  const start = Math.max(1, Math.min(bytes.length - 1, from))
  const end = Math.max(start + 1, Math.min(bytes.length, to))
  let power = 0
  for (let bin = start; bin < end; bin += 1) power += bytes[bin]! ** 2
  return Math.sqrt(power / (end - start)) / 255
}

/** Prebuild the previous HPSS/tempo/envelope algorithm against the song's media clock. */
export function createBeatTimelineBuilder(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: { startSeconds?: number; endSeconds?: number } = {},
): BeatTimelineBuilder {
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error('音频采样率不支持节拍分析')
  }
  const length = channels[0]?.length ?? 0
  if (
    channels.length === 0 ||
    channels.length > 32 ||
    length === 0 ||
    channels.some((channel) => channel.length !== length)
  ) {
    throw new Error('音频声道数据无效')
  }
  const durationSeconds = length / sampleRate
  const startSeconds = options.startSeconds ?? 0
  const endSeconds = options.endSeconds ?? durationSeconds
  if (
    !Number.isFinite(startSeconds) ||
    !Number.isFinite(endSeconds) ||
    startSeconds < 0 ||
    endSeconds > durationSeconds ||
    startSeconds >= endSeconds
  )
    throw new Error('节拍分析范围无效')
  const frameCount = Math.ceil(durationSeconds / STEP_SECONDS) + 1
  const firstFrame = Math.max(0, Math.floor((startSeconds - WARMUP_SECONDS) / STEP_SECONDS))
  const lastFrame = Math.min(frameCount, Math.ceil(endSeconds / STEP_SECONDS) + 1)
  const levels: BeatTimeline['levels'] = [
    new Float32Array(frameCount),
    new Float32Array(frameCount),
    new Float32Array(frameCount),
    new Float32Array(frameCount),
  ]
  const sustain = new Float32Array(frameCount)
  const timeline = { durationSeconds, stepSeconds: STEP_SECONDS, levels, sustain }
  const fftFrame = new Float32Array(FFT_SIZE)
  const spectrum = createWindowedSpectrum(FFT_SIZE)
  const binOf = (hz: number): number => clamp(Math.round((hz * FFT_SIZE) / sampleRate), 1, 1023)
  const lowFrom = binOf(30)
  const lowTo = Math.max(lowFrom + 1, binOf(150))
  // Only low-frequency masks are consumed. Retain their entire ±8-bin support so this
  // crop is numerically identical to full-spectrum HPSS without sorting unused bins.
  const maskBins = Math.min(FFT_SIZE / 2, lowTo + HPSS_HALF_WIDTH)
  const magnitude = new Float32Array(maskBins)
  const previousPercussive = new Float32Array(maskBins)
  const hpss = createRealtimeHpss({ bins: maskBins, frequencyHalfWidth: HPSS_HALF_WIDTH })
  const tempoRuler = createTempoRuler()
  const envelopes = BEAT_FLASH_RATE_STEPS.map(() => createBeatEnvelope())
  const kickFrom = binOf(30)
  const bassFrom = binOf(130)
  const lowMidFrom = binOf(260)
  const lowMidTo = binOf(2000)
  const floorAlpha = 1 - Math.exp(-STEP_SECONDS / 1.1)
  const sustainAttack = 1 - Math.exp(-STEP_SECONDS / 0.15)
  const sustainRelease = 1 - Math.exp(-STEP_SECONDS / 0.6)
  let energyFloor = 0.08
  let sustainLevel = 0
  let frameIndex = firstFrame

  function processFrame(): void {
    // A centered window assigns each result to the actual audio position. Unlike the
    // live pipeline, this does not wait for an FFT/worklet block after the beat plays.
    const centerSample = Math.round(frameIndex * STEP_SECONDS * sampleRate)
    const firstSample = centerSample - FFT_SIZE / 2
    fftFrame.fill(0)
    const first = Math.max(0, -firstSample)
    const end = Math.min(FFT_SIZE, length - firstSample)
    for (let index = first; index < end; index += 1) {
      let mixed = 0
      for (const channel of channels) mixed += channel[firstSample + index]!
      fftFrame[index] = mixed / channels.length
    }
    const bytes = spectrum.process(fftFrame)
    const energy =
      bandEnergy(bytes, kickFrom, bassFrom) * 0.62 +
      bandEnergy(bytes, bassFrom, lowMidFrom) * 0.26 +
      bandEnergy(bytes, lowMidFrom, lowMidTo) * 0.12
    energyFloor += (energy - energyFloor) * floorAlpha
    for (let bin = 0; bin < maskBins; bin += 1) {
      magnitude[bin] = LINEAR_MAGNITUDE_LUT[bytes[bin]!]!
    }
    const mask = hpss.process(magnitude).percussiveMask
    let power = 0
    let flux = 0
    let audibleLowBand = false
    for (let bin = lowFrom; bin < lowTo; bin += 1) {
      audibleLowBand ||= bytes[bin]! > 0
      power += magnitude[bin]! ** 2 * mask[bin]!
      const compressed = (bytes[bin]! / 255) * mask[bin]!
      flux += Math.max(0, compressed - previousPercussive[bin]!)
      previousPercussive[bin] = compressed
    }
    // Byte zero represents both exact silence and the analyser's dB floor. Do not
    // turn its reconstructed 1e-5 magnitude into a synthetic onset at song start.
    power = audibleLowBand ? power / (lowTo - lowFrom) : 0
    flux /= lowTo - lowFrom
    // The tempo ruler uses zero as its uninitialized clock sentinel.
    const nowMs = 1 + frameIndex * STEP_SECONDS * 1000
    tempoRuler.pushSample(nowMs, flux)
    const tempo = tempoRuler.getState()
    for (let density = 0; density < envelopes.length; density += 1) {
      levels[density]![frameIndex] = envelopes[density]!.update({
        power,
        dtSeconds: STEP_SECONDS,
        nowMs,
        periodMs: tempo.locked ? tempo.periodMs : 0,
        rate: BEAT_FLASH_RATE_STEPS[density]!,
      })
    }
    const target = clamp((energy - energyFloor * 1.05) * 6, 0, 1)
    sustainLevel +=
      (target - sustainLevel) * (target > sustainLevel ? sustainAttack : sustainRelease)
    sustain[frameIndex] = sustainLevel
    frameIndex += 1
  }

  return {
    process(maxFrames) {
      if (!Number.isFinite(maxFrames) || maxFrames < 1) {
        throw new Error('节拍分析批次大小无效')
      }
      const end = Math.min(lastFrame, frameIndex + Math.floor(maxFrames))
      while (frameIndex < end) processFrame()
      return (frameIndex - firstFrame) / (lastFrame - firstFrame)
    },
    finish() {
      if (frameIndex !== lastFrame) throw new Error('节拍时间轴尚未构建完成')
      return startSeconds === 0 && endSeconds === durationSeconds
        ? timeline
        : { ...timeline, completedRanges: [{ startSeconds, endSeconds }] }
    },
    snapshot() {
      const completedUntil = Math.min(endSeconds, Math.max(0, frameIndex - 1) * STEP_SECONDS)
      return {
        durationSeconds,
        stepSeconds: STEP_SECONDS,
        builtUntilSeconds: startSeconds === 0 ? completedUntil : 0,
        ...(startSeconds > 0 || endSeconds < durationSeconds
          ? {
              completedRanges:
                completedUntil > startSeconds ? [{ startSeconds, endSeconds: completedUntil }] : [],
            }
          : {}),
        levels: levels.map((values) => values.slice(0, frameIndex)) as BeatTimeline['levels'],
        sustain: sustain.slice(0, frameIndex),
      }
    },
  }
}

/** Reads by media time, making pause, seek, playback-rate changes and late builds deterministic. */
export function sampleBeatTimeline(
  timeline: BeatTimeline,
  timeSeconds: number,
  rate: number,
  output: BeatTimelineSample = { level: 0, sustain: 0 },
): BeatTimelineSample {
  output.level = 0
  output.sustain = 0
  if (
    !isBeatTimelineReadyAt(timeline, timeSeconds) ||
    !Number.isFinite(timeline.stepSeconds) ||
    timeline.stepSeconds <= 0
  ) {
    return output
  }
  const density = BEAT_FLASH_RATE_STEPS.indexOf(sanitizeBeatFlashRate(rate))
  const levels = timeline.levels[density]!
  const position = timeSeconds / timeline.stepSeconds
  const before = Math.floor(position)
  const fraction = position - before
  // The requested time must be completed; builder/merge also provide and freeze
  // its two interpolation support samples, including the exclusive endpoint.
  const level = levels[before] ?? 0
  const sustain = timeline.sustain[before] ?? 0
  output.level = level + ((levels[before + 1] ?? level) - level) * fraction
  output.sustain = sustain + ((timeline.sustain[before + 1] ?? sustain) - sustain) * fraction
  return output
}
