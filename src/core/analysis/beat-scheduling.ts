import { normalizeBeatRanges, type BeatTimeRange } from './beat-timeline'

export interface BeatPlaybackState {
  timeSeconds: number
  playing: boolean
  playbackRate: number
  seeking: boolean
}

export interface BeatSchedulingController {
  /** All timestamps belong to the caller's monotonic clock. */
  updatePlayback(state: BeatPlaybackState, nowMs: number): void
  playbackAt(nowMs: number): BeatPlaybackState
  /** A successful model probe can seed the estimate before the first real window. */
  seedWorkDuration(durationMs: number): void
  /** Complete window work, excluding time spent waiting for a seek to settle. */
  observeWorkDuration(durationMs: number): void
  readonly estimatedWorkMs: number
  /** Returns an input index without reserving it. Null also means seeking: wait and retry. */
  next(
    ranges: readonly BeatTimeRange[],
    completed: ReadonlySet<number>,
    nowMs: number,
  ): number | null
}

interface IndexedRange extends BeatTimeRange {
  index: number
}

/** Audio seconds available from this exact point, never across an unfinished hole. */
export function continuousBeatCoverage(
  completedRanges: readonly BeatTimeRange[],
  timeSeconds: number,
  durationSeconds: number,
): number {
  if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds >= durationSeconds) return 0
  const range = normalizeBeatRanges(completedRanges, durationSeconds).find(
    (candidate) => timeSeconds >= candidate.startSeconds && timeSeconds < candidate.endSeconds,
  )
  return range ? range.endSeconds - timeSeconds : 0
}

function clampTime(timeSeconds: number, durationSeconds: number): number {
  return Math.max(0, Math.min(durationSeconds, timeSeconds))
}

function nearestRange(ranges: readonly IndexedRange[], timeSeconds: number): IndexedRange {
  const distance = (range: BeatTimeRange): number =>
    Math.max(range.startSeconds - timeSeconds, timeSeconds - range.endSeconds, 0)
  return ranges.reduce((nearest, candidate) => {
    const difference = distance(candidate) - distance(nearest)
    // At an exact boundary or equal distance, prepare the upcoming audio first.
    return difference < 0 || (difference === 0 && candidate.endSeconds > nearest.endSeconds)
      ? candidate
      : nearest
  })
}

/** Pure scheduling state: the platform supplies time and marks only finished work complete. */
export function createBeatSchedulingController(
  durationSeconds: number,
  initialPlayback: BeatPlaybackState,
  nowMs: number,
): BeatSchedulingController {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('节拍调度时长无效')
  let anchorMs = Number.isFinite(nowMs) ? nowMs : 0
  let playback: BeatPlaybackState = {
    timeSeconds: 0,
    playing: false,
    playbackRate: 1,
    seeking: false,
  }
  let estimateMs = 0
  let hasEstimate = false
  let observedWork = false

  const playbackAt = (timeMs: number): BeatPlaybackState => {
    const elapsed = Number.isFinite(timeMs) ? Math.max(0, timeMs - anchorMs) / 1000 : 0
    return {
      ...playback,
      timeSeconds: clampTime(
        playback.timeSeconds +
          (playback.playing && !playback.seeking ? elapsed * playback.playbackRate : 0),
        durationSeconds,
      ),
    }
  }

  const updatePlayback = (state: BeatPlaybackState, timeMs: number): void => {
    const nextAnchor = Number.isFinite(timeMs) ? Math.max(anchorMs, timeMs) : anchorMs
    const fallbackTime = playbackAt(nextAnchor).timeSeconds
    playback = {
      timeSeconds: clampTime(
        Number.isFinite(state.timeSeconds) ? state.timeSeconds : fallbackTime,
        durationSeconds,
      ),
      playing: state.playing,
      playbackRate:
        Number.isFinite(state.playbackRate) && state.playbackRate > 0 ? state.playbackRate : 1,
      seeking: state.seeking,
    }
    anchorMs = nextAnchor
  }

  updatePlayback(initialPlayback, anchorMs)

  return {
    updatePlayback,
    playbackAt,
    seedWorkDuration(durationMs): void {
      if (!Number.isFinite(durationMs) || durationMs < 0) return
      // A fallback backend's probe may raise an existing estimate, but a warm
      // probe alone must not erase the measured feature/DSP/postprocessing cost.
      if (!observedWork) {
        estimateMs = durationMs
        hasEstimate = true
      } else if (durationMs > estimateMs) {
        estimateMs = durationMs
      }
    },
    observeWorkDuration(durationMs): void {
      if (!Number.isFinite(durationMs) || durationMs < 0) return
      if (!hasEstimate) estimateMs = durationMs
      else {
        // React quickly to throttling, but do not chase individual fast windows.
        const weight = durationMs > estimateMs ? 0.85 : 0.15
        estimateMs = estimateMs * (1 - weight) + durationMs * weight
      }
      hasEstimate = true
      observedWork = true
    },
    get estimatedWorkMs(): number {
      return estimateMs
    },
    next(ranges, completed, timeMs): number | null {
      const state = playbackAt(timeMs)
      if (state.seeking) return null
      const valid: IndexedRange[] = ranges
        .map((range, index) => ({ ...range, index }))
        .filter((range) => Number.isFinite(range.startSeconds) && Number.isFinite(range.endSeconds))
        .map((range) => ({
          index: range.index,
          startSeconds: clampTime(range.startSeconds, durationSeconds),
          endSeconds: clampTime(range.endSeconds, durationSeconds),
        }))
        .filter((range) => range.endSeconds > range.startSeconds)
        .sort((left, right) => left.startSeconds - right.startSeconds)
      const pending = valid.filter((range) => !completed.has(range.index))
      if (!pending.length) return null
      if (!state.playing || state.timeSeconds >= durationSeconds)
        return nearestRange(pending, state.timeSeconds).index

      const current = pending.find(
        (range) => state.timeSeconds >= range.startSeconds && state.timeSeconds < range.endSeconds,
      )
      // Before any measurement, starting nearby is better than inventing a cost.
      if (!hasEstimate || estimateMs === 0)
        return (current ?? nearestRange(pending, state.timeSeconds)).index

      const lengths = valid
        .map((range) => range.endSeconds - range.startSeconds)
        .sort((left, right) => left - right)
      const windowSeconds = lengths[Math.floor(lengths.length / 2)]!
      const advance = (estimateMs / 1000) * state.playbackRate
      // The safety margin is small and bounded; measured work may require a much
      // larger jump on slow hardware. Capping that jump would perpetually build
      // behind playback. Both positions are always clamped to the actual song.
      const reserve = Math.min(4, windowSeconds / 4, Math.max(1, state.playbackRate * 2))
      const finishSeconds = clampTime(state.timeSeconds + advance, durationSeconds)
      if (current && current.endSeconds - finishSeconds >= reserve) return current.index

      const completedRanges = valid.filter((range) => completed.has(range.index))
      const coverage = continuousBeatCoverage(completedRanges, state.timeSeconds, durationSeconds)
      const desiredBuffer = Math.max(windowSeconds * 2, advance * 2 + reserve)
      // With enough runway to finish another job safely, repair nearby history
      // or a forward hole instead of extending ever farther away from playback.
      if (coverage >= desiredBuffer) return nearestRange(pending, state.timeSeconds).index

      const target = clampTime(finishSeconds + reserve, durationSeconds)
      const upcoming = pending.find((range) => range.endSeconds > target)
      // At the song's end no future window can catch playback. Complete the
      // nearest remaining hole; never wrap to the beginning merely due to clamp.
      return (upcoming ?? nearestRange(pending, finishSeconds)).index
    },
  }
}
