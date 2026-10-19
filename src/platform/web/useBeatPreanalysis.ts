import { computed, onBeforeUnmount, shallowRef, watch, type Ref } from 'vue'
import {
  beatRangesDuration,
  normalizeBeatRanges,
  type BeatBuildStatus,
  type BeatPreloadStatus,
  type BeatPreloadTarget,
  type BeatTimeline,
} from '../../core/analysis/beat-timeline'
import type { BeatAnalysisCheckpoint } from '../../core/analysis/beat-checkpoint'
import type { BeatAnalysisMode } from '../../core/types'
import { BEAT_THIS_MODELS, type BeatThisModelId } from '../../core/analysis/beat-this-models'
import { LruCache } from '../../core/util/lru-cache'
import { buildBeatTimeline, type BeatTimelineBuilder } from './beat-preanalysis'
import { continuousBeatCoverage, type BeatPlaybackState } from '../../core/analysis/beat-scheduling'

const TIMELINE_VERSION = 'rolling-v3'
const cachedTimelines = new LruCache<string, BeatTimeline>(3)
// Checkpoints live exactly as long as their small cached timeline; evicted songs
// cannot retain model/PCM allocations or an unbounded history of seam fragments.
const checkpoints = new WeakMap<BeatTimeline, BeatAnalysisCheckpoint>()
const INTRO_SECONDS = 20

export interface BeatPreanalysisOptions {
  source: Ref<string>
  mode?: Ref<BeatAnalysisMode>
  durationSeconds?: Ref<number>
  enabled?: Ref<boolean>
  unavailableReason?: Ref<string | null>
  adjacent?: Ref<readonly BeatPreloadTarget[]>
  preloadEnabled?: Ref<boolean>
  getPlaybackSeconds?: () => number
  getPlaybackState?: () => BeatPlaybackState
}

interface AnalysisJob {
  key: string
  source: string
  durationSeconds?: number
  modelId?: BeatThisModelId
  controller: AbortController
  status: BeatBuildStatus
  timeline: BeatTimeline | null
  checkpoint?: BeatAnalysisCheckpoint
  listeners: Set<(playback: BeatPlaybackState) => void>
  yieldListeners: Set<() => void>
  yielding: boolean
}

const idleStatus = (): BeatBuildStatus => ({ phase: 'idle', progress: 0, error: null })
const idlePlayback = (): BeatPlaybackState => ({
  timeSeconds: 0,
  playing: false,
  playbackRate: 1,
  seeking: false,
})

function rangesOf(result: BeatTimeline) {
  return normalizeBeatRanges(
    result.completedRanges ?? [
      { startSeconds: 0, endSeconds: result.builtUntilSeconds ?? result.durationSeconds },
    ],
    result.durationSeconds,
  )
}

function cachedStatus(result: BeatTimeline, timeSeconds = 0): BeatBuildStatus {
  const ranges = rangesOf(result)
  const availableSeconds = beatRangesDuration(ranges)
  const complete =
    ranges.length === 1 &&
    ranges[0]!.startSeconds === 0 &&
    ranges[0]!.endSeconds >= result.durationSeconds
  return {
    phase: complete ? 'ready' : 'buffered',
    progress: Math.min(1, availableSeconds / result.durationSeconds),
    error: null,
    availableSeconds,
    durationSeconds: result.durationSeconds,
    completedRanges: ranges,
    playbackSeconds: timeSeconds,
  }
}

export function useBeatPreanalysis(
  options: BeatPreanalysisOptions,
  dependencies: {
    build?: BeatTimelineBuilder
    cache?: LruCache<string, BeatTimeline>
  } = {},
) {
  const currentStatus = shallowRef<BeatBuildStatus>(idleStatus())
  const timeline = shallowRef<BeatTimeline | null>(null)
  const cache = dependencies.cache ?? cachedTimelines
  const build = dependencies.build ?? buildBeatTimeline
  const jobRevision = shallowRef(0)
  const backgroundFailures = new Map<string, string>()
  let job: AnalysisJob | null = null
  let disposed = false
  let startedSource: string | null = null
  let lastPlayback = idlePlayback()
  let lastPriorityKey = ''
  let refilling = false

  function modelId(): BeatThisModelId | undefined {
    return options.mode?.value === 'beat-this-small'
      ? 'small'
      : options.mode?.value === 'beat-this-standard'
        ? 'standard'
        : undefined
  }

  function cacheKey(source: string): string {
    const id = modelId()
    return `${TIMELINE_VERSION}:${id ? BEAT_THIS_MODELS[id].version : 'basic'}:${source}`
  }

  function canAnalyse(): boolean {
    return !disposed && (options.enabled?.value ?? true) && !options.unavailableReason?.value
  }

  function targets(): readonly BeatPreloadTarget[] {
    if (!canAnalyse() || options.preloadEnabled?.value === false) return []
    return (options.adjacent?.value ?? []).filter(
      (target) => target.source && target.source !== options.source.value,
    )
  }

  function sanitizePlayback(state: BeatPlaybackState): BeatPlaybackState {
    return {
      timeSeconds: Number.isFinite(state.timeSeconds) ? Math.max(0, state.timeSeconds) : 0,
      playing: state.playing === true,
      playbackRate:
        Number.isFinite(state.playbackRate) && state.playbackRate > 0
          ? Math.min(16, state.playbackRate)
          : 1,
      seeking: state.seeking === true,
    }
  }

  function playbackState(): BeatPlaybackState {
    return sanitizePlayback(
      options.getPlaybackState?.() ?? {
        ...lastPlayback,
        timeSeconds: options.getPlaybackSeconds?.() ?? lastPlayback.timeSeconds,
      },
    )
  }

  function isLive(candidate: AnalysisJob): boolean {
    return !disposed && job === candidate && !candidate.controller.signal.aborted
  }

  function isForeground(candidate: AnalysisJob): boolean {
    return (
      startedSource === options.source.value && candidate.key === cacheKey(options.source.value)
    )
  }

  function jobPlayback(candidate: AnalysisJob): BeatPlaybackState {
    return isForeground(candidate) ? playbackState() : idlePlayback()
  }

  function watermarks(result: BeatTimeline | null, state = playbackState()) {
    const estimate = result ? (checkpoints.get(result)?.estimatedWorkMs ?? 0) / 1000 : 0
    // Start early enough for another window and its setup. Hysteresis prevents
    // each timeupdate from starting a tiny new job when the buffer is sufficient.
    const low = Math.min(60, Math.max(20, estimate * 1.5 + 5)) * state.playbackRate
    return {
      low: Math.min(90, low),
      high: Math.min(120, Math.max(60 * state.playbackRate, low + 20 * state.playbackRate)),
    }
  }

  function coverage(result: BeatTimeline | null, timeSeconds: number): number {
    return result
      ? continuousBeatCoverage(rangesOf(result), timeSeconds, result.durationSeconds)
      : 0
  }

  function remember(candidate: AnalysisJob, result: BeatTimeline): void {
    if (candidate.checkpoint) {
      candidate.checkpoint = { ...candidate.checkpoint, timeline: result }
      checkpoints.set(result, candidate.checkpoint)
    }
    // Keep the active song and its actual neighbours ahead of obsolete entries.
    for (const target of targets()) cache.get(cacheKey(target.source))
    cache.get(cacheKey(options.source.value))
    cache.set(candidate.key, result)
  }

  function prioritize(timeSeconds: number, state = playbackState()): void {
    if (disposed || !Number.isFinite(timeSeconds)) return
    lastPlayback = sanitizePlayback({ ...state, timeSeconds })
    const key = `${Math.floor(lastPlayback.timeSeconds)}:${lastPlayback.playing}:${lastPlayback.playbackRate}:${lastPlayback.seeking}`
    if (key === lastPriorityKey) return
    lastPriorityKey = key
    if (job && isLive(job) && isForeground(job))
      for (const listener of job.listeners) listener(lastPlayback)
    // A sleeping coordinator must wake before the completed range is exhausted.
    reconcile()
  }

  const status = computed<BeatBuildStatus>(() => {
    void jobRevision.value
    if (!options.adjacent) return currentStatus.value
    const adjacent: BeatPreloadStatus[] = targets().map((target) => {
      const key = cacheKey(target.source)
      if (job?.key === key && isLive(job)) return { ...target, ...job.status }
      const result = cache.get(key)
      const saved = result ? cachedStatus(result) : idleStatus()
      const error = backgroundFailures.get(key)
      return { ...target, ...saved, ...(error ? { phase: 'error' as const, error } : {}) }
    })
    return { ...currentStatus.value, adjacent }
  })

  function publish(candidate: AnalysisJob): void {
    jobRevision.value += 1
    if (!isLive(candidate) || !isForeground(candidate)) return
    timeline.value = candidate.timeline
    currentStatus.value = { ...candidate.status, playbackSeconds: playbackState().timeSeconds }
  }

  function cancelJob(): void {
    job?.controller.abort()
    job?.listeners.clear()
    job?.yieldListeners.clear()
    jobRevision.value += 1
  }

  function yieldJob(candidate: AnalysisJob): void {
    if (!isLive(candidate) || candidate.yielding) return
    candidate.yielding = true
    if (candidate.yieldListeners.size) {
      // Let an already running inference finish, checkpoint it, and hand back the
      // single resource slot. Cancelling a download/decode still settles first.
      for (const listener of candidate.yieldListeners) listener()
    } else cancelJob()
  }

  function clearCurrent(): void {
    lastPriorityKey = ''
    refilling = false
    timeline.value = null
    currentStatus.value = idleStatus()
  }

  function begin(source: string, durationSeconds?: number): void {
    const key = cacheKey(source)
    const saved = cache.get(key) ?? null
    const candidate: AnalysisJob = {
      key,
      source,
      durationSeconds,
      modelId: modelId(),
      controller: new AbortController(),
      status: {
        ...(saved ? cachedStatus(saved) : idleStatus()),
        phase: 'fetching',
        durationSeconds,
      },
      timeline: saved,
      checkpoint: saved ? checkpoints.get(saved) : undefined,
      listeners: new Set(),
      yieldListeners: new Set(),
      yielding: false,
    }
    job = candidate
    publish(candidate)
    const signal = candidate.controller.signal
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return build(
          source,
          signal,
          (nextStatus) => {
            if (!isLive(candidate)) return
            candidate.status = nextStatus
            publish(candidate)
          },
          {
            durationSeconds: candidate.durationSeconds,
            checkpoint: candidate.checkpoint,
            getPrioritySeconds: () => jobPlayback(candidate).timeSeconds,
            getPlaybackState: () => jobPlayback(candidate),
            getBufferSeconds: () =>
              isForeground(candidate) ? watermarks(candidate.timeline).high : INTRO_SECONDS,
            maxWindows: isForeground(candidate) ? 3 : 1,
            subscribePriority: (listener) => {
              if (!isLive(candidate)) return () => undefined
              candidate.listeners.add(listener)
              return () => candidate.listeners.delete(listener)
            },
            subscribeYield: (listener) => {
              if (!isLive(candidate)) return () => undefined
              candidate.yieldListeners.add(listener)
              return () => candidate.yieldListeners.delete(listener)
            },
            ...(candidate.modelId ? { modelId: candidate.modelId } : {}),
            onCheckpoint: (checkpoint) => {
              if (!isLive(candidate)) return
              candidate.checkpoint = checkpoint
              candidate.timeline = checkpoint.timeline
              remember(candidate, checkpoint.timeline)
            },
            onPartial: (partial) => {
              if (!isLive(candidate)) return
              candidate.timeline = partial
              candidate.status = {
                ...candidate.status,
                ...cachedStatus(partial),
                phase: 'analysing',
              }
              // In-window DSP snapshots can be displayed, but only validated
              // checkpoints promise that finished windows can be resumed.
              publish(candidate)
            },
          },
        )
      })
      .then((result) => {
        if (!isLive(candidate)) return
        candidate.timeline = result
        remember(candidate, result)
        candidate.status = cachedStatus(result)
        publish(candidate)
      })
      .catch((error: unknown) => {
        if (!isLive(candidate)) return
        const message =
          error instanceof Error && /[\u3400-\u9fff]/.test(error.message)
            ? error.message
            : '高亮构建失败，播放不受影响，可重新尝试'
        candidate.status = {
          ...candidate.status,
          phase: 'error',
          activeRange: undefined,
          error: message,
        }
        if (!isForeground(candidate)) backgroundFailures.set(candidate.key, message)
        publish(candidate)
      })
      .finally(() => {
        candidate.listeners.clear()
        candidate.yieldListeners.clear()
        if (job === candidate) job = null
        jobRevision.value += 1
        reconcile()
      })
  }

  function reconcile(): void {
    if (disposed) return
    if (options.unavailableReason?.value) {
      currentStatus.value = { phase: 'error', progress: 0, error: options.unavailableReason.value }
      return
    }
    if (!canAnalyse()) return
    const source = options.source.value
    if (!source || startedSource !== source) return
    if (currentStatus.value.phase === 'error') return
    const state = playbackState()
    const foregroundJob = job && isLive(job) && isForeground(job) ? job : null
    if (foregroundJob) publish(foregroundJob)
    else {
      const saved = cache.get(cacheKey(source))
      if (saved) {
        timeline.value = saved
        currentStatus.value = cachedStatus(saved, state.timeSeconds)
      }
    }
    if (options.getPlaybackState && !state.playing) {
      if (job) yieldJob(job)
      return
    }
    if (state.seeking) {
      if (job && !foregroundJob) yieldJob(job)
      return
    }
    const duration = timeline.value?.durationSeconds ?? options.durationSeconds?.value ?? 0
    const remaining = Math.max(0, duration - state.timeSeconds)
    const available = coverage(timeline.value, state.timeSeconds)
    const limits = watermarks(timeline.value, state)
    const full = currentStatus.value.phase === 'ready'
    if (full || (timeline.value && available + 0.01 >= Math.min(remaining, limits.high)))
      refilling = false
    else if (!timeline.value || available + 0.01 < Math.min(remaining, limits.low)) refilling = true
    if (job) {
      if (!foregroundJob && refilling) yieldJob(job)
      return
    }
    if (refilling) {
      begin(source, options.durationSeconds?.value)
      return
    }
    const ordered = [...targets()].sort(
      (a, b) => Number(b.direction === 'next') - Number(a.direction === 'next'),
    )
    const next = ordered.find((target) => {
      const key = cacheKey(target.source)
      if (
        !Number.isFinite(target.durationSeconds) ||
        target.durationSeconds! <= 0 ||
        backgroundFailures.has(key)
      )
        return false
      const saved = cache.get(key) ?? null
      return coverage(saved, 0) + 0.01 < Math.min(INTRO_SECONDS, target.durationSeconds!)
    })
    if (next) begin(next.source, next.durationSeconds)
  }

  function reset(): void {
    startedSource = null
    cancelJob()
    clearCurrent()
    reconcile()
  }

  function start(): void {
    if (disposed || !options.source.value) return
    startedSource = options.source.value
    if (job && isLive(job) && isForeground(job)) {
      publish(job)
      lastPriorityKey = ''
      const state = playbackState()
      prioritize(state.timeSeconds, state)
    }
    reconcile()
  }

  function retry(): void {
    if (disposed) return
    cache.delete(cacheKey(options.source.value))
    backgroundFailures.delete(cacheKey(options.source.value))
    cancelJob()
    clearCurrent()
    reconcile()
  }

  watch(
    options.source,
    () => {
      startedSource = null
      clearCurrent()
      // Preserve a matching promoted neighbour through the source/play-event gap.
      if (job && job.key !== cacheKey(options.source.value)) cancelJob()
      reconcile()
    },
    { flush: 'sync' },
  )
  watch(
    () => [options.enabled?.value, options.unavailableReason?.value, options.mode?.value],
    () => {
      cancelJob()
      backgroundFailures.clear()
      clearCurrent()
      reconcile()
    },
    { flush: 'sync', immediate: true },
  )
  watch(
    () => [options.adjacent?.value, options.preloadEnabled?.value],
    () => {
      const valid = new Set(targets().map((target) => cacheKey(target.source)))
      for (const key of backgroundFailures.keys())
        if (!valid.has(key)) backgroundFailures.delete(key)
      if (job && job.key !== cacheKey(options.source.value) && !valid.has(job.key)) cancelJob()
      jobRevision.value += 1
      reconcile()
    },
    { flush: 'sync' },
  )
  onBeforeUnmount(() => {
    disposed = true
    reset()
    backgroundFailures.clear()
  })

  return { status, timeline, start, reset, retry, prioritize }
}
