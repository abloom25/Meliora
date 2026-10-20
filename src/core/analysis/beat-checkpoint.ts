import { continuousBeatCoverage } from './beat-scheduling'
import { snapshotBeatTimeline, type BeatTimeline, type BeatTimeRange } from './beat-timeline'

export interface BeatCheckpointSignature {
  sampleRate: number
  sampleCount: number
  channels: number
  modelId: 'basic' | 'small' | 'standard'
}

/** Only the interpolation support around an unfinished model-window boundary. */
export interface BeatThisSeamCheckpoint {
  windowIndex: number
  side: 'left' | 'right'
  firstFrame: number
  levels: BeatTimeline['levels']
  sustain: Float32Array
}

export interface BeatAnalysisCheckpoint {
  version: 1
  signature: BeatCheckpointSignature
  timeline: BeatTimeline
  completedWindows: number[]
  estimatedWorkMs: number
  seams?: BeatThisSeamCheckpoint[]
}

export interface BeatCheckpointAudio {
  channels: Float32Array[]
  sampleRate: number
  identity?: string
}

export function cloneBeatSeam(seam: BeatThisSeamCheckpoint): BeatThisSeamCheckpoint {
  return {
    ...seam,
    levels: seam.levels.map((values) => values.slice()) as BeatTimeline['levels'],
    sustain: seam.sustain.slice(),
  }
}

export function createBeatCheckpoint(
  signature: BeatCheckpointSignature,
  timeline: BeatTimeline,
  completed: ReadonlySet<number>,
  estimatedWorkMs: number,
  seams?: readonly BeatThisSeamCheckpoint[],
): BeatAnalysisCheckpoint {
  return {
    version: 1,
    signature: { ...signature },
    timeline: snapshotBeatTimeline(timeline),
    completedWindows: [...completed].sort((left, right) => left - right),
    estimatedWorkMs,
    ...(seams ? { seams: seams.map(cloneBeatSeam) } : {}),
  }
}

export function beatCheckpointBuffers(checkpoint: BeatAnalysisCheckpoint): ArrayBuffer[] {
  return [
    ...new Set(
      [
        ...checkpoint.timeline.levels,
        checkpoint.timeline.sustain,
        ...(checkpoint.seams ?? []).flatMap((seam) => [...seam.levels, seam.sustain]),
      ].map((values) => values.buffer as ArrayBuffer),
    ),
  ]
}

export function validateBeatCheckpoint(
  checkpoint: BeatAnalysisCheckpoint,
  signature: BeatCheckpointSignature,
  windowCount: number,
): void {
  const duration = signature.sampleCount / signature.sampleRate
  const data = checkpoint.timeline
  const expectedFrames = Math.ceil(duration / (1 / 60)) + 1
  const validValues = (values: Float32Array, length: number): boolean =>
    values instanceof Float32Array && values.length === length && values.every(Number.isFinite)
  if (
    checkpoint.version !== 1 ||
    (Object.keys(signature) as Array<keyof BeatCheckpointSignature>).some(
      (key) => checkpoint.signature[key] !== signature[key],
    ) ||
    data.durationSeconds !== duration ||
    data.stepSeconds !== 1 / 60 ||
    data.levels.length !== 4 ||
    !data.levels.every((values) => validValues(values, expectedFrames)) ||
    !validValues(data.sustain, expectedFrames) ||
    !Number.isFinite(checkpoint.estimatedWorkMs) ||
    checkpoint.estimatedWorkMs < 0 ||
    new Set(checkpoint.completedWindows).size !== checkpoint.completedWindows.length ||
    checkpoint.completedWindows.some(
      (index) => !Number.isInteger(index) || index < 0 || index >= windowCount,
    ) ||
    data.completedRanges?.some(
      (range) =>
        !Number.isFinite(range.startSeconds) ||
        !Number.isFinite(range.endSeconds) ||
        range.startSeconds < 0 ||
        range.endSeconds > duration ||
        range.endSeconds <= range.startSeconds,
    )
  )
    throw new Error('节拍续建缓存与音频不匹配，请重新构建')
  const seen = new Set<string>()
  for (const seam of checkpoint.seams ?? []) {
    const key = `${seam.windowIndex}:${seam.side}`
    if (
      signature.modelId === 'basic' ||
      !checkpoint.completedWindows.includes(seam.windowIndex) ||
      (seam.side !== 'left' && seam.side !== 'right') ||
      !Number.isInteger(seam.firstFrame) ||
      seam.firstFrame < 0 ||
      seam.sustain.length < 2 ||
      seam.sustain.length > 33 ||
      seam.firstFrame + seam.sustain.length > expectedFrames ||
      seam.levels.length !== 4 ||
      !seam.levels.every((values) => validValues(values, seam.sustain.length)) ||
      !validValues(seam.sustain, seam.sustain.length) ||
      seen.has(key)
    )
      throw new Error('节拍续建接缝数据无效，请重新构建')
    seen.add(key)
  }
}

/** Restrict the adaptive scheduler to the requested playback buffer and its seams. */
export function nextBufferedBeatWindow(
  ranges: readonly BeatTimeRange[],
  completed: ReadonlySet<number>,
  timeline: BeatTimeline,
  timeSeconds: number,
  bufferSeconds: number | undefined,
  preferred: number | null,
  seamSeconds = 0,
): number | null {
  if (bufferSeconds === undefined) return preferred
  if (!Number.isFinite(bufferSeconds) || bufferSeconds < 0) throw new Error('节拍缓冲时长无效')
  const start = Math.max(0, Math.min(timeline.durationSeconds, timeSeconds))
  const end = Math.min(timeline.durationSeconds, start + bufferSeconds)
  if (
    end <= start ||
    continuousBeatCoverage(timeline.completedRanges ?? [], start, timeline.durationSeconds) +
      1e-8 >=
      end - start
  )
    return null
  const needed = ranges.flatMap((range, index) =>
    !completed.has(index) &&
    range.startSeconds - seamSeconds < end &&
    range.endSeconds + seamSeconds > start
      ? [index]
      : [],
  )
  if (!needed.length) throw new Error('节拍续建缓存缺少接缝，请重新构建')
  if (preferred !== null && needed.includes(preferred)) return preferred
  // If a slow device predicts beyond this bounded target, prepare its farthest
  // relevant tile instead of silently scanning unrelated later music.
  if (preferred !== null && preferred > needed.at(-1)!) return needed.at(-1)!
  return needed[0]!
}
