import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import type {
  BeatBuildStatus,
  BeatPreloadTarget,
  BeatTimeline,
} from '../core/analysis/beat-timeline'
import type { BeatPlaybackState } from '../core/analysis/beat-scheduling'
import type { BeatAnalysisCheckpoint } from '../core/analysis/beat-checkpoint'
import type { BeatAnalysisMode } from '../core/types'
import { LruCache } from '../core/util/lru-cache'
import type {
  BeatPreanalysisDependencies,
  BeatTimelineBuilder,
} from '../platform/web/beat-preanalysis'
import { useBeatPreanalysis } from '../platform/web/useBeatPreanalysis'

function timeline(durationSeconds = 120, coveredSeconds?: number): BeatTimeline {
  const size = Math.ceil(durationSeconds * 60) + 1
  return {
    durationSeconds,
    stepSeconds: 1 / 60,
    levels: [
      new Float32Array(size),
      new Float32Array(size),
      new Float32Array(size),
      new Float32Array(size),
    ],
    sustain: new Float32Array(size),
    ...(coveredSeconds === undefined
      ? {}
      : {
          builtUntilSeconds: coveredSeconds,
          completedRanges: [{ startSeconds: 0, endSeconds: coveredSeconds }],
        }),
  }
}

function target(
  direction: 'next' | 'previous',
  source: string,
  durationSeconds?: number,
): BeatPreloadTarget {
  return { direction, source, title: source, durationSeconds }
}

function checkpoint(
  result: BeatTimeline,
  completedWindows: number[],
  estimatedWorkMs = 0,
): BeatAnalysisCheckpoint {
  return {
    version: 1,
    signature: {
      sampleRate: 100,
      sampleCount: result.durationSeconds * 100,
      channels: 1,
      modelId: 'basic',
    },
    timeline: result,
    completedWindows,
    estimatedWorkMs,
  }
}

interface MockJob {
  source: string
  signal: AbortSignal
  dependencies: BeatPreanalysisDependencies
  status: (status: BeatBuildStatus) => void
  partial: (partial: BeatTimeline) => void
  complete: (result?: BeatTimeline) => void
  fail: (error: Error) => void
  holdCleanup: () => void
  releaseCleanup: () => void
}

const cleanup: Array<() => Promise<void>> = []

function harness(
  neighbors: readonly BeatPreloadTarget[] = [
    target('previous', '/previous.mp3', 90),
    target('next', '/next.mp3', 60),
  ],
) {
  const source = ref('/current.mp3')
  const adjacent = ref<readonly BeatPreloadTarget[]>(neighbors)
  const enabled = ref(true)
  const modelAvailable = ref(true)
  const preservePreviewOnUnavailable = ref(false)
  const unavailableReason = ref<string | null>(null)
  const preloadEnabled = ref(true)
  const debugEnabled = ref(false)
  const durationSeconds = ref(120)
  const mode = ref<BeatAnalysisMode>('basic')
  const playback = ref<BeatPlaybackState>({
    timeSeconds: 37,
    playing: true,
    playbackRate: 1,
    seeking: false,
  })
  const cache = new LruCache<string, BeatTimeline>(3)
  const jobs: MockJob[] = []
  let inFlight = 0
  let maximumInFlight = 0
  const build = vi.fn<BeatTimelineBuilder>((url, signal, onStatus, dependencies = {}) => {
    inFlight += 1
    maximumInFlight = Math.max(maximumInFlight, inFlight)
    let resolve!: (result: BeatTimeline) => void
    let reject!: (error: Error) => void
    let held = false
    let release!: () => void
    const pending = new Promise<BeatTimeline>((done, fail) => {
      resolve = done
      reject = fail
    })
    const cleanupGate = new Promise<void>((done) => {
      release = done
    })
    const abort = (): void => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    jobs.push({
      source: url,
      signal,
      dependencies,
      status: onStatus,
      partial: (partial) => dependencies.onPartial?.(partial),
      complete: (result = timeline(dependencies.durationSeconds ?? 120)) => resolve(result),
      fail: reject,
      holdCleanup: () => {
        held = true
      },
      releaseCleanup: release,
    })
    // Match the actual builder: abort rejects; cleanup may still own resources
    // until its promise settles. No second model/PCM job may start before then.
    return pending.finally(async () => {
      signal.removeEventListener('abort', abort)
      if (held) await cleanupGate
      inFlight -= 1
    })
  })
  let controller!: ReturnType<typeof useBeatPreanalysis>
  const wrapper: VueWrapper = mount(
    defineComponent({
      setup() {
        controller = useBeatPreanalysis(
          {
            source,
            adjacent,
            enabled,
            modelAvailable,
            preservePreviewOnUnavailable,
            unavailableReason,
            preloadEnabled,
            debugEnabled,
            durationSeconds,
            mode,
            getPlaybackState: () => playback.value,
          },
          { build, cache },
        )
        return () => h('div')
      },
    }),
  )
  cleanup.push(async () => {
    wrapper.unmount()
    for (const job of jobs) job.releaseCleanup()
    await flushPromises()
  })
  const startCurrent = async (): Promise<MockJob> => {
    controller.start()
    await flushPromises()
    return jobs.at(-1)!
  }
  const finishCurrent = async (): Promise<BeatTimeline> => {
    const current = await startCurrent()
    const result = timeline(durationSeconds.value)
    current.complete(result)
    await flushPromises()
    return result
  }
  return {
    source,
    adjacent,
    enabled,
    modelAvailable,
    preservePreviewOnUnavailable,
    unavailableReason,
    preloadEnabled,
    debugEnabled,
    durationSeconds,
    mode,
    playback,
    cache,
    jobs,
    build,
    controller,
    wrapper,
    startCurrent,
    finishCurrent,
    get maximumInFlight() {
      return maximumInFlight
    },
    get inFlight() {
      return inFlight
    },
  }
}

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

describe('manual beat comparison resource lease', () => {
  it('lets foreground refill reach its high watermark before granting a low-priority lease', async () => {
    const h = harness([])
    const current = await h.startCurrent()
    const yieldWorker = vi.fn()
    current.dependencies.subscribeYield?.(yieldWorker)
    const granted = vi.fn()
    const pending = h.controller
      .acquirePause(new AbortController().signal, { foregroundFirst: true })
      .then((release) => {
        granted()
        return release
      })
    await flushPromises()
    expect(yieldWorker).not.toHaveBeenCalled()
    expect(current.signal.aborted).toBe(false)
    current.complete(timeline(120, 50))
    await flushPromises()
    expect(granted).not.toHaveBeenCalled()
    expect(h.jobs).toHaveLength(2)
    h.jobs[1]!.complete(timeline(120, 100))
    const release = await pending
    expect(granted).toHaveBeenCalledTimes(1)
    expect(h.inFlight).toBe(0)
    expect(h.maximumInFlight).toBe(1)
    release()
  })

  it('does not starve a new foreground refill when comparison releases and immediately reacquires', async () => {
    const h = harness([])
    const current = await h.startCurrent()
    current.complete(timeline(120, 100))
    await flushPromises()
    const first = await h.controller.acquirePause(new AbortController().signal, {
      foregroundFirst: true,
    })
    h.playback.value = { ...h.playback.value, timeSeconds: 85 }
    h.controller.prioritize(85)
    first()
    const pending = h.controller.acquirePause(new AbortController().signal, {
      foregroundFirst: true,
    })
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    const refill = h.jobs[1]!
    const yieldWorker = vi.fn()
    refill.dependencies.subscribeYield?.(yieldWorker)
    h.controller.prioritize(85)
    expect(refill.signal.aborted).toBe(false)
    expect(yieldWorker).not.toHaveBeenCalled()
    refill.complete(timeline(120))
    const release = await pending
    expect(h.maximumInFlight).toBe(1)
    release()
  })

  it('fills to the high watermark even when ordinary playback is between refill thresholds', async () => {
    const h = harness([])
    const current = await h.startCurrent()
    current.complete(timeline(120, 100))
    await flushPromises()
    h.playback.value = { ...h.playback.value, timeSeconds: 60 }
    h.controller.prioritize(60)
    await flushPromises()
    expect(h.jobs).toHaveLength(1)
    const pending = h.controller.acquirePause(new AbortController().signal, {
      foregroundFirst: true,
    })
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    expect(h.jobs[1]!.signal.aborted).toBe(false)
    h.jobs[1]!.complete(timeline(120))
    const release = await pending
    release()
  })

  it.each(['paused', 'disabled', 'error', 'not-started', 'model-unavailable'] as const)(
    'does not wait forever for foreground buffer when live analysis is %s',
    async (condition) => {
      const h = harness([])
      if (condition !== 'not-started') {
        const current = await h.startCurrent()
        if (condition === 'paused') {
          h.playback.value = { ...h.playback.value, playing: false }
          h.controller.prioritize(h.playback.value.timeSeconds)
        } else if (condition === 'disabled') h.enabled.value = false
        else if (condition === 'model-unavailable') h.modelAvailable.value = false
        else current.fail(new Error('正式分析失败'))
        await flushPromises()
      }
      const release = await h.controller.acquirePause(new AbortController().signal, {
        foregroundFirst: true,
      })
      expect(h.inFlight).toBe(0)
      release()
      await flushPromises()
      expect(h.inFlight).toBe(0)
    },
  )

  it('cancels a queued low-priority lease without aborting its foreground refill', async () => {
    const h = harness([])
    const current = await h.startCurrent()
    const controller = new AbortController()
    const pending = h.controller.acquirePause(controller.signal, { foregroundFirst: true })
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    expect(current.signal.aborted).toBe(false)
    expect(h.inFlight).toBe(1)
    current.complete()
    await flushPromises()
    expect(h.jobs).toHaveLength(1)
  })

  it('yields the running worker and waits for its cleanup while preserving highlights and checkpoints', async () => {
    const h = harness([])
    h.mode.value = 'beat-this-small'
    const current = await h.startCurrent()
    const partial = timeline(120, 45)
    const saved = checkpoint(partial, [0])
    const preview = timeline(120, 60)
    current.dependencies.onCheckpoint?.(saved)
    current.partial(partial)
    current.dependencies.onPreview?.(preview)
    const yieldWorker = vi.fn()
    current.dependencies.subscribeYield?.(yieldWorker)
    current.holdCleanup()
    const signal = new AbortController()
    const granted = vi.fn()
    const pending = h.controller.acquirePause(signal.signal).then((release) => {
      granted()
      return release
    })
    h.controller.prioritize(40)
    expect(yieldWorker).toHaveBeenCalledTimes(1)
    expect(current.signal.aborted).toBe(false)
    expect(h.controller.timeline.value).toBe(partial)
    expect(h.controller.provisionalTimeline.value?.builtUntilSeconds).toBe(60)
    current.complete(partial)
    await flushPromises()
    expect(granted).not.toHaveBeenCalled()
    expect(h.inFlight).toBe(1)
    current.releaseCleanup()
    const release = await pending
    expect(h.inFlight).toBe(0)
    h.controller.start()
    h.controller.prioritize(40)
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
    expect(h.controller.timeline.value).toBe(partial)
    expect(h.controller.provisionalTimeline.value?.builtUntilSeconds).toBe(60)
    release()
    release()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(2)
    expect(h.jobs[1]!.dependencies.checkpoint?.completedWindows).toEqual([0])
    expect(h.maximumInFlight).toBe(1)
  })

  it('retains a published preview when yielding before worker subscription cancels preparation', async () => {
    const h = harness([])
    h.mode.value = 'beat-this-small'
    const current = await h.startCurrent()
    current.dependencies.onPreview?.(timeline(120, 60))
    const release = await h.controller.acquirePause(new AbortController().signal)
    expect(current.signal.aborted).toBe(true)
    expect(h.controller.provisionalTimeline.value?.builtUntilSeconds).toBe(60)
    expect(h.inFlight).toBe(0)
    release()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(2)
    expect(h.controller.provisionalTimeline.value?.builtUntilSeconds).toBe(60)
  })

  it('cancels a waiting lease without unlocking the still-retiring live worker', async () => {
    const h = harness([])
    const current = await h.startCurrent()
    current.holdCleanup()
    const abort = new AbortController()
    const pending = h.controller.acquirePause(abort.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    abort.abort()
    await rejected
    h.controller.start()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
    expect(h.inFlight).toBe(1)
    current.releaseCleanup()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(2)
    expect(h.maximumInFlight).toBe(1)
  })

  it('keeps a granted lease until its owner finishes cleanup even after cancellation', async () => {
    const h = harness([])
    const abort = new AbortController()
    const release = await h.controller.acquirePause(abort.signal)
    h.controller.start()
    abort.abort()
    await flushPromises()
    expect(h.build).not.toHaveBeenCalled()
    release()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
  })

  it('grants simultaneous requests serially without allowing live work between them', async () => {
    const h = harness([])
    const releaseFirst = await h.controller.acquirePause(new AbortController().signal)
    const secondGranted = vi.fn()
    const second = h.controller.acquirePause(new AbortController().signal).then((release) => {
      secondGranted()
      return release
    })
    h.controller.start()
    await flushPromises()
    expect(secondGranted).not.toHaveBeenCalled()
    releaseFirst()
    const releaseSecond = await second
    expect(h.build).not.toHaveBeenCalled()
    releaseSecond()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
  })

  it('rejects all pending leases on source changes and waits for old resource cleanup', async () => {
    const h = harness([])
    const current = await h.startCurrent()
    current.holdCleanup()
    const first = h.controller.acquirePause(new AbortController().signal)
    const second = h.controller.acquirePause(new AbortController().signal)
    const rejected = Promise.all([
      expect(first).rejects.toMatchObject({ name: 'AbortError' }),
      expect(second).rejects.toMatchObject({ name: 'AbortError' }),
    ])
    h.source.value = '/replacement.mp3'
    h.controller.start()
    await rejected
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
    current.releaseCleanup()
    await flushPromises()
    expect(h.jobs[1]?.source).toBe('/replacement.mp3')
    expect(h.maximumInFlight).toBe(1)
  })

  it('rejects pending and future requests after disposal without restarting work', async () => {
    const h = harness([])
    const current = await h.startCurrent()
    current.holdCleanup()
    const waiting = h.controller.acquirePause(new AbortController().signal)
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    h.wrapper.unmount()
    await rejected
    current.releaseCleanup()
    await flushPromises()
    await expect(h.controller.acquirePause(new AbortController().signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(h.build).toHaveBeenCalledTimes(1)
    expect(h.inFlight).toBe(0)
  })
})

describe('adjacent beat preanalysis scheduling and promotion', () => {
  it('retains known output on an asset read error while user disable and model removal still clear it', async () => {
    const h = harness([])
    h.mode.value = 'beat-this-small'
    const current = await h.startCurrent()
    current.dependencies.onPreview?.(timeline(120, 30))
    // Set the asset-error retention policy before publishing its reason, matching
    // computed values that derive from the same model status object.
    h.preservePreviewOnUnavailable.value = true
    h.unavailableReason.value = '模型缓存无法读取'
    h.modelAvailable.value = false
    expect(h.controller.provisionalTimeline.value?.builtUntilSeconds).toBe(30)
    expect(h.controller.status.value.phase).toBe('error')
    await flushPromises()
    const count = h.jobs.length
    h.controller.prioritize(10)
    await flushPromises()
    expect(h.jobs).toHaveLength(count)
    h.enabled.value = false
    expect(h.controller.provisionalTimeline.value).toBeNull()
    expect(h.controller.timeline.value).toBeNull()
    h.enabled.value = true
    h.preservePreviewOnUnavailable.value = false
    h.unavailableReason.value = '请下载模型'
    expect(h.controller.provisionalTimeline.value).toBeNull()
  })

  it('keeps provisional basic coverage separate from model watermarks and caches until verified results arrive', async () => {
    const h = harness([])
    h.mode.value = 'beat-this-small'
    const current = await h.startCurrent()
    const preview = timeline(120, 60)
    preview.levels[0][60] = 0.7
    current.dependencies.onPreview?.(preview)
    expect(h.controller.provisionalTimeline.value?.levels[0][60]).toBeCloseTo(0.7)
    expect(h.controller.timeline.value).toBeNull()
    expect(h.controller.status.value.phase).toBe('fetching')
    expect(h.cache.size).toBe(0)
    expect(current.dependencies.getBufferSeconds?.()).toBe(60)
    expect(h.jobs).toHaveLength(1)
    const verified = timeline(120, 24)
    current.dependencies.onCheckpoint?.(checkpoint(verified, [0]))
    current.partial(verified)
    expect(h.controller.timeline.value).toBe(verified)
    expect(h.controller.provisionalTimeline.value?.completedRanges).toEqual(preview.completedRanges)
    expect(h.controller.status.value.availableSeconds).toBe(24)
    expect(h.cache.size).toBe(1)
  })

  it('preserves usable previews after a model failure but clears them on source, mode, retry and cancellation', async () => {
    const h = harness([])
    h.mode.value = 'beat-this-small'
    const current = await h.startCurrent()
    current.dependencies.onPreview?.(timeline(120, 30))
    current.fail(new Error('模型推理失败'))
    await flushPromises()
    expect(h.controller.status.value.phase).toBe('error')
    expect(h.controller.provisionalTimeline.value?.builtUntilSeconds).toBe(30)
    expect(h.controller.timeline.value).toBeNull()
    expect(h.cache.size).toBe(0)
    expect(h.jobs).toHaveLength(1)
    h.controller.retry()
    expect(h.controller.provisionalTimeline.value).toBeNull()
    await flushPromises()
    const retried = h.jobs.at(-1)!
    retried.dependencies.onPreview?.(timeline(120, 35))
    h.source.value = '/another.mp3'
    expect(h.controller.provisionalTimeline.value).toBeNull()
    retried.dependencies.onPreview?.(timeline(120, 60))
    expect(h.controller.provisionalTimeline.value).toBeNull()
    await flushPromises()
    const next = await h.startCurrent()
    next.dependencies.onPreview?.(timeline(120, 25))
    h.mode.value = 'basic'
    expect(h.controller.provisionalTimeline.value).toBeNull()
    next.dependencies.onPreview?.(timeline(120, 60))
    expect(h.controller.provisionalTimeline.value).toBeNull()
  })

  it('keeps background previews invisible until the exact in-flight neighbor is promoted', async () => {
    const h = harness()
    h.mode.value = 'beat-this-small'
    await h.finishCurrent()
    const neighbor = h.jobs.at(-1)!
    expect(neighbor.source).toBe('/next.mp3')
    neighbor.dependencies.onPreview?.(timeline(60, 25))
    expect(h.controller.provisionalTimeline.value).toBeNull()
    h.source.value = neighbor.source
    expect(h.controller.provisionalTimeline.value).toBeNull()
    h.controller.start()
    expect(h.controller.provisionalTimeline.value?.durationSeconds).toBe(60)
    expect(h.controller.provisionalTimeline.value?.builtUntilSeconds).toBe(25)
    expect(h.controller.timeline.value).toBeNull()
    h.controller.reset()
    expect(h.controller.provisionalTimeline.value).toBeNull()
    neighbor.dependencies.onPreview?.(timeline(60, 50))
    expect(h.controller.provisionalTimeline.value).toBeNull()
  })

  it('observes live scheduling and checkpoint watermarks without changing LRU or starting work', async () => {
    const h = harness()
    h.playback.value.timeSeconds = 0
    const first = await h.startCurrent()
    expect(h.controller.debugSnapshot.value).toBeNull()
    const buffer = timeline(120, 60)
    const saved = checkpoint(buffer, [0, 1, 2, 3, 4, 5], 8000)
    first.dependencies.onCheckpoint!(saved)
    first.partial(buffer)
    const read = vi.spyOn(h.cache, 'get')
    const writes = vi.spyOn(h.cache, 'set')
    const buildCount = h.build.mock.calls.length
    h.debugEnabled.value = true
    const snapshot = h.controller.debugSnapshot.value!
    expect(snapshot.activeTask).toMatchObject({
      source: '/current.mp3',
      role: 'current',
      phase: 'analysing',
    })
    expect(snapshot).toMatchObject({
      continuousCoverageSeconds: 60,
      lowWatermarkSeconds: 20,
      highWatermarkSeconds: 60,
    })
    expect(snapshot.queue[0]).toMatchObject({
      cached: true,
      resumable: true,
      completedWindows: 6,
      estimatedWorkMs: 8000,
      order: 0,
    })
    expect(snapshot.queue.map((entry) => [entry.role, entry.order])).toEqual([
      ['current', 0],
      ['next', 1],
      ['previous', 2],
    ])
    for (let index = 0; index < 20; index++) void h.controller.debugSnapshot.value
    expect(read).not.toHaveBeenCalled()
    expect(writes).not.toHaveBeenCalled()
    expect(h.build).toHaveBeenCalledTimes(buildCount)
    h.debugEnabled.value = false
    expect(h.controller.debugSnapshot.value).toBeNull()
    first.complete(buffer)
    await flushPromises()
    expect(h.jobs[1]!.source).toBe('/next.mp3')
    expect(h.controller.debugSnapshot.value).toBeNull()
    h.debugEnabled.value = true
    expect(h.controller.debugSnapshot.value!.activeTask?.role).toBe('next')
  })

  it('reports real metadata and failed-neighbor exclusions while preserving the execution order', async () => {
    const h = harness([target('next', '/next.mp3'), target('previous', '/previous.mp3', 90)])
    h.debugEnabled.value = true
    await h.finishCurrent()
    expect(h.jobs[1]!.source).toBe('/previous.mp3')
    let snapshot = h.controller.debugSnapshot.value!
    expect(snapshot.queue.find((entry) => entry.role === 'next')).toMatchObject({
      order: null,
      reason: '等待歌曲时长',
    })
    expect(snapshot.activeTask?.role).toBe('previous')
    h.jobs[1]!.fail(new Error('邻曲分析失败'))
    await flushPromises()
    snapshot = h.controller.debugSnapshot.value!
    expect(snapshot.queue.find((entry) => entry.role === 'previous')).toMatchObject({
      order: null,
      phase: 'error',
      reason: '邻曲分析失败',
    })
    expect(snapshot.activeTask).toBeNull()
    expect(h.build).toHaveBeenCalledTimes(2)
  })

  it('records pause and seek holds, clearing stale task identity on source changes', async () => {
    const h = harness([])
    h.debugEnabled.value = true
    const first = await h.startCurrent()
    const yielded = vi.fn()
    first.dependencies.subscribeYield!(yielded)
    h.playback.value = { ...h.playback.value, playing: false }
    h.controller.prioritize(37, h.playback.value)
    expect(yielded).toHaveBeenCalledTimes(1)
    expect(h.controller.debugSnapshot.value?.decision).toContain('播放已暂停')
    expect(h.controller.debugSnapshot.value?.activeTask?.yielding).toBe(true)
    h.playback.value = { ...h.playback.value, playing: true, seeking: true, timeSeconds: 80 }
    h.controller.prioritize(80, h.playback.value)
    expect(h.controller.debugSnapshot.value?.decision).toContain('等待拖动稳定')
    expect(h.controller.debugSnapshot.value?.playback.timeSeconds).toBe(80)
    h.source.value = '/changed-debug.mp3'
    expect(h.controller.debugSnapshot.value?.source).toBe('/changed-debug.mp3')
    expect(h.controller.debugSnapshot.value?.activeTask?.role).toBe('retiring')
    expect(h.controller.debugSnapshot.value?.continuousCoverageSeconds).toBe(0)
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
  })

  it('fills a bounded current buffer, prepares only neighbor intros, and wakes below the low watermark', async () => {
    const h = harness()
    h.playback.value.timeSeconds = 0
    const first = await h.startCurrent()
    expect(first.dependencies.getBufferSeconds!()).toBe(60)
    expect(first.dependencies.maxWindows).toBe(3)
    const firstBuffer = timeline(120, 30)
    const firstCheckpoint = checkpoint(firstBuffer, [0, 1, 2])
    first.dependencies.onCheckpoint!(firstCheckpoint)
    first.complete(firstBuffer)
    await flushPromises()
    expect(h.jobs.map((job) => job.source)).toEqual(['/current.mp3', '/current.mp3'])
    expect(h.jobs[1]!.dependencies.checkpoint).toEqual(firstCheckpoint)
    const currentBuffer = timeline(120, 60)
    const currentCheckpoint = checkpoint(currentBuffer, [0, 1, 2, 3, 4, 5])
    h.jobs[1]!.dependencies.onCheckpoint!(currentCheckpoint)
    h.jobs[1]!.complete(currentBuffer)
    await flushPromises()
    expect(h.controller.status.value).toMatchObject({
      phase: 'buffered',
      progress: 0.5,
      availableSeconds: 60,
    })
    for (const [source, duration] of [
      ['/next.mp3', 60],
      ['/previous.mp3', 90],
    ] as const) {
      for (const covered of [10, 20]) {
        const neighbor = h.jobs.at(-1)!
        expect(neighbor.source).toBe(source)
        expect(neighbor.dependencies.getBufferSeconds!()).toBe(20)
        expect(neighbor.dependencies.maxWindows).toBe(1)
        const result = timeline(duration, covered)
        neighbor.dependencies.onCheckpoint!(checkpoint(result, covered === 10 ? [0] : [0, 1]))
        neighbor.complete(result)
        await flushPromises()
      }
    }
    expect(h.jobs).toHaveLength(6)
    expect(h.inFlight).toBe(0)
    expect(h.maximumInFlight).toBe(1)
    expect(h.cache.size).toBe(3)
    expect(
      h.controller.status.value.adjacent?.every(
        (entry) => entry.phase === 'buffered' && entry.availableSeconds === 20,
      ),
    ).toBe(true)
    h.playback.value.timeSeconds = 39
    h.controller.prioritize(39, h.playback.value)
    await flushPromises()
    expect(h.jobs).toHaveLength(6)
    h.playback.value.timeSeconds = 41
    h.controller.prioritize(41, h.playback.value)
    await flushPromises()
    expect(h.jobs).toHaveLength(7)
    expect(h.jobs[6]!.source).toBe('/current.mp3')
    expect(h.jobs[6]!.dependencies.checkpoint).toEqual(currentCheckpoint)
    expect(h.controller.timeline.value).toBe(currentBuffer)
  })

  it('uses hysteresis until the high watermark instead of stopping after a barely sufficient first batch', async () => {
    const h = harness([])
    h.playback.value.timeSeconds = 0
    const first = await h.startCurrent()
    const partial = timeline(120, 30)
    first.dependencies.onCheckpoint!(checkpoint(partial, [0, 1, 2]))
    first.complete(partial)
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    expect(h.jobs[1]!.dependencies.getBufferSeconds!()).toBe(60)
    const sufficient = timeline(120, 60)
    h.jobs[1]!.dependencies.onCheckpoint!(checkpoint(sufficient, [0, 1, 2, 3, 4, 5]))
    h.jobs[1]!.complete(sufficient)
    await flushPromises()
    for (const time of [1, 10, 20, 30, 39]) {
      h.playback.value.timeSeconds = time
      h.controller.prioritize(time, h.playback.value)
    }
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    expect(h.controller.status.value.phase).toBe('buffered')
  })

  it('yields a background batch for a current hole and waits for its cleanup before resuming current work', async () => {
    const h = harness([target('next', '/next.mp3', 60)])
    h.playback.value.timeSeconds = 0
    const current = await h.startCurrent()
    const saved = timeline(120, 60)
    const savedCheckpoint = checkpoint(saved, [0, 1, 2, 3, 4, 5])
    current.dependencies.onCheckpoint!(savedCheckpoint)
    current.complete(saved)
    await flushPromises()
    const next = h.jobs[1]!
    const yieldRequested = vi.fn()
    next.dependencies.subscribeYield!(yieldRequested)
    next.holdCleanup()
    h.playback.value.timeSeconds = 95
    h.controller.prioritize(95, h.playback.value)
    expect(yieldRequested).toHaveBeenCalledTimes(1)
    expect(next.signal.aborted).toBe(false)
    const intro = timeline(60, 10)
    next.dependencies.onCheckpoint!(checkpoint(intro, [0]))
    next.complete(intro)
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    next.releaseCleanup()
    await flushPromises()
    expect(h.jobs).toHaveLength(3)
    expect(h.jobs[2]!.source).toBe('/current.mp3')
    expect(h.jobs[2]!.dependencies.getPrioritySeconds!()).toBe(95)
    expect(h.jobs[2]!.dependencies.checkpoint).toEqual(savedCheckpoint)
    expect(h.controller.status.value.adjacent?.[0]).toMatchObject({
      phase: 'buffered',
      availableSeconds: 10,
    })
    expect(h.maximumInFlight).toBe(1)
  })

  it('does not start work while paused and retains finished windows when pausing a live batch', async () => {
    const h = harness([])
    h.playback.value = { timeSeconds: 0, playing: false, playbackRate: 1, seeking: false }
    h.controller.start()
    await flushPromises()
    expect(h.jobs).toHaveLength(0)
    h.playback.value.playing = true
    h.controller.prioritize(0, h.playback.value)
    await flushPromises()
    const first = h.jobs[0]!
    const yieldRequested = vi.fn()
    first.dependencies.subscribeYield!(yieldRequested)
    const saved = timeline(120, 30)
    const savedCheckpoint = checkpoint(saved, [0, 1, 2])
    first.dependencies.onCheckpoint!(savedCheckpoint)
    first.partial(saved)
    h.playback.value.playing = false
    h.controller.prioritize(0, h.playback.value)
    expect(yieldRequested).toHaveBeenCalledTimes(1)
    expect(first.signal.aborted).toBe(false)
    first.complete(saved)
    await flushPromises()
    expect(h.jobs).toHaveLength(1)
    expect(h.controller.timeline.value).toBe(saved)
    expect(h.controller.status.value.phase).toBe('buffered')
    h.playback.value = { ...h.playback.value, playing: true, timeSeconds: 20 }
    h.controller.prioritize(20, h.playback.value)
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    expect(h.jobs[1]!.dependencies.checkpoint).toEqual(savedCheckpoint)
  })

  it('keeps only validated checkpoints when switching away after an unfinished window snapshot', async () => {
    const h = harness([])
    h.playback.value.timeSeconds = 0
    const first = await h.startCurrent()
    const safe = timeline(120, 30)
    const safeCheckpoint = checkpoint(safe, [0, 1, 2])
    first.dependencies.onCheckpoint!(safeCheckpoint)
    const transient = timeline(120, 35)
    first.partial(transient)
    expect(h.controller.timeline.value).toBe(transient)
    h.source.value = '/chosen.mp3'
    h.adjacent.value = [target('previous', '/current.mp3', 120)]
    h.controller.start()
    await flushPromises()
    h.jobs[1]!.complete()
    await flushPromises()
    h.source.value = '/current.mp3'
    h.adjacent.value = []
    h.controller.start()
    await flushPromises()
    expect(h.controller.timeline.value).toBe(safe)
    expect(h.controller.status.value).toMatchObject({ phase: 'buffered', availableSeconds: 30 })
    h.playback.value.timeSeconds = 25
    h.controller.prioritize(25, h.playback.value)
    await flushPromises()
    expect(h.jobs.at(-1)!.dependencies.checkpoint).toEqual(safeCheckpoint)
    expect(h.maximumInFlight).toBe(1)
  })

  it('adjusts bounded watermarks for playback rate and measured work while keeping short songs complete', async () => {
    const h = harness([])
    h.playback.value = { timeSeconds: 0, playing: true, playbackRate: 2, seeking: false }
    const first = await h.startCurrent()
    expect(first.dependencies.getBufferSeconds!()).toBe(120)
    const saved = timeline(120, 60)
    first.dependencies.onCheckpoint!(checkpoint(saved, [0, 1, 2, 3, 4, 5], 40_000))
    first.partial(saved)
    expect(first.dependencies.getBufferSeconds!()).toBeLessThanOrEqual(120)
    first.complete()
    await flushPromises()
    expect(h.controller.status.value.phase).toBe('ready')
    h.source.value = '/short.mp3'
    h.durationSeconds.value = 8
    h.playback.value.playbackRate = 1
    h.controller.start()
    await flushPromises()
    h.jobs.at(-1)!.complete(timeline(8))
    await flushPromises()
    expect(h.controller.status.value).toMatchObject({
      phase: 'ready',
      progress: 1,
      availableSeconds: 8,
    })
    expect(h.inFlight).toBe(0)
  })

  it('raises the low watermark after expensive windows instead of waiting until only twenty seconds remain', async () => {
    const h = harness([])
    h.durationSeconds.value = 300
    h.playback.value.timeSeconds = 0
    const current = await h.startCurrent()
    const saved = timeline(300, 90)
    current.dependencies.onCheckpoint!(checkpoint(saved, [0, 1, 2, 3, 4, 5, 6, 7, 8], 30_000))
    current.complete(saved)
    await flushPromises()
    expect(h.inFlight).toBe(0)
    h.playback.value.timeSeconds = 39
    h.controller.prioritize(39, h.playback.value)
    await flushPromises()
    expect(h.jobs).toHaveLength(1)
    h.playback.value.timeSeconds = 41
    h.controller.prioritize(41, h.playback.value)
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    expect(h.jobs[1]!.dependencies.getBufferSeconds!()).toBe(70)
    expect(h.jobs[1]!.dependencies.maxWindows).toBe(3)
  })

  it('promotes a parked neighbor intro and resumes its checkpoint using the foreground budget', async () => {
    const h = harness([target('next', '/next.mp3', 60)])
    await h.finishCurrent()
    const intro = timeline(60, 20)
    const saved = checkpoint(intro, [0, 1])
    h.jobs[1]!.dependencies.onCheckpoint!(saved)
    h.jobs[1]!.complete(intro)
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    expect(h.inFlight).toBe(0)
    h.source.value = '/next.mp3'
    h.durationSeconds.value = 60
    h.playback.value.timeSeconds = 5
    h.adjacent.value = []
    h.controller.start()
    await flushPromises()
    expect(h.controller.timeline.value).toBe(intro)
    expect(h.jobs).toHaveLength(3)
    expect(h.jobs[2]!.source).toBe('/next.mp3')
    expect(h.jobs[2]!.dependencies.checkpoint).toEqual(saved)
    expect(h.jobs[2]!.dependencies.maxWindows).toBe(3)
    expect(h.jobs[2]!.dependencies.getPrioritySeconds!()).toBe(5)
    expect(h.maximumInFlight).toBe(1)
  })

  it('bounds parked partials to three songs and resumes retained checkpoints after switching back', async () => {
    const h = harness([])
    h.playback.value.timeSeconds = 0
    const results: BeatTimeline[] = []
    for (let index = 0; index < 4; index += 1) {
      h.source.value = `/partial-${index}.mp3`
      const current = await h.startCurrent()
      const result = timeline(120, 60)
      current.dependencies.onCheckpoint!(checkpoint(result, [0, 1, 2, 3, 4, 5]))
      current.complete(result)
      results.push(result)
      await flushPromises()
    }
    expect(h.cache.size).toBe(3)
    h.source.value = '/partial-1.mp3'
    h.controller.start()
    await flushPromises()
    expect(h.controller.timeline.value).toBe(results[1])
    expect(h.controller.status.value.phase).toBe('buffered')
    expect(h.jobs).toHaveLength(4)
    h.playback.value.timeSeconds = 50
    h.controller.prioritize(50, h.playback.value)
    await flushPromises()
    expect(h.jobs[4]!.dependencies.checkpoint?.timeline).toBe(results[1])
    h.source.value = '/partial-0.mp3'
    h.playback.value.timeSeconds = 0
    h.controller.start()
    await flushPromises()
    expect(h.jobs[5]!.dependencies.checkpoint).toBeUndefined()
    expect(h.maximumInFlight).toBe(1)
  })

  it('keeps fully completed results separate while serial neighbor jobs report their own progress', async () => {
    const h = harness()
    await flushPromises()
    expect(h.jobs).toHaveLength(0)
    const current = await h.startCurrent()
    current.partial(timeline(120, 60))
    current.status({ phase: 'analysing', progress: 0.5, error: null, availableSeconds: 60 })
    await flushPromises()
    expect(h.jobs.map((job) => job.source)).toEqual(['/current.mp3'])
    const currentResult = timeline()
    current.complete(currentResult)
    await flushPromises()
    expect(h.jobs.map((job) => job.source)).toEqual(['/current.mp3', '/next.mp3'])
    const next = h.jobs[1]!
    next.status({ phase: 'decoding', progress: 0, error: null })
    next.partial(timeline(60, 24))
    next.status({
      phase: 'analysing',
      progress: 0.4,
      error: null,
      availableSeconds: 24,
      durationSeconds: 60,
    })
    expect(h.controller.timeline.value).toBe(currentResult)
    expect(h.controller.status.value).toMatchObject({ phase: 'ready', progress: 1, error: null })
    expect(
      h.controller.status.value.adjacent?.find((item) => item.source === '/next.mp3'),
    ).toMatchObject({
      phase: 'analysing',
      progress: 0.4,
      availableSeconds: 24,
      durationSeconds: 60,
    })
    next.complete()
    await flushPromises()
    expect(h.jobs.map((job) => job.source)).toEqual(['/current.mp3', '/next.mp3', '/previous.mp3'])
    h.jobs[2]!.complete()
    await flushPromises()
    expect(h.maximumInFlight).toBe(1)
    expect(h.inFlight).toBe(0)
    expect(h.cache.size).toBe(3)
    expect(h.controller.timeline.value).toBe(currentResult)
    expect(h.controller.status.value.adjacent?.every((item) => item.phase === 'ready')).toBe(true)
  })

  it('waits for neighbor metadata while allowing another known-duration neighbor to build', async () => {
    const h = harness([target('next', '/next.mp3'), target('previous', '/previous.mp3', 90)])
    await h.finishCurrent()
    expect(h.jobs.map((job) => job.source)).toEqual(['/current.mp3', '/previous.mp3'])
    h.jobs[1]!.complete()
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    h.adjacent.value = [target('next', '/next.mp3', 60), target('previous', '/previous.mp3', 90)]
    await flushPromises()
    expect(h.jobs.map((job) => job.source)).toEqual(['/current.mp3', '/previous.mp3', '/next.mp3'])
    expect(h.jobs[2]!.dependencies.durationSeconds).toBe(60)
    expect(h.maximumInFlight).toBe(1)
  })

  it('keeps the still-relevant previous song cached when a new next song replaces an obsolete neighbor', async () => {
    const h = harness([target('next', '/b.mp3', 60), target('previous', '/c.mp3', 90)])
    h.source.value = '/a.mp3'
    const a = await h.finishCurrent()
    h.jobs[1]!.complete()
    await flushPromises()
    h.jobs[2]!.complete()
    await flushPromises()
    expect(h.jobs.map((job) => job.source)).toEqual(['/a.mp3', '/b.mp3', '/c.mp3'])
    expect(h.cache.size).toBe(3)

    h.source.value = '/b.mp3'
    h.durationSeconds.value = 60
    h.adjacent.value = [target('next', '/d.mp3', 75), target('previous', '/a.mp3', 120)]
    h.controller.start()
    await flushPromises()
    expect(h.jobs[3]!.source).toBe('/d.mp3')
    h.jobs[3]!.complete()
    await flushPromises()

    expect(h.jobs.map((job) => job.source)).toEqual(['/a.mp3', '/b.mp3', '/c.mp3', '/d.mp3'])
    expect(
      h.controller.status.value.adjacent?.find((item) => item.direction === 'previous'),
    ).toMatchObject({
      source: '/a.mp3',
      phase: 'ready',
    })
    expect(h.cache.size).toBe(3)
    h.source.value = '/a.mp3'
    h.adjacent.value = []
    h.controller.start()
    await flushPromises()
    expect(h.controller.timeline.value).toBe(a)
    expect(h.jobs).toHaveLength(4)
    expect(h.maximumInFlight).toBe(1)
  })

  it.each(['loading-model', 'fetching', 'decoding', 'analysing'] as const)(
    'promotes a neighbor during %s without rebuilding, losing partials or disconnecting priority updates',
    async (phase) => {
      const h = harness([target('next', '/next.mp3', 60)])
      const currentResult = await h.finishCurrent()
      const next = h.jobs[1]!
      next.status({ phase, progress: 0.3, error: null })
      const partial = timeline(60, 24)
      if (phase === 'analysing') next.partial(partial)
      const receive = vi.fn()
      const unsubscribe = next.dependencies.subscribePriority!(receive)
      expect(next.dependencies.getPlaybackState!()).toEqual({
        timeSeconds: 0,
        playing: false,
        playbackRate: 1,
        seeking: false,
      })
      h.controller.prioritize(50, {
        timeSeconds: 50,
        playing: true,
        playbackRate: 2,
        seeking: false,
      })
      expect(receive).not.toHaveBeenCalled()
      expect(h.controller.timeline.value).toBe(currentResult)
      h.playback.value = { timeSeconds: 5, playing: true, playbackRate: 1.5, seeking: false }
      h.durationSeconds.value = 60
      h.source.value = '/next.mp3'
      h.controller.start()
      await flushPromises()
      expect(next.signal.aborted).toBe(false)
      expect(h.jobs).toHaveLength(2)
      expect(h.controller.status.value).toMatchObject({
        phase,
        progress: phase === 'analysing' ? 0.4 : 0.3,
      })
      if (phase === 'analysing') expect(h.controller.timeline.value).toBe(partial)
      expect(next.dependencies.getPlaybackState!()).toEqual(h.playback.value)
      receive.mockClear()
      const state = { timeSeconds: 17, playing: true, playbackRate: 2, seeking: true }
      h.controller.prioritize(17, state)
      expect(receive).toHaveBeenLastCalledWith(state)
      unsubscribe()
      const complete = timeline(60)
      next.complete(complete)
      await flushPromises()
      expect(h.controller.timeline.value).toBe(complete)
      expect(h.controller.status.value.phase).toBe('ready')
      expect(h.jobs).toHaveLength(2)
      expect(h.maximumInFlight).toBe(1)
    },
  )

  it('waits for cancelled background cleanup before starting an unrelated foreground song', async () => {
    const h = harness()
    await h.finishCurrent()
    const next = h.jobs[1]!
    next.holdCleanup()
    h.source.value = '/chosen.mp3'
    h.controller.start()
    expect(next.signal.aborted).toBe(true)
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    next.partial(timeline(60, 24))
    next.status({ phase: 'analysing', progress: 0.5, error: null })
    expect(h.controller.timeline.value).toBeNull()
    next.releaseCleanup()
    await flushPromises()
    expect(h.jobs.map((job) => job.source)).toEqual(['/current.mp3', '/next.mp3', '/chosen.mp3'])
    expect(h.maximumInFlight).toBe(1)
  })

  it.each([false, true])(
    'retains a matching neighbor across the source/start gap even if its old preload slot disappears (completed=%s)',
    async (completed) => {
      const h = harness([target('next', '/next.mp3', 60)])
      await h.finishCurrent()
      const next = h.jobs[1]!
      h.source.value = '/next.mp3'
      h.adjacent.value = []
      const partial = timeline(60, 24)
      next.partial(partial)
      expect(next.signal.aborted).toBe(false)
      expect(h.controller.timeline.value).toBeNull()
      const result = timeline(60)
      if (completed) next.complete(result)
      await flushPromises()
      expect(h.jobs).toHaveLength(2)
      h.controller.start()
      await flushPromises()
      expect(h.jobs).toHaveLength(2)
      expect(h.controller.timeline.value).toBe(completed ? result : partial)
      expect(h.controller.status.value.phase).toBe(completed ? 'ready' : 'analysing')
      expect(h.maximumInFlight).toBe(1)
    },
  )

  it('disables only background work when preloading is switched off', async () => {
    const h = harness()
    const current = await h.startCurrent()
    h.preloadEnabled.value = false
    expect(current.signal.aborted).toBe(false)
    const result = timeline()
    current.complete(result)
    await flushPromises()
    expect(h.jobs).toHaveLength(1)
    h.preloadEnabled.value = true
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    h.preloadEnabled.value = false
    expect(h.jobs[1]!.signal.aborted).toBe(true)
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    expect(h.controller.timeline.value).toBe(result)
    expect(h.controller.status.value.phase).toBe('ready')
  })

  it('cancels all analysis when visualisation is disabled and never dispatches background jobs', async () => {
    const h = harness()
    const current = await h.startCurrent()
    h.enabled.value = false
    expect(current.signal.aborted).toBe(true)
    await flushPromises()
    expect(h.jobs).toHaveLength(1)
    h.enabled.value = true
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    h.jobs[1]!.complete()
    await flushPromises()
    expect(h.jobs[2]!.source).toBe('/next.mp3')
    h.enabled.value = false
    expect(h.jobs[2]!.signal.aborted).toBe(true)
    await flushPromises()
    expect(h.jobs).toHaveLength(3)
    expect(h.controller.timeline.value).toBeNull()
    expect(h.maximumInFlight).toBe(1)
  })

  it('cancels obsolete queue targets while keeping the current complete timeline', async () => {
    const h = harness()
    const result = await h.finishCurrent()
    const oldNext = h.jobs[1]!
    h.adjacent.value = [target('next', '/replacement.mp3', 45)]
    expect(oldNext.signal.aborted).toBe(true)
    await flushPromises()
    expect(h.jobs.map((job) => job.source)).toEqual([
      '/current.mp3',
      '/next.mp3',
      '/replacement.mp3',
    ])
    expect(h.controller.timeline.value).toBe(result)
    expect(h.controller.status.value.phase).toBe('ready')
    expect(h.maximumInFlight).toBe(1)
  })

  it('keeps an in-flight neighbor when its direction or title changes but its source remains relevant', async () => {
    const h = harness()
    await h.finishCurrent()
    const next = h.jobs[1]!
    h.adjacent.value = [
      target('next', '/replacement.mp3', 45),
      { ...target('previous', '/next.mp3', 60), title: 'Updated metadata' },
    ]
    await flushPromises()
    expect(next.signal.aborted).toBe(false)
    expect(h.jobs).toHaveLength(2)
    next.complete()
    await flushPromises()
    expect(h.jobs[2]!.source).toBe('/replacement.mp3')
    expect(h.maximumInFlight).toBe(1)
  })

  it('deduplicates matching sources and ignores the current song as an adjacent candidate', async () => {
    const h = harness([
      target('next', '/same.mp3', 60),
      target('previous', '/same.mp3', 60),
      target('previous', '/current.mp3', 120),
    ])
    await h.finishCurrent()
    expect(h.jobs.map((job) => job.source)).toEqual(['/current.mp3', '/same.mp3'])
    h.jobs[1]!.complete()
    await flushPromises()
    h.controller.start()
    h.adjacent.value = [...h.adjacent.value]
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    expect(h.cache.size).toBe(2)
  })

  it('keeps background failures separate, avoids automatic retries, and allows foreground rebuilding', async () => {
    const h = harness()
    const result = await h.finishCurrent()
    h.jobs[1]!.fail(new Error('邻曲无法读取音频'))
    await flushPromises()
    expect(h.jobs[2]!.source).toBe('/previous.mp3')
    expect(h.controller.timeline.value).toBe(result)
    expect(h.controller.status.value).toMatchObject({ phase: 'ready', error: null })
    expect(
      h.controller.status.value.adjacent?.find((item) => item.source === '/next.mp3'),
    ).toMatchObject({
      phase: 'error',
      error: '邻曲无法读取音频',
    })
    h.jobs[2]!.complete()
    await flushPromises()
    h.controller.start()
    h.adjacent.value = [...h.adjacent.value]
    await flushPromises()
    expect(h.jobs).toHaveLength(3)
    h.source.value = '/next.mp3'
    h.controller.start()
    await flushPromises()
    expect(h.jobs[3]!.source).toBe('/next.mp3')
    expect(h.jobs[3]!.signal.aborted).toBe(false)
    expect(h.controller.status.value.phase).not.toBe('error')
  })

  it.each(['beat-this-small'] as const)(
    'reuses %s adjacent results but isolates the selected model and bounds the cache',
    async (initialMode) => {
      const h = harness([target('next', '/next.mp3', 60)])
      h.mode.value = initialMode
      await h.finishCurrent()
      const nextSmall = timeline(60)
      h.jobs[1]!.complete(nextSmall)
      await flushPromises()
      h.source.value = '/next.mp3'
      h.controller.start()
      await flushPromises()
      expect(h.controller.timeline.value).toBe(nextSmall)
      expect(h.jobs).toHaveLength(2)
      h.mode.value = 'beat-this-standard'
      await flushPromises()
      expect(h.jobs[2]!.dependencies.modelId).toBe('standard')
      expect(h.controller.timeline.value).toBeNull()
      h.jobs[2]!.complete(timeline(60))
      await flushPromises()
      h.mode.value = initialMode
      await flushPromises()
      expect(h.controller.timeline.value).toBe(nextSmall)
      expect(h.jobs).toHaveLength(3)
      h.mode.value = 'basic'
      await flushPromises()
      expect(h.jobs[3]!.dependencies.modelId).toBeUndefined()
      h.jobs[3]!.complete(timeline(60))
      await flushPromises()
      expect(h.cache.size).toBe(3)
      expect(h.maximumInFlight).toBe(1)
    },
  )

  it('aborts an active neighbor on unmount and ignores all late background callbacks', async () => {
    const h = harness()
    await h.finishCurrent()
    const next = h.jobs[1]!
    h.wrapper.unmount()
    expect(next.signal.aborted).toBe(true)
    next.partial(timeline(60, 24))
    next.status({ phase: 'analysing', progress: 0.4, error: null })
    next.complete()
    await flushPromises()
    expect(h.jobs).toHaveLength(2)
    expect(h.controller.timeline.value).toBeNull()
    expect(h.cache.size).toBe(1)
    expect(h.inFlight).toBe(0)
  })
})
