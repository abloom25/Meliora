import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, shallowRef } from 'vue'
import { createBeatTimelineBuffer, type BeatTimeline } from '../core/analysis/beat-timeline'
import type { BeatDebugSnapshot } from '../core/analysis/beat-debug'
import type { BeatAnalysisCheckpoint } from '../core/analysis/beat-checkpoint'
import type { BeatAnalysisMode } from '../core/types'
import type { BeatTimelineBuilder } from '../platform/web/beat-preanalysis'
import { useBeatComparison, type BeatComparisonOptions } from '../platform/web/useBeatComparison'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const wrappers: VueWrapper[] = []
function result(start = 0, end = 100): BeatTimeline {
  const timeline = createBeatTimelineBuffer(180)
  timeline.completedRanges = [{ startSeconds: start, endSeconds: end }]
  timeline.levels.forEach((levels) => levels.fill(0.8))
  return timeline
}
function checkpoint(timeline: BeatTimeline): BeatAnalysisCheckpoint {
  return {
    version: 1,
    signature: { sampleRate: 48000, sampleCount: 8640000, channels: 1, modelId: 'basic' },
    timeline,
    completedWindows: [0],
    estimatedWorkMs: 100,
  }
}
function harness(acquirePause?: BeatComparisonOptions['acquirePause']) {
  const source = ref('/song.mp3')
  const enabled = ref(true)
  const modelAvailable = ref({ small: true, standard: true })
  const flashRate = ref(1)
  const playback = ref({ timeSeconds: 5, playing: true, playbackRate: 1, seeking: false })
  const liveTimeline = shallowRef<BeatTimeline | null>(null)
  const liveMode = ref<BeatAnalysisMode>('basic')
  const debug = shallowRef<BeatDebugSnapshot | null>(null)
  const jobs: ReturnType<typeof deferred<BeatTimeline>>[] = []
  const build = vi.fn<BeatTimelineBuilder>(() => {
    const job = deferred<BeatTimeline>()
    jobs.push(job)
    return job.promise
  })
  let controller!: ReturnType<typeof useBeatComparison>
  const wrapper = mount(
    defineComponent({
      setup() {
        controller = useBeatComparison(
          {
            source,
            durationSeconds: ref(180),
            enabled,
            debug,
            modelAvailable,
            flashRate,
            liveTimeline,
            liveMode,
            getPlaybackSeconds: () => playback.value.timeSeconds,
            getPlaybackState: () => playback.value,
            acquirePause,
          },
          { build },
        )
        return () => h('div')
      },
    }),
  )
  wrappers.push(wrapper)
  let timestamp = 0
  function sample(
    time = playback.value.timeSeconds,
    overrides: Partial<BeatDebugSnapshot['current']> = {},
  ): void {
    timestamp += 33
    playback.value.timeSeconds = time
    const current = {
      sampledAtMs: timestamp,
      level: 0.2,
      sustain: 0.3,
      rawLevel: 0.9,
      rawSustain: 0.8,
      readyMix: 1,
      playbackSeconds: time,
      sampleSeconds: time - 0.1,
      delayMs: 100,
      playing: playback.value.playing,
      seeking: playback.value.seeking,
      canHighlight: true,
      reason: 'ready' as const,
      ...overrides,
    }
    debug.value = { source: source.value, mode: liveMode.value, current, history: [current] }
  }
  sample()
  return {
    source,
    enabled,
    modelAvailable,
    flashRate,
    playback,
    liveTimeline,
    liveMode,
    debug,
    jobs,
    build,
    controller,
    wrapper,
    sample,
  }
}
async function nextJob(): Promise<void> {
  await vi.advanceTimersByTimeAsync(200)
  await flushPromises()
}
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.useRealTimers()
})

describe('useBeatComparison rolling lifecycle', () => {
  it('records only after manual activation, retains sessions across tabs, and clears on song changes', async () => {
    const h = harness()
    h.sample(5.033)
    expect(h.controller.recordingStats.value.sampleCount).toBe(0)
    h.liveTimeline.value = result()
    await h.controller.start()
    await flushPromises()
    expect(h.controller.recordingStats.value.sampleCount).toBe(1)
    h.controller.stop()
    h.sample(5.066)
    expect(h.controller.recordingStats.value.sampleCount).toBe(2)
    h.enabled.value = false
    h.sample(5.099)
    expect(h.controller.recordingStats.value.sampleCount).toBe(2)
    h.enabled.value = true
    h.playback.value.playbackRate = 2
    h.sample(5.165)
    const report = h.controller.exportData({ title: 'Test', playbackRate: 2 })
    expect(report.observedSamples[0]!.playbackRate).toBe(1)
    expect(report.observedSamples.at(-1)!.playbackRate).toBe(2)
    expect(report.routes[0]!.timelines.some((timeline) => timeline.origin === 'live')).toBe(true)
    h.source.value = '/next.mp3'
    expect(h.controller.recordingStats.value.sampleCount).toBe(0)
    expect(h.controller.exportData({}).routes.every((route) => !route.timelines.length)).toBe(true)
  })
  it('observes actual output before construction starts and after it stops', async () => {
    const h = harness()
    expect(h.build).not.toHaveBeenCalled()
    expect(h.controller.snapshot.value.current?.actual.level).toBe(0.2)
    await h.controller.start()
    await flushPromises()
    h.controller.stop()
    h.sample(5.033, { level: 0.6 })
    expect(h.controller.snapshot.value.current?.actual.level).toBe(0.6)
    expect(h.controller.snapshot.value.phase).toBe('cancelled')
  })
  it('records aligned candidates without backfilling a previous missing result', async () => {
    const h = harness()
    h.modelAvailable.value = { small: false, standard: false }
    await h.controller.start()
    await flushPromises()
    expect(h.controller.snapshot.value.current?.candidates.basic).toBeNull()
    h.build.mock.calls[0]![3]!.onPartial!(result())
    h.sample(5.033)
    expect(h.controller.snapshot.value.history[0]!.candidates.basic).toBeNull()
    expect(h.controller.snapshot.value.current?.candidates.basic?.level).toBeCloseTo(0.8)
    expect(h.controller.snapshot.value.current?.actual.level).toBe(0.2)
    expect(h.controller.snapshot.value.current?.candidates['beat-this-small']).toBeNull()
  })
  it('builds one window per lease and prepares all three routes even without paused debug updates', async () => {
    const releases: ReturnType<typeof vi.fn>[] = []
    const acquire = vi.fn(async () => {
      const release = vi.fn()
      releases.push(release)
      return release
    })
    const h = harness(acquire)
    h.playback.value.playing = false
    await h.controller.start()
    await flushPromises()
    for (let index = 0; index < 3; index += 1) {
      expect(h.build).toHaveBeenCalledTimes(index + 1)
      const options = h.build.mock.calls[index]![3]!
      expect(options.modelId).toBe([undefined, 'small', 'standard'][index])
      expect(options.maxWindows).toBe(1)
      expect(options.getBufferSeconds?.()).toBe(60)
      expect(options.onPreview).toBeUndefined()
      h.jobs[index]!.resolve(result())
      await flushPromises()
      expect(releases[index]).toHaveBeenCalledTimes(1)
      await nextJob()
    }
    expect(h.build).toHaveBeenCalledTimes(3)
  })
  it('reuses the matching formal live timeline without a duplicate candidate worker', async () => {
    const h = harness()
    h.liveTimeline.value = result()
    await h.controller.start()
    await flushPromises()
    expect(h.build.mock.calls[0]![3]!.modelId).toBe('small')
    expect(h.controller.snapshot.value.current?.candidates.basic?.level).toBeCloseTo(0.8)
  })
  it('reports warm model build metrics and invalidates output when the model is removed', async () => {
    const h = harness()
    h.liveTimeline.value = result()
    h.modelAvailable.value = { small: false, standard: false }
    await h.controller.start()
    await flushPromises()
    expect(h.build).not.toHaveBeenCalled()
    expect(h.controller.snapshot.value.routes[1]!.status).toBe('unavailable')
    h.modelAvailable.value = { small: true, standard: false }
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
    const options = h.build.mock.calls[0]![3]!
    expect(options.modelId).toBe('small')
    expect(options.maxWindows).toBe(1)
    expect(options.onPreview).toBeUndefined()
    options.onMetrics!({
      totalMs: 600,
      initializationMs: 0,
      inferenceMs: 100,
      sessionReused: true,
      backend: 'wasm',
    })
    options.onPartial!(result())
    h.sample(5.033)
    expect(h.controller.snapshot.value.current?.candidates['beat-this-small']?.level).toBeCloseTo(
      0.8,
    )
    expect(h.controller.snapshot.value.routes[1]!.metrics?.sessionReused).toBe(true)
    h.modelAvailable.value = { small: false, standard: false }
    expect(h.build.mock.calls[0]![1].aborted).toBe(true)
    h.sample(5.066)
    expect(h.controller.snapshot.value.current?.candidates['beat-this-small']).toBeNull()
    expect(h.controller.snapshot.value.routes[1]!.timeline).toBeNull()
    h.jobs[0]!.resolve(result())
    await flushPromises()
    expect(h.controller.snapshot.value.routes[1]!.timeline).toBeNull()
  })
  it('rechecks foreground coverage after waiting for a lease', async () => {
    const pending = deferred<() => void>()
    const release = vi.fn()
    const h = harness(() => pending.promise)
    await h.controller.start()
    expect(h.build).not.toHaveBeenCalled()
    h.liveTimeline.value = result()
    pending.resolve(release)
    await flushPromises()
    expect(h.build).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
  })
  it('resumes checkpoints as playback advances, and preserves them across stop and tab changes', async () => {
    const h = harness()
    h.modelAvailable.value = { small: false, standard: false }
    await h.controller.start()
    await flushPromises()
    const timeline = result()
    const saved = checkpoint(timeline)
    h.build.mock.calls[0]![3]!.onCheckpoint!(saved)
    h.jobs[0]!.resolve(timeline)
    await flushPromises()
    await nextJob()
    h.enabled.value = false
    expect(h.controller.snapshot.value.history).toHaveLength(0)
    expect(h.controller.snapshot.value.routes[0]!.timeline).toBe(timeline)
    h.enabled.value = true
    await h.controller.start()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
    h.sample(70)
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(2)
    expect(h.build.mock.calls[1]![3]!.checkpoint).toBe(saved)
    expect(h.build.mock.calls[1]![3]!.getPrioritySeconds?.()).toBe(70)
  })
  it('changes epoch and clears history on seek, mode and flash-rate changes', async () => {
    const h = harness()
    h.sample(5.033)
    expect(h.controller.snapshot.value.history).toHaveLength(2)
    const epoch = h.controller.snapshot.value.epoch
    h.sample(70, { seeking: true })
    expect(h.controller.snapshot.value.history).toHaveLength(1)
    expect(h.controller.snapshot.value.epoch).toBeGreaterThan(epoch)
    h.liveMode.value = 'beat-this-small'
    expect(h.controller.snapshot.value.history).toHaveLength(0)
    h.sample(70.03, { seeking: false })
    expect(h.controller.snapshot.value.actualMode).toBe('beat-this-small')
    h.flashRate.value = 4
    expect(h.controller.snapshot.value.history).toHaveLength(0)
    h.sample(70.06)
    expect(h.controller.snapshot.value.current?.flashRate).toBe(4)
  })
  it('forwards real playback and seeking state to the active worker', async () => {
    const h = harness()
    await h.controller.start()
    await flushPromises()
    const receive = vi.fn()
    h.build.mock.calls[0]![3]!.subscribePriority!(receive)
    h.playback.value = { timeSeconds: 80, playing: true, playbackRate: 2, seeking: true }
    h.sample(80, { seeking: true })
    expect(receive).toHaveBeenLastCalledWith(h.playback.value)
  })
  it('isolates a failed model and never subscribes to its provisional basic preview', async () => {
    const h = harness()
    h.liveTimeline.value = result()
    await h.controller.start()
    await flushPromises()
    expect(h.build.mock.calls[0]![3]!.onPreview).toBeUndefined()
    h.jobs[0]!.reject(new Error('GPU failed'))
    await flushPromises()
    await nextJob()
    expect(h.controller.snapshot.value.routes[1]!.status).toBe('error')
    expect(h.build.mock.calls[1]![3]!.modelId).toBe('standard')
    h.jobs[1]!.resolve(result())
    await flushPromises()
    await nextJob()
    expect(h.build).toHaveBeenCalledTimes(2)
  })
  it('clears source-specific results and ignores cancelled late callbacks', async () => {
    const h = harness()
    await h.controller.start()
    await flushPromises()
    const [, signal, status, options] = h.build.mock.calls[0]!
    h.source.value = '/another.mp3'
    expect(signal.aborted).toBe(true)
    status({ phase: 'analysing', progress: 1, error: null })
    options!.onPartial!(result())
    h.jobs[0]!.resolve(result())
    await flushPromises()
    await nextJob()
    expect(h.controller.snapshot.value.phase).toBe('idle')
    expect(h.controller.snapshot.value.history).toHaveLength(0)
    expect(h.controller.snapshot.value.routes[0]!.timeline).toBeNull()
  })
  it('releases a late lease after cancellation without starting an abandoned worker', async () => {
    const pending = deferred<() => void>()
    const release = vi.fn()
    const acquire = vi.fn<NonNullable<BeatComparisonOptions['acquirePause']>>(() => pending.promise)
    const h = harness(acquire)
    await h.controller.start()
    h.controller.stop()
    expect(acquire.mock.calls[0]![0].aborted).toBe(true)
    pending.resolve(release)
    await flushPromises()
    expect(release).toHaveBeenCalledTimes(1)
    expect(h.build).not.toHaveBeenCalled()
  })
  it('cleans up worker, timer, and retained timeline ownership on unmount', async () => {
    const h = harness()
    await h.controller.start()
    await flushPromises()
    h.wrapper.unmount()
    expect(h.build.mock.calls[0]![1].aborted).toBe(true)
    h.jobs[0]!.resolve(result())
    await flushPromises()
    await nextJob()
    expect(h.controller.snapshot.value.phase).toBe('idle')
    expect(h.build).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
