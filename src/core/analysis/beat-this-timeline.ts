import { BEAT_FLASH_RATE_STEPS } from './beat-envelope'
import {
  createBeatTimelineBuffer,
  mergeBeatTimelineRange,
  normalizeBeatRanges,
  snapshotBeatTimeline,
  type BeatTimeRange,
  type BeatTimeline,
} from './beat-timeline'
import type { BeatThisPrediction, BeatThisWindow } from './beat-this-prediction'
import {
  cloneBeatSeam,
  type BeatAnalysisCheckpoint,
  type BeatThisSeamCheckpoint,
} from './beat-checkpoint'

const ONSET_CORRECTION_SECONDS = 0.05

/** Completed tile interiors are immutable; a seam is filled only after both neighbours exist. */
export function createBeatThisTimelineAssembler(
  durationSeconds: number,
  windows: readonly BeatThisWindow[],
  checkpoint?: BeatAnalysisCheckpoint,
) {
  const timeline = checkpoint
    ? snapshotBeatTimeline(checkpoint.timeline)
    : createBeatTimelineBuffer(durationSeconds)
  const completed = new Set(checkpoint?.completedWindows)
  const edges = new Map<string, BeatThisSeamCheckpoint>()
  for (const seam of checkpoint?.seams ?? [])
    edges.set(`${seam.windowIndex}:${seam.side}`, cloneBeatSeam(seam))
  const seamWidth = (left: BeatThisWindow, right: BeatThisWindow): number =>
    Math.min(
      0.25,
      (left.range.endSeconds - left.range.startSeconds) / 3,
      (right.range.endSeconds - right.range.startSeconds) / 3,
    )
  for (const seam of edges.values()) {
    const window = windows[seam.windowIndex]
    const neighbor = windows[seam.windowIndex + (seam.side === 'left' ? -1 : 1)]
    if (!window || !neighbor || completed.has(neighbor.index))
      throw new Error('节拍续建接缝位置无效，请重新构建')
    const width = seam.side === 'left' ? seamWidth(neighbor, window) : seamWidth(window, neighbor)
    const boundary = seam.side === 'left' ? window.range.startSeconds : window.range.endSeconds
    const firstFrame = Math.floor((boundary - width) / timeline.stepSeconds)
    const endFrame = Math.ceil((boundary + width) / timeline.stepSeconds) + 1
    if (seam.firstFrame !== firstFrame || seam.sustain.length !== endFrame - firstFrame)
      throw new Error('节拍续建接缝位置无效，请重新构建')
  }
  const edge = (window: BeatThisWindow, side: 'left' | 'right', part: BeatTimeline): void => {
    const other = windows[window.index + (side === 'left' ? -1 : 1)]
    if (!other) return
    const width = side === 'left' ? seamWidth(other, window) : seamWidth(window, other)
    const boundary = side === 'left' ? window.range.startSeconds : window.range.endSeconds
    const firstFrame = Math.floor((boundary - width) / timeline.stepSeconds)
    const endFrame = Math.ceil((boundary + width) / timeline.stepSeconds) + 1
    edges.set(`${window.index}:${side}`, {
      windowIndex: window.index,
      side,
      firstFrame,
      levels: part.levels.map((values) =>
        values.slice(firstFrame, endFrame),
      ) as BeatTimeline['levels'],
      sustain: part.sustain.slice(firstFrame, endFrame),
    })
  }
  // Every unjoined boundary of a completed tile must retain both sides' support
  // for its own contribution. Missing edges cannot be repaired from frozen pixels.
  for (const index of completed) {
    for (const side of ['left', 'right'] as const) {
      const neighbor = index + (side === 'left' ? -1 : 1)
      if (windows[neighbor] && !completed.has(neighbor) && !edges.has(`${index}:${side}`))
        throw new Error('节拍续建缓存缺少接缝，请重新构建')
    }
  }
  return {
    timeline,
    snapshotSeams(): BeatThisSeamCheckpoint[] {
      return [...edges.values()].map(cloneBeatSeam)
    },
    add(window: BeatThisWindow, part: BeatTimeline): void {
      if (completed.has(window.index)) return
      completed.add(window.index)
      edge(window, 'left', part)
      edge(window, 'right', part)
      const previous = windows[window.index - 1]
      const next = windows[window.index + 1]
      const startSeconds = window.range.startSeconds + (previous ? seamWidth(previous, window) : 0)
      const endSeconds = window.range.endSeconds - (next ? seamWidth(window, next) : 0)
      mergeBeatTimelineRange(timeline, part, { startSeconds, endSeconds })
      for (const leftIndex of [window.index - 1, window.index]) {
        const leftWindow = windows[leftIndex]
        const rightWindow = windows[leftIndex + 1]
        const left = edges.get(`${leftIndex}:right`)
        const right = edges.get(`${leftIndex + 1}:left`)
        if (!leftWindow || !rightWindow || !left || !right) continue
        const width = seamWidth(leftWindow, rightWindow)
        const boundary = leftWindow.range.endSeconds
        const seamStart = boundary - width
        const seamEnd = boundary + width
        const seam = createBeatTimelineBuffer(durationSeconds, timeline.stepSeconds)
        const first = Math.floor(seamStart / timeline.stepSeconds)
        const end = Math.ceil(seamEnd / timeline.stepSeconds)
        for (let frame = first; frame <= end; frame += 1) {
          const mix = Math.max(
            0,
            Math.min(1, (frame * timeline.stepSeconds - seamStart) / (seamEnd - seamStart)),
          )
          for (let density = 0; density < timeline.levels.length; density += 1) {
            seam.levels[density]![frame] =
              left.levels[density]![frame - left.firstFrame]! * (1 - mix) +
              right.levels[density]![frame - right.firstFrame]! * mix
          }
          seam.sustain[frame] =
            left.sustain[frame - left.firstFrame]! * (1 - mix) +
            right.sustain[frame - right.firstFrame]! * mix
        }
        mergeBeatTimelineRange(timeline, seam, { startSeconds: seamStart, endSeconds: seamEnd })
        edges.delete(`${leftIndex}:right`)
        edges.delete(`${leftIndex + 1}:left`)
      }
    },
  }
}

/** A copied, stable prefix can be transferred while the original build keeps running. */
export function createBeatThisPartialTimeline(
  basic: BeatTimeline,
  prediction: BeatThisPrediction,
  predictedUntilSeconds: number,
): BeatTimeline | null {
  // The last beat still needs a future neighbour for its release and subdivisions.
  // Its corrected onset can move earlier, so leave that margin outside the prefix.
  // Leave 200ms at the window edge for peak-picking and downbeat-to-beat snapping.
  const boundary = Math.min(
    predictedUntilSeconds - 0.2,
    prediction.beats.length
      ? prediction.beats.at(-1)! - ONSET_CORRECTION_SECONDS - basic.stepSeconds
      : predictedUntilSeconds,
  )
  const frames = Math.min(basic.sustain.length, Math.floor(boundary / basic.stepSeconds) + 1)
  if (frames < 2) return null
  const builtUntilSeconds = (frames - 1) * basic.stepSeconds
  const blended = blendBeatThisTimeline(basic, prediction)
  return {
    durationSeconds: basic.durationSeconds,
    stepSeconds: basic.stepSeconds,
    builtUntilSeconds,
    levels: [
      blended.levels[0].slice(0, frames),
      blended.levels[1].slice(0, frames),
      blended.levels[2].slice(0, frames),
      blended.levels[3].slice(0, frames),
    ],
    sustain: basic.sustain.slice(0, frames),
  }
}

/** Model positions set the rhythm; a sharp local HPSS rise can refine its timing. */
export function blendBeatThisTimeline(
  basic: BeatTimeline,
  prediction: BeatThisPrediction,
): BeatTimeline {
  const length = basic.sustain.length
  const levels: BeatTimeline['levels'] = [
    new Float32Array(length),
    new Float32Array(length),
    new Float32Array(length),
    new Float32Array(length),
  ]
  const strengths = basic.levels[3]
  const step = basic.stepSeconds
  const ranges = normalizeBeatRanges(
    basic.completedRanges ?? [
      { startSeconds: 0, endSeconds: basic.builtUntilSeconds ?? basic.durationSeconds },
    ],
    basic.durationSeconds,
  )
  const rangeAt = (time: number): BeatTimeRange | undefined =>
    ranges.find((range) => time >= range.startSeconds && time < range.endSeconds)
  const downbeats = new Set(prediction.downbeats)
  const beats = [...new Set(prediction.beats)]
    .filter((time) => Number.isFinite(time) && time >= 0 && time < basic.durationSeconds)
    .sort((left, right) => left - right)
  const nearStrength = (time: number, radius = 0.06): number => {
    const range = rangeAt(time)
    if (!range) return 0
    let strength = 0
    const first = Math.max(0, Math.ceil(Math.max(time - radius, range.startSeconds) / step))
    const end = Math.min(
      length - 1,
      Math.floor((time + radius) / step),
      Math.ceil(range.endSeconds / step) - 1,
    )
    for (let frame = first; frame <= end; frame += 1)
      strength = Math.max(strength, strengths[frame]!)
    return strength
  }
  // This is a 60 Hz envelope-rise proxy, not a raw waveform onset detector.
  // Limit corrections to 50 ms and require a concentrated positive edge, so a
  // broad attack, sustained level, or decaying peak cannot pull the model beat.
  const localOnset = (time: number, previous: number, next: number): number | null => {
    const range = rangeAt(time)
    if (!range) return null
    const riseAt = (frame: number): number => {
      if (
        frame < 1 ||
        frame >= strengths.length ||
        (frame - 1) * step < range.startSeconds ||
        frame * step >= range.endSeconds
      )
        return 0
      return Math.max(0, strengths[frame]! - strengths[frame - 1]!)
    }
    const first = Math.max(1, Math.ceil((time - ONSET_CORRECTION_SECONDS) / step - 1e-8))
    const end = Math.min(length - 1, Math.floor((time + ONSET_CORRECTION_SECONDS) / step + 1e-8))
    const candidates: Array<{ time: number; score: number }> = []
    for (let frame = first; frame <= end; frame += 1) {
      const candidateTime = frame * step
      // Midpoint ownership prevents adjacent predictions from sharing an onset
      // or changing order, including unusually close model predictions.
      if (candidateTime <= (previous + time) / 2 || candidateTime >= (time + next) / 2) continue
      const rise = riseAt(frame)
      if (
        rise < 0.08 ||
        rise < strengths[frame]! * 0.2 ||
        rise <= riseAt(frame - 1) ||
        rise < riseAt(frame + 1)
      )
        continue
      let neighborhoodRise = 0
      for (let neighbor = frame - 2; neighbor <= frame + 2; neighbor += 1)
        neighborhoodRise += riseAt(neighbor)
      if (rise < neighborhoodRise * 0.55) continue
      candidates.push({
        time: candidateTime,
        score: rise * (1 - Math.abs(candidateTime - time) / (ONSET_CORRECTION_SECONDS * 2)),
      })
    }
    candidates.sort((left, right) => right.score - left.score)
    const best = candidates[0]
    // Equally plausible nearby transients do not justify moving the beat.
    if (!best || (candidates[1]?.score ?? 0) >= best.score * 0.8) return null
    return best.time
  }
  const pulse = (output: Float32Array, time: number, amplitude: number, release: number): void => {
    if (amplitude <= 0.015) return
    const range = rangeAt(time)
    if (!range) return
    const first = Math.max(0, Math.round(time / step))
    // Retain the inclusive interpolation support sample, but never continue a
    // decay through an unbuilt hole into a later independently built range.
    const end = Math.min(
      length,
      Math.ceil(range.endSeconds / step) + 1,
      first + Math.ceil((release * 5) / step),
    )
    for (let frame = first; frame < end; frame += 1) {
      output[frame] = Math.max(
        output[frame]!,
        amplitude * Math.exp(-((frame - first) * step) / release),
      )
    }
  }
  let barStart = 0
  for (let index = 0; index < beats.length; index += 1) {
    const time = beats[index]!
    const downbeat = downbeats.has(time)
    if (downbeat) barStart = index
    const next = beats[index + 1]
    const interval = next !== undefined ? next - time : time - (beats[index - 1] ?? time - 0.5)
    const period = Math.max(0.2, Math.min(1.5, interval))
    const strength = Math.min(1, nearStrength(time) * (downbeat ? 1.12 : 1))
    const correctedTime = localOnset(time, beats[index - 1] ?? -Infinity, next ?? Infinity) ?? time
    for (let density = 0; density < levels.length; density += 1) {
      const rate = BEAT_FLASH_RATE_STEPS[density]!
      if (rate === 0.5 && (index - barStart) % 2 !== 0) continue
      const release = Math.max(0.08, Math.min(0.5, (period * 0.3) / Math.max(1, rate)))
      pulse(levels[density]!, correctedTime, strength, release)
      // Higher densities permit actual inter-beat drum hits, never invent a metronome
      // in an unaccented sustain or across a long gap in the model's predictions.
      if (rate > 1 && next !== undefined && interval >= 0.2 && interval <= 1.5) {
        for (let subdivision = 1; subdivision < rate; subdivision += 1) {
          const subTime = time + (interval * subdivision) / rate
          const onset = localOnset(subTime, subTime - interval / rate, subTime + interval / rate)
          if (onset !== null) pulse(levels[density]!, onset, nearStrength(subTime, 0.05), release)
        }
      }
    }
  }
  return { ...basic, levels, sustain: basic.sustain }
}
