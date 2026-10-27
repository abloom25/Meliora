import {
  computed,
  onBeforeUnmount,
  readonly,
  shallowReadonly,
  shallowRef,
  watch,
  type Ref,
} from 'vue'
import {
  beatRangesDuration,
  normalizeBeatRanges,
  createBeatTimelineBuffer,
  mergeBeatTimelineRange,
  snapshotBeatTimeline,
  type BeatBuildStatus,
  type BeatPreloadStatus,
  type BeatPreloadTarget,
  type BeatTimeline,
} from '../../core/analysis/beat-timeline'
import type { BeatAnalysisCheckpoint } from '../../core/analysis/beat-checkpoint'
import type { BeatAnalysisMetrics } from '../../core/analysis/beat-preanalysis-protocol'
import type { BeatAnalysisMode, Track } from '../../core/types'
import type { PlaybackResourcePressure } from '../../core/playback/resource-budget'
import { listeningTrackKey } from '../../core/playback/listening-stats'
import { isFrequentListeningTrack } from './listening-history'
import { BEAT_THIS_MODELS, type BeatThisModelId } from '../../core/analysis/beat-this-models'
import { LruCache } from '../../core/util/lru-cache'
import {
  buildBeatTimeline,
  persistKnownBeatCheckpoint,
  protectBeatAudioSource,
  type BeatTimelineBuilder,
} from './beat-preanalysis'
import { continuousBeatCoverage, type BeatPlaybackState } from '../../core/analysis/beat-scheduling'
import {
  BEAT_DEBUG_INTERVAL_MS,
  type BeatDebugQueueItem,
  type BeatSchedulerDebug,
} from '../../core/analysis/beat-debug'

const TIMELINE_VERSION = 'rolling-v4'
const cachedTimelines = new LruCache<string, BeatTimeline>(3)
// Checkpoints live exactly as long as their small cached timeline; evicted songs
// cannot retain model/PCM allocations or an unbounded history of seam fragments.
const checkpoints = new WeakMap<BeatTimeline, BeatAnalysisCheckpoint>()
const INTRO_SECONDS = 20

export interface BeatPreanalysisOptions {
  resourcePressure?: Readonly<Ref<PlaybackResourcePressure>>
  track?: Ref<Track | null>
  source: Ref<string>
  debugEnabled?: Ref<boolean>
  mode?: Ref<BeatAnalysisMode>
  durationSeconds?: Ref<number>
  enabled?: Ref<boolean>
  /** Asset readiness gates new work independently of the user's visual preference. */
  modelAvailable?: Ref<boolean>
  /** Only an asset read error may retain already computed output for this source/mode. */
  preservePreviewOnUnavailable?: Ref<boolean>
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
  provisionalTimeline: BeatTimeline | null
  checkpoint?: BeatAnalysisCheckpoint
  listeners: Set<(playback: BeatPlaybackState) => void>
  yieldListeners: Set<() => void>
  yielding: boolean
}

interface SchedulingPause {
  foregroundFirst: boolean
  grant(): void
  cancel(): void
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
  const provisionalTimeline = shallowRef<BeatTimeline | null>(null)
  const cache = dependencies.cache ?? cachedTimelines
  const build = dependencies.build ?? buildBeatTimeline
  const jobRevision = shallowRef(0)
  const backgroundFailures = new Map<string, string>()
  const buildMetrics = new LruCache<string, BeatAnalysisMetrics>(3)
  const schedulingPauses = new Set<SchedulingPause>()
  let activePause: SchedulingPause | null = null
  let job: AnalysisJob | null = null
  let disposed = false
  let startedSource: string | null = null
  let lastPlayback = idlePlayback()
  let lastPriorityKey = ''
  let refilling = false
  let decision = '等待播放开始'
  const debugSnapshot = shallowRef<BeatSchedulerDebug | null>(null)
  watch(options.source, (source) => protectBeatAudioSource(source || null), {
    immediate: true,
    flush: 'sync',
  })
  onBeforeUnmount(() => protectBeatAudioSource(null))
  watch(
    () => {
      const track = options.track?.value
      return track && isFrequentListeningTrack(listeningTrackKey(track))
        ? listeningTrackKey(track)
        : null
    },
    (trackKey) => {
      if (!trackKey) return
      const saved = cache.get(cacheKey(options.source.value))
      const checkpoint = saved ? checkpoints.get(saved) : undefined
      if (checkpoint) persistKnownBeatCheckpoint(options.source.value, trackKey, checkpoint)
    },
    { flush: 'sync' },
  )

  function captureDebug(force = false): void {
    if (!options.debugEnabled?.value || disposed) return
    const now = performance.now()
    const previous = debugSnapshot.value
    if (
      !force &&
      previous &&
      previous.source === options.source.value &&
      previous.mode === (options.mode?.value ?? 'basic') &&
      previous.decision === decision &&
      previous.activeTask?.source === job?.source &&
      previous.activeTask?.phase === job?.status.phase &&
      now - previous.sampledAtMs < BEAT_DEBUG_INTERVAL_MS
    )
      return
    const state = playbackState()
    const limits = watermarks(timeline.value, state)
    const source = options.source.value
    const runnable =
      canAnalyse() &&
      (!schedulingPauses.size ||
        (!activePause && pauseNeedsForegroundBuffer(schedulingPauses.values().next().value))) &&
      startedSource === source &&
      (!options.getPlaybackState || state.playing) &&
      !state.seeking &&
      currentStatus.value.phase !== 'error'
    let order = 1
    const seen = new Set<string>()
    const entries = [
      {
        source,
        title: '当前歌曲',
        direction: 'current' as const,
        durationSeconds: options.durationSeconds?.value,
      },
      ...(options.adjacent?.value ?? [])
        .slice()
        .sort((a, b) => Number(b.direction === 'next') - Number(a.direction === 'next')),
    ]
    const queue: BeatDebugQueueItem[] = entries
      .filter((target) => target.source)
      .map((target) => {
        const key = cacheKey(target.source)
        const saved = cache.peek(key)
        const active = job?.key === key ? job : null
        const result =
          active?.timeline ?? (target.direction === 'current' ? timeline.value : saved) ?? null
        const checkpoint = active?.checkpoint ?? (saved ? checkpoints.get(saved) : undefined)
        const status =
          active?.status ??
          (target.direction === 'current'
            ? currentStatus.value
            : saved
              ? cachedStatus(saved)
              : idleStatus())
        const available = coverage(result, target.direction === 'current' ? state.timeSeconds : 0)
        let reason: string
        let priority: number | null = null
        if (seen.has(key)) reason = '与前面的歌曲重复，共用同一份分析'
        else if (active) {
          priority = 0
          reason = active.controller.signal.aborted
            ? '已取消，等待释放资源'
            : active.yielding
              ? '正在保存断点并让出资源'
              : '正在执行'
        } else if (!runnable) reason = decision
        else if (target.direction === 'current') {
          reason = refilling ? '当前歌曲低于水位，优先续建' : '当前缓冲充足，暂不继续分析'
          if (refilling) priority = order++
        } else if (options.preloadEnabled?.value === false) reason = '邻曲预分析已关闭'
        else if (!Number.isFinite(target.durationSeconds) || target.durationSeconds! <= 0)
          reason = '等待歌曲时长'
        else if (backgroundFailures.has(key)) reason = backgroundFailures.get(key)!
        else if (available + 0.01 >= Math.min(INTRO_SECONDS, target.durationSeconds!))
          reason = '开头缓冲已准备完成'
        else {
          priority = order++
          reason = refilling
            ? '等待当前歌曲补足缓冲'
            : target.direction === 'next'
              ? '下一首开头优先准备'
              : '下一首就绪后准备上一首开头'
        }
        seen.add(key)
        return {
          source: target.source,
          title: target.title,
          role: target.direction,
          order: priority,
          reason,
          phase: backgroundFailures.has(key) && !active ? 'error' : status.phase,
          progress: status.progress,
          continuousCoverageSeconds: available,
          targetBufferSeconds: target.direction === 'current' ? limits.high : INTRO_SECONDS,
          cached: !!saved,
          resumable: !!checkpoint,
          completedWindows: checkpoint?.completedWindows.length ?? 0,
          estimatedWorkMs: checkpoint?.estimatedWorkMs ?? 0,
          completedRanges: result ? rangesOf(result) : [],
        }
      })
    debugSnapshot.value = {
      sampledAtMs: now,
      source,
      mode: options.mode?.value ?? 'basic',
      playback: state,
      enabled: canAnalyse(),
      preloadEnabled: options.preloadEnabled?.value !== false,
      started: startedSource === source,
      refilling,
      decision,
      continuousCoverageSeconds: coverage(timeline.value, state.timeSeconds),
      lowWatermarkSeconds: limits.low,
      highWatermarkSeconds: limits.high,
      cacheEntries: cache.size,
      metrics: buildMetrics.peek(cacheKey(source)),
      activeTask: job
        ? {
            source: job.source,
            role:
              job.source === source
                ? 'current'
                : (targets().find((target) => target.source === job!.source)?.direction ??
                  'retiring'),
            phase: job.status.phase,
            progress: job.status.progress,
            activeRange: job.status.activeRange ? { ...job.status.activeRange } : undefined,
            yielding: job.yielding,
            aborted: job.controller.signal.aborted,
          }
        : null,
      queue,
    }
  }

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
    return (
      !disposed &&
      (options.enabled?.value ?? true) &&
      (options.modelAvailable?.value ?? true) &&
      !options.unavailableReason?.value
    )
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
    if (isLive(candidate) && isForeground(candidate)) {
      timeline.value = candidate.timeline
      provisionalTimeline.value = candidate.provisionalTimeline
      currentStatus.value = { ...candidate.status, playbackSeconds: playbackState().timeSeconds }
    }
    captureDebug()
  }

  function cancelJob(retainCurrent = false): void {
    if (!retainCurrent && job && isForeground(job)) provisionalTimeline.value = null
    if (job) job.provisionalTimeline = null
    job?.controller.abort()
    job?.listeners.clear()
    job?.yieldListeners.clear()
    jobRevision.value += 1
  }

  function yieldJob(candidate: AnalysisJob, retainCurrent = false): void {
    if (!isLive(candidate) || candidate.yielding) return
    candidate.yielding = true
    if (candidate.yieldListeners.size) {
      // Let an already running inference finish, checkpoint it, and hand back the
      // single resource slot. Cancelling a download/decode still settles first.
      for (const listener of candidate.yieldListeners) listener()
    } else cancelJob(retainCurrent)
  }

  function pauseNeedsForegroundBuffer(pause?: SchedulingPause): boolean {
    if (
      !pause?.foregroundFirst ||
      !canAnalyse() ||
      !options.source.value ||
      startedSource !== options.source.value ||
      currentStatus.value.phase === 'error'
    )
      return false
    const state = playbackState()
    // When live work cannot advance, a manual/rolling diagnostic must not wait
    // forever for a watermark that only normal playback can fill.
    if ((options.getPlaybackState && !state.playing) || state.seeking) return false
    const duration = timeline.value?.durationSeconds ?? options.durationSeconds?.value ?? 0
    if (!Number.isFinite(duration) || duration <= 0) return false
    const remaining = Math.max(0, duration - state.timeSeconds)
    return (
      coverage(timeline.value, state.timeSeconds) + 0.01 <
      Math.min(remaining, watermarks(timeline.value, state).high)
    )
  }

  /** Lease the worker/PCM slot without disabling already available highlights. */
  function acquirePause(
    signal: AbortSignal,
    pauseOptions: { foregroundFirst?: boolean } = {},
  ): Promise<() => void> {
    if (disposed || signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    return new Promise<() => void>((resolve, reject) => {
      let granted = false
      let released = false
      const release = (resume = true): void => {
        if (released) return
        released = true
        signal.removeEventListener('abort', abort)
        schedulingPauses.delete(request)
        if (activePause === request) activePause = null
        if (resume) reconcile()
      }
      const cancel = (resume: boolean): void => {
        if (granted || released) return
        release(resume)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const abort = (): void => cancel(true)
      const request: SchedulingPause = {
        foregroundFirst: pauseOptions.foregroundFirst === true,
        grant(): void {
          if (released || signal.aborted) {
            abort()
            return
          }
          granted = true
          activePause = request
          // Once granted, the owner releases only after its worker has settled.
          // Auto-releasing on abort could overlap its cleanup with a live refill.
          signal.removeEventListener('abort', abort)
          resolve(() => release())
        },
        cancel: () => cancel(false),
      }
      schedulingPauses.add(request)
      signal.addEventListener('abort', abort, { once: true })
      reconcile()
    })
  }

  function clearCurrent(): void {
    lastPriorityKey = ''
    refilling = false
    timeline.value = null
    provisionalTimeline.value = null
    currentStatus.value = idleStatus()
  }

  function begin(source: string, durationSeconds?: number): void {
    const key = cacheKey(source)
    const track = source === options.source.value ? options.track?.value : null
    const trackKey = track ? listeningTrackKey(track) : null
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
      provisionalTimeline: source === options.source.value ? provisionalTimeline.value : null,
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
            ...(trackKey
              ? { persistent: { trackKey, eligible: () => isFrequentListeningTrack(trackKey) } }
              : {}),
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
            onMetrics: (metrics) => {
              if (!isLive(candidate)) return
              buildMetrics.set(candidate.key, { ...metrics })
              captureDebug(true)
            },
            onPreview: (preview) => {
              if (!isLive(candidate) || !candidate.modelId) return
              const previous = candidate.provisionalTimeline
              const merged = previous
                ? snapshotBeatTimeline(previous)
                : createBeatTimelineBuffer(preview.durationSeconds, preview.stepSeconds)
              mergeBeatTimelineRange(merged, preview)
              candidate.provisionalTimeline = merged
              // This display-only result must never enter remember(), watermarks,
              // checkpoints or the formal scheduling/debug completed ranges.
              publish(candidate)
            },
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
    try {
      if (disposed) return
      if (options.resourcePressure?.value === 'buffering') {
        decision = '音频缓冲不足，保存断点并优先加载音乐'
        if (job) yieldJob(job, true)
        return
      }
      const waitingForForeground =
        !activePause && pauseNeedsForegroundBuffer(schedulingPauses.values().next().value)
      if (schedulingPauses.size && !waitingForForeground) {
        decision = job ? '正在保存断点，为曲线对比让出资源' : '曲线对比中，暂停新增预分析'
        if (job) yieldJob(job, true)
        else if (!activePause) schedulingPauses.values().next().value?.grant()
        return
      }
      if (options.unavailableReason?.value) {
        decision = options.unavailableReason.value
        currentStatus.value = {
          ...currentStatus.value,
          phase: 'error',
          activeRange: undefined,
          error: options.unavailableReason.value,
        }
        return
      }
      if (!canAnalyse()) {
        decision = '节拍分析已关闭'
        return
      }
      const source = options.source.value
      if (!source || startedSource !== source) {
        decision = '等待播放开始'
        return
      }
      if (currentStatus.value.phase === 'error') {
        decision = '构建失败，等待手动重试'
        return
      }
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
        decision = '播放已暂停，暂停新增分析任务'
        if (job) yieldJob(job)
        return
      }
      if (state.seeking) {
        decision = '正在定位播放位置，等待拖动稳定'
        if (job && !foregroundJob) yieldJob(job)
        return
      }
      if (options.resourcePressure?.value === 'constrained' && job && !foregroundJob) {
        decision = '暂缓邻曲分析，优先保持播放流畅'
        yieldJob(job, true)
        return
      }
      const duration = timeline.value?.durationSeconds ?? options.durationSeconds?.value ?? 0
      const remaining = Math.max(0, duration - state.timeSeconds)
      const available = coverage(timeline.value, state.timeSeconds)
      const limits = watermarks(timeline.value, state)
      const full = currentStatus.value.phase === 'ready'
      if (full || (timeline.value && available + 0.01 >= Math.min(remaining, limits.high)))
        refilling = false
      else if (
        waitingForForeground ||
        !timeline.value ||
        available + 0.01 < Math.min(remaining, limits.low)
      )
        refilling = true
      if (job) {
        decision = foregroundJob
          ? '优先构建当前歌曲缓冲'
          : refilling
            ? '邻曲任务让出资源，先补当前歌曲'
            : '当前缓冲充足，串行准备邻曲开头'
        if (!foregroundJob && refilling) yieldJob(job)
        return
      }
      if (refilling) {
        decision = '当前歌曲低于水位，优先续建'
        begin(source, options.durationSeconds?.value)
        return
      }
      if (options.resourcePressure?.value === 'constrained') {
        decision = '当前高亮缓冲充足，暂缓邻曲分析'
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
      if (next) {
        decision =
          next.direction === 'next'
            ? '当前缓冲充足，准备下一首开头'
            : '当前缓冲充足，准备上一首开头'
        begin(next.source, next.durationSeconds)
      } else decision = '所需缓冲已足够，等待播放推进'
    } finally {
      captureDebug()
    }
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
      for (const pause of [...schedulingPauses]) pause.cancel()
      clearCurrent()
      // Preserve a matching promoted neighbour through the source/play-event gap.
      if (job && job.key !== cacheKey(options.source.value)) cancelJob()
      reconcile()
    },
    { flush: 'sync' },
  )
  watch(
    () =>
      [
        options.enabled?.value,
        options.unavailableReason?.value,
        options.mode?.value,
        options.modelAvailable?.value,
      ] as const,
    (next, previous) => {
      const retainCurrent =
        next[0] !== false &&
        !!next[1] &&
        options.preservePreviewOnUnavailable?.value === true &&
        next[2] === previous?.[2]
      cancelJob(retainCurrent)
      backgroundFailures.clear()
      if (!retainCurrent) clearCurrent()
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
  watch(
    () => options.resourcePressure?.value,
    () => reconcile(),
    { flush: 'sync' },
  )
  onBeforeUnmount(() => {
    disposed = true
    for (const pause of [...schedulingPauses]) pause.cancel()
    debugSnapshot.value = null
    reset()
    backgroundFailures.clear()
  })

  watch(
    () => options.debugEnabled?.value,
    (enabled) => {
      if (enabled) captureDebug(true)
      else debugSnapshot.value = null
    },
    { flush: 'sync', immediate: true },
  )

  return {
    status,
    timeline,
    provisionalTimeline: shallowReadonly(provisionalTimeline),
    start,
    reset,
    retry,
    prioritize,
    acquirePause,
    debugSnapshot: readonly(debugSnapshot),
  }
}
