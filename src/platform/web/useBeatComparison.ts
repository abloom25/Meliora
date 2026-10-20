import { computed, onBeforeUnmount, shallowReadonly, shallowRef, watch, type Ref } from 'vue'
import {
  BEAT_COMPARISON_MODES,
  appendBeatComparisonSample,
  createBeatComparisonSample,
  createBeatComparisonSnapshot,
  type BeatComparisonMode,
  type BeatComparisonRoute,
  type BeatComparisonSnapshot,
} from '../../core/analysis/beat-comparison'
import type { BeatDebugSnapshot } from '../../core/analysis/beat-debug'
import type { BeatAnalysisCheckpoint } from '../../core/analysis/beat-checkpoint'
import type { BeatThisModelId } from '../../core/analysis/beat-this-models'
import { sanitizeBeatFlashRate } from '../../core/analysis/beat-envelope'
import {
  isBeatTimelineReadyAt,
  normalizeBeatRanges,
  type BeatTimeline,
} from '../../core/analysis/beat-timeline'
import { continuousBeatCoverage, type BeatPlaybackState } from '../../core/analysis/beat-scheduling'
import type { BeatAnalysisMode } from '../../core/types'
import { buildBeatTimeline, type BeatTimelineBuilder } from './beat-preanalysis'
import {
  createBeatComparisonRecorder,
  exportBeatComparisonData,
  type BeatComparisonExport,
  type BeatComparisonExportContext,
} from '../../core/analysis/beat-comparison-export'

const LOOKAHEAD_SECONDS = 60
const REFILL_SECONDS = 45
const JOB_GAP_MS = 200

export interface BeatComparisonOptions {
  source: Ref<string>
  durationSeconds: Ref<number>
  enabled: Ref<boolean>
  debug: Readonly<Ref<BeatDebugSnapshot | null>>
  modelAvailable: Ref<Record<BeatThisModelId, boolean>>
  flashRate?: Ref<number>
  liveTimeline?: Readonly<Ref<BeatTimeline | null>>
  liveMode?: Readonly<Ref<BeatAnalysisMode>>
  getPlaybackSeconds: () => number
  getPlaybackState?: () => BeatPlaybackState
  /** Prioritize the foreground's refill before granting one bounded job. */
  acquirePause?: (signal: AbortSignal) => Promise<() => void>
}

function modelId(mode: BeatComparisonMode): BeatThisModelId | undefined {
  if (mode === 'beat-this-small') return 'small'
  if (mode === 'beat-this-standard') return 'standard'
  return undefined
}
function readableError(error: unknown): string {
  return error instanceof Error && /[\u3400-\u9fff]/.test(error.message)
    ? error.message
    : '这一路对比暂时失败，停止后可以重新开始'
}
function coverage(timeline: BeatTimeline | null, position: number): number {
  if (!timeline) return 0
  const ranges = normalizeBeatRanges(
    timeline.completedRanges ?? [
      { startSeconds: 0, endSeconds: timeline.builtUntilSeconds ?? timeline.durationSeconds },
    ],
    timeline.durationSeconds,
  )
  return continuousBeatCoverage(ranges, position, timeline.durationSeconds)
}

/** Rolling observations and low-priority, one-window resumable candidate jobs. */
export function useBeatComparison(
  options: BeatComparisonOptions,
  dependencies: { build?: BeatTimelineBuilder; now?: () => number } = {},
) {
  const snapshot = shallowRef<BeatComparisonSnapshot>(createBeatComparisonSnapshot())
  const build = dependencies.build ?? buildBeatTimeline
  const now = dependencies.now ?? (() => performance.now())
  const busy = computed(() => snapshot.value.phase === 'running')
  const canStart = computed(
    () =>
      !busy.value &&
      options.enabled.value &&
      !!options.source.value &&
      Number.isFinite(options.durationSeconds.value) &&
      options.durationSeconds.value > 0 &&
      options.durationSeconds.value <= 600,
  )
  const checkpoints = new Map<BeatComparisonMode, BeatAnalysisCheckpoint>()
  const recorder = createBeatComparisonRecorder()
  const recordingStats = shallowRef(recorder.stats())
  const retainedLiveTimelines = new Map<BeatAnalysisMode, BeatTimeline>()
  let recordingEnabled = false
  let generation = 0
  let cursor = 0
  let disposed = false
  let nextJobTimer: ReturnType<typeof setTimeout> | null = null
  let job: {
    controller: AbortController
    mode: BeatComparisonMode
    listeners: Set<(playback: BeatPlaybackState) => void>
  } | null = null

  function updateRoute(mode: BeatComparisonMode, update: Partial<BeatComparisonRoute>): void {
    snapshot.value = {
      ...snapshot.value,
      routes: snapshot.value.routes.map((route) =>
        route.mode === mode ? { ...route, ...update } : route,
      ),
    }
  }
  function playbackState(): BeatPlaybackState {
    const debug = options.debug.value?.current
    return (
      options.getPlaybackState?.() ?? {
        timeSeconds: options.getPlaybackSeconds(),
        playing: debug?.playing ?? false,
        playbackRate: 1,
        seeking: debug?.seeking ?? false,
      }
    )
  }
  function available(mode: BeatComparisonMode): boolean {
    const id = modelId(mode)
    return !id || options.modelAvailable.value[id]
  }
  function timelineFor(mode: BeatComparisonMode, position: number): BeatTimeline | null {
    if (!available(mode)) return null
    const live = options.liveMode?.value === mode ? options.liveTimeline?.value : null
    if (live && isBeatTimelineReadyAt(live, position)) return live
    return snapshot.value.routes.find((route) => route.mode === mode)?.timeline ?? null
  }
  function stop(): void {
    generation += 1
    job?.controller.abort()
    if (nextJobTimer !== null) clearTimeout(nextJobTimer)
    nextJobTimer = null
    if (!busy.value) return
    snapshot.value = {
      ...snapshot.value,
      phase: 'cancelled',
      routes: snapshot.value.routes.map((route) =>
        route.status === 'queued' || route.status === 'running'
          ? { ...route, status: 'cancelled' }
          : route,
      ),
    }
  }
  function clear(): void {
    stop()
    checkpoints.clear()
    recorder.clear()
    recordingStats.value = recorder.stats()
    retainedLiveTimelines.clear()
    recordingEnabled = false
    snapshot.value = createBeatComparisonSnapshot(snapshot.value.epoch + 1)
  }
  function resetHistory(): void {
    snapshot.value = {
      ...snapshot.value,
      current: null,
      history: [],
      epoch: snapshot.value.epoch + 1,
    }
  }
  function rememberLiveTimeline(): void {
    const debug = options.debug.value
    const mode = options.liveMode?.value
    const timeline = options.liveTimeline?.value
    if (
      recordingEnabled &&
      timeline &&
      mode &&
      debug?.mode === mode &&
      debug.source === options.source.value
    )
      retainedLiveTimelines.set(mode, timeline)
  }
  function exportData(context: BeatComparisonExportContext): BeatComparisonExport {
    rememberLiveTimeline()
    return exportBeatComparisonData(snapshot.value, recorder.read(), context, retainedLiveTimelines)
  }
  function observe(debug: BeatDebugSnapshot | null): void {
    if (disposed || !options.enabled.value || !debug || debug.source !== options.source.value)
      return
    const actual = debug.current
    const previous = snapshot.value.current
    const rate = sanitizeBeatFlashRate(options.flashRate?.value)
    const state = playbackState()
    if (previous) {
      const elapsed = (actual.sampledAtMs - previous.sampledAtMs) / 1000
      const advance = actual.playbackSeconds - previous.playbackSeconds
      const expected = previous.actual.playing ? Math.max(0, elapsed) * state.playbackRate : 0
      if (
        debug.mode !== snapshot.value.actualMode ||
        rate !== previous.flashRate ||
        actual.seeking !== previous.actual.seeking ||
        elapsed < 0 ||
        Math.abs(advance - expected) > 1.5
      )
        resetHistory()
      else if (actual.sampledAtMs <= previous.sampledAtMs) return
    }
    const sample = createBeatComparisonSample(actual, rate, {
      basic: timelineFor('basic', actual.sampleSeconds),
      'beat-this-small': timelineFor('beat-this-small', actual.sampleSeconds),
      'beat-this-standard': timelineFor('beat-this-standard', actual.sampleSeconds),
    })
    snapshot.value = {
      ...snapshot.value,
      actualMode: debug.mode,
      flashRate: rate,
      current: sample,
      history: appendBeatComparisonSample(snapshot.value.history, sample),
    }
    if (recordingEnabled) {
      rememberLiveTimeline()
      if (recorder.append(sample, snapshot.value.epoch, debug.mode, state.playbackRate))
        recordingStats.value = recorder.stats()
    }
    for (const receive of job?.listeners ?? []) receive(state)
    pump()
  }
  function pump(): void {
    if (disposed || !busy.value || !options.enabled.value || job || nextJobTimer !== null) return
    const state = playbackState()
    if (state.seeking || !Number.isFinite(state.timeSeconds)) return
    const remaining = Math.max(0, options.durationSeconds.value - state.timeSeconds)
    if (remaining <= 0) return
    for (let offset = 0; offset < BEAT_COMPARISON_MODES.length; offset += 1) {
      const index = (cursor + offset) % BEAT_COMPARISON_MODES.length
      const mode = BEAT_COMPARISON_MODES[index]!
      const route = snapshot.value.routes.find((item) => item.mode === mode)!
      if (!available(mode)) {
        if (route.status !== 'unavailable')
          updateRoute(mode, { status: 'unavailable', error: '请先在设置中下载这个模型' })
        continue
      }
      if (route.status === 'error') continue
      if (
        coverage(timelineFor(mode, state.timeSeconds), state.timeSeconds) + 1e-8 >=
        Math.min(REFILL_SECONDS, remaining)
      ) {
        if (route.status !== 'ready')
          updateRoute(mode, { status: 'ready', phase: 'buffered', error: null })
        continue
      }
      cursor = (index + 1) % BEAT_COMPARISON_MODES.length
      void runWindow(mode)
      return
    }
  }
  async function runWindow(mode: BeatComparisonMode): Promise<void> {
    const version = generation
    const source = options.source.value
    const id = modelId(mode)
    const task = {
      controller: new AbortController(),
      mode,
      listeners: new Set<(playback: BeatPlaybackState) => void>(),
    }
    job = task
    const active = (): boolean =>
      !disposed &&
      busy.value &&
      generation === version &&
      source === options.source.value &&
      !task.controller.signal.aborted
    let release: (() => void) | undefined
    let startedAt: number | null = null
    updateRoute(mode, { status: 'queued', phase: 'idle', progress: 0, error: null })
    try {
      release = await options.acquirePause?.(task.controller.signal)
      if (!active()) return
      // The foreground can have filled this same mode while the lease waited.
      const state = playbackState()
      const target = Math.min(
        LOOKAHEAD_SECONDS,
        Math.max(0, options.durationSeconds.value - state.timeSeconds),
      )
      if (coverage(timelineFor(mode, state.timeSeconds), state.timeSeconds) + 1e-8 >= target) {
        updateRoute(mode, { status: 'ready', phase: 'buffered', progress: 1 })
        return
      }
      if (!available(mode)) {
        updateRoute(mode, { status: 'unavailable', error: '请先在设置中下载这个模型' })
        return
      }
      startedAt = now()
      updateRoute(mode, {
        status: 'running',
        phase: id ? 'loading-model' : 'fetching',
      })
      const timeline = await build(
        source,
        task.controller.signal,
        (status) => {
          if (!active()) return
          const position = playbackState().timeSeconds
          const available = continuousBeatCoverage(
            status.completedRanges ?? [],
            position,
            options.durationSeconds.value,
          )
          updateRoute(mode, {
            phase: status.phase,
            progress: Math.min(1, available / LOOKAHEAD_SECONDS),
          })
        },
        {
          durationSeconds: options.durationSeconds.value,
          modelId: id,
          checkpoint: checkpoints.get(mode),
          getPrioritySeconds: () => playbackState().timeSeconds,
          getPlaybackState: playbackState,
          getBufferSeconds: () => LOOKAHEAD_SECONDS,
          maxWindows: 1,
          subscribePriority: (listener) => {
            task.listeners.add(listener)
            return () => task.listeners.delete(listener)
          },
          onPartial: (timeline) => {
            if (active()) updateRoute(mode, { timeline })
          },
          onCheckpoint: (checkpoint) => {
            if (active()) checkpoints.set(mode, checkpoint)
          },
          onMetrics: (metrics) => {
            if (active()) updateRoute(mode, { metrics })
          },
          // Model workers' provisional basic previews never enter model curves.
        },
      )
      if (!active()) return
      updateRoute(mode, {
        status: 'ready',
        phase: 'buffered',
        timeline,
        progress: Math.min(1, coverage(timeline, playbackState().timeSeconds) / LOOKAHEAD_SECONDS),
        elapsedMs: Math.max(0, now() - startedAt),
      })
    } catch (error) {
      if (generation === version && busy.value && source === options.source.value) {
        const unavailable = !available(mode)
        updateRoute(mode, {
          status: unavailable ? 'unavailable' : 'error',
          phase: 'error',
          error: unavailable ? '请先在设置中下载这个模型' : readableError(error),
          elapsedMs: startedAt === null ? null : Math.max(0, now() - startedAt),
        })
      }
    } finally {
      task.listeners.clear()
      release?.()
      if (job === task) job = null
      if (!disposed && busy.value && nextJobTimer === null) {
        nextJobTimer = setTimeout(() => {
          nextJobTimer = null
          pump()
        }, JOB_GAP_MS)
      }
    }
  }
  async function start(): Promise<void> {
    if (disposed || !canStart.value) return
    generation += 1
    recordingEnabled = true
    cursor = 0
    const savedRoutes = snapshot.value.routes
    snapshot.value = {
      ...createBeatComparisonSnapshot(snapshot.value.epoch + 1),
      phase: 'running',
      requestedAtMs: now(),
      flashRate: sanitizeBeatFlashRate(options.flashRate?.value),
      routes: savedRoutes.map((route) => ({
        ...route,
        status: 'queued',
        error: null,
      })),
    }
    observe(options.debug.value)
    pump()
  }
  watch(() => options.debug.value, observe, { flush: 'sync', immediate: true })
  watch(options.source, clear, { flush: 'sync' })
  watch(
    options.enabled,
    (enabled) => {
      if (!enabled) {
        stop()
        resetHistory()
      } else observe(options.debug.value)
    },
    { flush: 'sync' },
  )
  watch(
    () => options.flashRate?.value,
    () => {
      resetHistory()
    },
    { flush: 'sync' },
  )
  watch(() => options.liveMode?.value, resetHistory, { flush: 'sync' })
  watch(
    () => [options.modelAvailable.value.small, options.modelAvailable.value.standard],
    () => {
      if (job && !available(job.mode)) job.controller.abort()
      for (const mode of BEAT_COMPARISON_MODES) {
        if (available(mode)) continue
        checkpoints.delete(mode)
        updateRoute(mode, { timeline: null, metrics: undefined })
      }
      pump()
    },
    { flush: 'sync' },
  )
  onBeforeUnmount(() => {
    disposed = true
    clear()
  })
  return {
    snapshot: shallowReadonly(snapshot),
    recordingStats: shallowReadonly(recordingStats),
    exportData,
    busy,
    canStart,
    start,
    stop,
    clear,
  }
}
