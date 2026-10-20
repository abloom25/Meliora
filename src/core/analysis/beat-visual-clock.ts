export type BeatVisualClockSource = 'output-timestamp' | 'latency-fallback' | 'media'

export interface BeatVisualClockInput {
  nowMs: number
  mediaSeconds: number
  playbackRate: number
  running: boolean
  contextSeconds?: number
  outputTimestamp?: { contextTime: number; performanceTime: number }
  baseLatencySeconds?: number
  outputLatencySeconds?: number
  manualOffsetMs?: number
  /** Only animation frames establish the bounded presentation estimate. */
  frameDeltaMs?: number
}

export interface BeatVisualClockSample {
  sampleSeconds: number
  clockSource: BeatVisualClockSource
  /** Estimated sampling offset, not a measurement of sound reaching the listener. */
  outputOffsetMs: number
  frameLeadMs: number
  delayMs: number
}

const MAX_TIMESTAMP_AGE_MS = 250
const MAX_MEDIA_HOLD_MS = 150
const MAX_FRAME_LEAD_MS = 20

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function finite(value: number | undefined, fallback = 0): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback
}

/** Maps the output timestamp into a media anchor without subtracting device latency twice. */
export function createBeatVisualClock() {
  let anchor: { media: number; context: number; rate: number } | null = null
  let lastContext = 0
  let lastMedia = 0
  let lastMediaChangeMs = -Infinity
  let lastNowMs = -Infinity
  let lastTimestamp: { contextTime: number; performanceTime: number } | null = null
  let stableFrames = 0
  let previousFrameMs = 0
  let lastSampleSeconds: number | null = null
  let lastManualOffsetMs = 0

  function reset(): void {
    anchor = null
    lastTimestamp = null
    lastMediaChangeMs = -Infinity
    lastNowMs = -Infinity
    stableFrames = 0
    previousFrameMs = 0
    lastSampleSeconds = null
  }

  function sample(input: BeatVisualClockInput): BeatVisualClockSample {
    const now = finite(input.nowMs)
    const media = Math.max(0, finite(input.mediaSeconds))
    const rate =
      Number.isFinite(input.playbackRate) && input.playbackRate > 0 ? input.playbackRate : 1
    const context = finite(input.contextSeconds, NaN)
    const hasContext = Number.isFinite(context) && context >= 0
    const longFrame = input.frameDeltaMs !== undefined && input.frameDeltaMs >= 80
    if (
      !input.running ||
      !hasContext ||
      now < lastNowMs ||
      longFrame ||
      (anchor && (anchor.rate !== rate || context < lastContext - 0.005))
    )
      reset()

    if (media !== lastMedia || lastMediaChangeMs === -Infinity) lastMediaChangeMs = now
    const mediaFresh = now - lastMediaChangeMs <= MAX_MEDIA_HOLD_MS
    if (hasContext && input.running) {
      // Keep one media/context pair through render-quantum jitter. A discontinuity,
      // seek or stale media read must never extrapolate an old song/position.
      const predicted = anchor ? anchor.media + (context - anchor.context) * rate : media
      const discontinuity = Math.abs(predicted - media) > 0.08 * rate
      if (discontinuity) {
        stableFrames = 0
        previousFrameMs = 0
        lastTimestamp = null
        lastSampleSeconds = null
      }
      if (!anchor || !mediaFresh || discontinuity) anchor = { media, context, rate }
    }

    if (input.frameDeltaMs !== undefined) {
      const delta = input.frameDeltaMs
      const steady =
        input.running &&
        mediaFresh &&
        delta >= 4 &&
        delta <= 40 &&
        (!previousFrameMs || Math.abs(delta - previousFrameMs) <= 5)
      stableFrames = steady ? stableFrames + 1 : 0
      previousFrameMs = delta
    }
    const frameLeadMs =
      input.running && mediaFresh && stableFrames >= 3 && !longFrame
        ? Math.min(MAX_FRAME_LEAD_MS, previousFrameMs)
        : 0

    let clockSource: BeatVisualClockSource = input.running ? 'latency-fallback' : 'media'
    const fallbackOffset = clamp(
      Math.max(0, finite(input.baseLatencySeconds)) +
        Math.max(0, finite(input.outputLatencySeconds)),
      0,
      0.6,
    )
    let audibleMedia = media - (input.running ? fallbackOffset * rate : 0)
    const stamp = input.outputTimestamp
    if (input.running && anchor && stamp && mediaFresh) {
      const age = now - stamp.performanceTime
      const outputContext = stamp.contextTime + age / 1000
      const monotonic =
        !lastTimestamp ||
        (stamp.contextTime >= lastTimestamp.contextTime &&
          stamp.performanceTime >= lastTimestamp.performanceTime)
      const mappedMedia = anchor.media + (outputContext - anchor.context) * rate
      if (
        Number.isFinite(stamp.contextTime) &&
        Number.isFinite(stamp.performanceTime) &&
        stamp.contextTime > 0 &&
        stamp.performanceTime > 0 &&
        age >= -20 &&
        age <= MAX_TIMESTAMP_AGE_MS &&
        outputContext <= context + 0.02 &&
        outputContext >= context - 0.6 &&
        Math.abs(mappedMedia - media) <= 0.6 * rate &&
        monotonic
      ) {
        audibleMedia = mappedMedia
        clockSource = 'output-timestamp'
        lastTimestamp = { ...stamp }
      }
    }
    const manualOffsetMs = clamp(finite(input.manualOffsetMs), -600, 600)
    let sampleSeconds = audibleMedia + ((frameLeadMs - manualOffsetMs) / 1000) * rate
    // Switching between a valid output mapping and declared-latency fallback must
    // not replay a just-rendered attack. Freeze until the new estimate catches up;
    // explicit seeks/rate/context resets and manual adjustment start a new anchor.
    if (input.running && lastSampleSeconds !== null && manualOffsetMs === lastManualOffsetMs)
      sampleSeconds = Math.max(lastSampleSeconds, sampleSeconds)
    const outputOffsetMs = ((media - sampleSeconds) / rate) * 1000 - manualOffsetMs + frameLeadMs
    lastSampleSeconds = sampleSeconds
    lastManualOffsetMs = manualOffsetMs
    lastContext = context
    lastMedia = media
    lastNowMs = now
    return {
      sampleSeconds,
      clockSource,
      outputOffsetMs,
      frameLeadMs,
      delayMs: ((media - sampleSeconds) / rate) * 1000,
    }
  }

  return { sample, reset }
}
