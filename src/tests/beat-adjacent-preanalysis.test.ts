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
  const preloadEnabled = ref(true)
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
            preloadEnabled,
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
    preloadEnabled,
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

describe('adjacent beat preanalysis scheduling and promotion', () => {
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

  it('reuses completed adjacent results but isolates the selected model and bounds the cache', async () => {
    const h = harness([target('next', '/next.mp3', 60)])
    h.mode.value = 'beat-this-small'
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
    h.mode.value = 'beat-this-small'
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
  })

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
