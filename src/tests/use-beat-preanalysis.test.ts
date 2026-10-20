import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, type Ref } from 'vue'
import type { BeatTimeline } from '../core/analysis/beat-timeline'
import type { BeatAnalysisMode, Track } from '../core/types'
import { LruCache } from '../core/util/lru-cache'
import type { BeatTimelineBuilder } from '../platform/web/beat-preanalysis'
import { useBeatPreanalysis } from '../platform/web/useBeatPreanalysis'
import * as preanalysisHost from '../platform/web/beat-preanalysis'
import { recordListening, clearListeningHistory } from '../platform/web/listening-history'
import { createBeatCheckpoint } from '../core/analysis/beat-checkpoint'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function fixtureTimeline(): BeatTimeline {
  return {
    durationSeconds: 1,
    stepSeconds: 1 / 60,
    levels: [
      new Float32Array(60),
      new Float32Array(60),
      new Float32Array(60),
      new Float32Array(60),
    ],
    sustain: new Float32Array(60),
  }
}

const wrappers: VueWrapper[] = []

function harness(
  initiallyEnabled = true,
  initialUnavailableReason: string | null = null,
  track?: Ref<Track | null>,
) {
  const source = ref('/song-a.mp3')
  const enabled = ref(initiallyEnabled)
  const debugEnabled = ref(false)
  const unavailableReason = ref<string | null>(initialUnavailableReason)
  const durationSeconds = ref(1)
  const mode = ref<BeatAnalysisMode>('basic')
  const playback = ref(0)
  const jobs: ReturnType<typeof deferred<BeatTimeline>>[] = []
  const build = vi.fn<BeatTimelineBuilder>((_source, signal) => {
    const job = deferred<BeatTimeline>()
    const abort = () => job.reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    void job.promise.then(
      () => signal.removeEventListener('abort', abort),
      () => signal.removeEventListener('abort', abort),
    )
    jobs.push(job)
    return job.promise
  })
  const cache = new LruCache<string, BeatTimeline>(3)
  let controller!: ReturnType<typeof useBeatPreanalysis>
  const wrapper = mount(
    defineComponent({
      setup() {
        controller = useBeatPreanalysis(
          {
            source,
            track,
            mode,
            enabled,
            debugEnabled,
            unavailableReason,
            durationSeconds,
            getPlaybackSeconds: () => playback.value,
          },
          { build, cache },
        )
        return () => h('div')
      },
    }),
  )
  wrappers.push(wrapper)
  return {
    source,
    mode,
    enabled,
    debugEnabled,
    unavailableReason,
    jobs,
    build,
    controller,
    cache,
    wrapper,
    playback,
  }
}

afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('useBeatPreanalysis playback lifecycle', () => {
  it('keeps build metrics scoped to the current source and ignores cancelled callbacks', async () => {
    const { controller, debugEnabled, build, source } = harness()
    debugEnabled.value = true
    controller.start()
    await flushPromises()
    const oldMetrics = build.mock.calls[0]![3]!.onMetrics!
    oldMetrics({
      totalMs: 40,
      initializationMs: 0,
      inferenceMs: 0,
      sessionReused: false,
      cacheOrigin: 'persistent',
      cacheReadyMs: 25,
      cacheOnly: true,
    })
    expect(controller.debugSnapshot.value?.metrics).toMatchObject({
      cacheOnly: true,
      cacheReadyMs: 25,
    })
    source.value = '/other-song.mp3'
    await flushPromises()
    oldMetrics({ totalMs: 999, initializationMs: 0, inferenceMs: 0, sessionReused: false })
    expect(controller.debugSnapshot.value?.metrics).toBeUndefined()
  })

  it('persists an already ready short track when its second listening visit qualifies', async () => {
    const persist = vi
      .spyOn(preanalysisHost, 'persistKnownBeatCheckpoint')
      .mockImplementation(() => {})
    const source = ref('/short-qualification.mp3')
    const track = ref({
      id: 'short-qualification',
      kind: 'local' as const,
      title: 'Short',
      artist: '',
      audioUrl: source.value,
    })
    const timeline = fixtureTimeline()
    const checkpoint = createBeatCheckpoint(
      { sampleRate: 48000, sampleCount: 48000, channels: 2, modelId: 'basic' },
      timeline,
      new Set([0]),
      1,
    )
    const test = harness(true, null, track)
    test.source.value = source.value
    test.controller.start()
    await flushPromises()
    test.build.mock.calls[0]![3]!.onCheckpoint?.(checkpoint)
    test.jobs[0]!.resolve(timeline)
    await flushPromises()
    expect(test.controller.status.value.phase).toBe('ready')
    recordListening(track.value, 0.5, true)
    expect(persist).not.toHaveBeenCalled()
    recordListening(track.value, 0.5, true)
    expect(persist).toHaveBeenCalledExactlyOnceWith(
      source.value,
      JSON.stringify(['local', track.value.id]),
      expect.objectContaining({ completedWindows: [0] }),
    )
    expect(test.build).toHaveBeenCalledOnce()
    persist.mockRestore()
    await clearListeningHistory().catch(() => {})
  })
  it('forwards pause, rate, and seek-state changes within the same media second', async () => {
    const h = harness()
    h.controller.start()
    await flushPromises()
    const receive = vi.fn()
    h.build.mock.calls[0]![3]!.subscribePriority!(receive)
    const state = { timeSeconds: 12.1, playing: true, playbackRate: 1, seeking: false }
    h.controller.prioritize(12.1, state)
    h.controller.prioritize(12.2, state)
    h.controller.prioritize(12.2, { ...state, playing: false })
    h.controller.prioritize(12.2, { ...state, playbackRate: 2 })
    h.controller.prioritize(12.2, { ...state, playbackRate: 2, seeking: true })
    h.controller.prioritize(12.2, { ...state, playbackRate: 2 })
    expect(receive).toHaveBeenCalledTimes(5)
    expect(
      receive.mock.calls.map(([next]) => [next.playing, next.playbackRate, next.seeking]),
    ).toEqual([
      [true, 1, false],
      [false, 1, false],
      [true, 2, false],
      [true, 2, true],
      [true, 2, false],
    ])
    expect(h.build).toHaveBeenCalledTimes(1)
  })

  it('retargets a running build on seek without clearing completed middle ranges', async () => {
    const h = harness()
    h.controller.start()
    await flushPromises()
    const deps = h.build.mock.calls[0]![3]!
    h.playback.value = 0.5
    expect(deps.getPrioritySeconds!()).toBe(0.5)
    const receive = vi.fn()
    const unsubscribe = deps.subscribePriority!(receive)
    const partial = {
      ...fixtureTimeline(),
      completedRanges: [{ startSeconds: 0.4, endSeconds: 0.7 }],
    }
    deps.onPartial!(partial)
    h.controller.prioritize(50)
    h.controller.prioritize(50.2)
    h.controller.prioritize(80)
    expect(receive.mock.calls.map(([state]) => state.timeSeconds)).toEqual([50, 80])
    expect(h.controller.timeline.value).toBe(partial)
    expect(h.build).toHaveBeenCalledTimes(1)
    expect(h.build.mock.calls[0]![1].aborted).toBe(false)
    unsubscribe()
    h.controller.prioritize(90)
    expect(receive).toHaveBeenCalledTimes(2)
    h.source.value = '/new-song.mp3'
    deps.subscribePriority!(receive)
    h.controller.prioritize(100)
    expect(receive).toHaveBeenCalledTimes(2)
  })

  it('keeps completed ranges available when later analysis fails', async () => {
    const h = harness()
    h.controller.start()
    await flushPromises()
    const ranges = [{ startSeconds: 0.4, endSeconds: 0.7 }]
    h.build.mock.calls[0]![3]!.onPartial!({ ...fixtureTimeline(), completedRanges: ranges })
    h.build.mock.calls[0]![2]({
      phase: 'analysing',
      progress: 0.3,
      error: null,
      completedRanges: ranges,
      durationSeconds: 1,
      activeRange: { startSeconds: 0.7, endSeconds: 1 },
    })
    h.jobs[0]!.reject(new Error('高亮构建超时'))
    await flushPromises()
    expect(h.controller.timeline.value?.completedRanges).toEqual(ranges)
    expect(h.controller.status.value).toMatchObject({
      phase: 'error',
      completedRanges: ranges,
      activeRange: undefined,
    })
    expect(h.cache.size).toBe(0)
  })

  it('plays partial results immediately but caches only complete timelines and ignores stale partials', async () => {
    const h = harness()
    h.controller.start()
    await flushPromises()
    const partial = { ...fixtureTimeline(), builtUntilSeconds: 0.5 }
    const publish = h.build.mock.calls[0]![3]!.onPartial!
    publish(partial)
    expect(h.controller.timeline.value).toBe(partial)
    expect(h.controller.status.value.phase).not.toBe('ready')
    expect(h.cache.size).toBe(0)
    h.source.value = '/other.mp3'
    publish(partial)
    expect(h.controller.timeline.value).toBeNull()
    h.jobs[0]!.resolve(fixtureTimeline())
    await flushPromises()
    expect(h.cache.size).toBe(0)
  })
  it('cancels stale model analysis and caches each model separately from basic', async () => {
    const h = harness()
    h.mode.value = 'beat-this-small'
    await flushPromises()
    expect(h.build).not.toHaveBeenCalled()
    h.controller.start()
    await flushPromises()
    expect(h.build.mock.calls[0]![3]).toMatchObject({ modelId: 'small' })
    h.mode.value = 'beat-this-standard'
    expect(h.build.mock.calls[0]![1].aborted).toBe(true)
    await flushPromises()
    expect(h.build.mock.calls[1]![3]).toMatchObject({ modelId: 'standard' })
    h.jobs[0]!.resolve(fixtureTimeline())
    await flushPromises()
    expect(h.controller.timeline.value).toBeNull()
    const standard = fixtureTimeline()
    h.jobs[1]!.resolve(standard)
    await flushPromises()
    h.mode.value = 'basic'
    await flushPromises()
    expect(h.build.mock.calls[2]![3]).toEqual({
      durationSeconds: 1,
      checkpoint: undefined,
      onCheckpoint: expect.any(Function),
      onMetrics: expect.any(Function),
      getBufferSeconds: expect.any(Function),
      maxWindows: 3,
      subscribeYield: expect.any(Function),
      onPartial: expect.any(Function),
      onPreview: expect.any(Function),
      getPrioritySeconds: expect.any(Function),
      getPlaybackState: expect.any(Function),
      subscribePriority: expect.any(Function),
    })
    h.jobs[2]!.resolve(fixtureTimeline())
    await flushPromises()
    h.mode.value = 'beat-this-standard'
    expect(h.controller.timeline.value).toBe(standard)
    expect(h.build).toHaveBeenCalledTimes(3)
  })
  it('shows unsupported capabilities immediately even with analysis disabled and no playback', async () => {
    const h = harness(false, '此设备使用兼容播放模式')
    expect(h.controller.status.value).toMatchObject({
      phase: 'error',
      error: '此设备使用兼容播放模式',
    })
    await flushPromises()
    expect(h.build).not.toHaveBeenCalled()
    h.source.value = '/song-b.mp3'
    expect(h.controller.status.value).toMatchObject({
      phase: 'error',
      error: '此设备使用兼容播放模式',
    })
    expect(h.build).not.toHaveBeenCalled()
  })

  it('does not start before playback and coalesces repeated starts while publishing only final output', async () => {
    const h = harness()
    await flushPromises()
    expect(h.build).not.toHaveBeenCalled()
    h.controller.start()
    h.controller.start()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
    expect(h.build.mock.calls[0]![3]).toEqual({
      durationSeconds: 1,
      checkpoint: undefined,
      onCheckpoint: expect.any(Function),
      onMetrics: expect.any(Function),
      getBufferSeconds: expect.any(Function),
      maxWindows: 3,
      subscribeYield: expect.any(Function),
      onPartial: expect.any(Function),
      onPreview: expect.any(Function),
      getPrioritySeconds: expect.any(Function),
      getPlaybackState: expect.any(Function),
      subscribePriority: expect.any(Function),
    })
    const onStatus = h.build.mock.calls[0]![2]
    h.build.mock.calls[0]![3]!.onPreview!(fixtureTimeline())
    expect(h.controller.provisionalTimeline.value).toBeNull()
    onStatus({ phase: 'analysing', progress: 0.5, error: null })
    expect(h.controller.timeline.value).toBeNull()
    expect(h.controller.status.value.phase).toBe('analysing')
    const timeline = fixtureTimeline()
    h.jobs[0]!.resolve(timeline)
    await flushPromises()
    expect(h.controller.timeline.value).toBe(timeline)
    expect(h.controller.status.value.phase).toBe('ready')
    h.controller.start()
    expect(h.build).toHaveBeenCalledTimes(1)
  })

  it('clears the old source synchronously and ignores stale progress and results after switching', async () => {
    const h = harness()
    h.controller.start()
    await flushPromises()
    const oldSignal = h.build.mock.calls[0]![1]
    h.source.value = '/song-b.mp3'
    expect(oldSignal.aborted).toBe(true)
    expect(h.controller.timeline.value).toBeNull()
    expect(h.controller.status.value.phase).toBe('idle')
    h.build.mock.calls[0]![2]({ phase: 'analysing', progress: 0.9, error: null })
    h.jobs[0]!.resolve(fixtureTimeline())
    await flushPromises()
    expect(h.controller.status.value.phase).toBe('idle')
    expect(h.controller.timeline.value).toBeNull()
    expect(h.build).toHaveBeenCalledTimes(1)
    h.controller.start()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(2)
    expect(h.build.mock.calls[1]![0]).toBe('/song-b.mp3')
  })

  it('only resumes on enabling if this same source has already started playing', async () => {
    const h = harness(false)
    h.enabled.value = true
    await flushPromises()
    expect(h.build).not.toHaveBeenCalled()
    h.enabled.value = false
    h.controller.start()
    await flushPromises()
    expect(h.build).not.toHaveBeenCalled()
    h.enabled.value = true
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
    h.enabled.value = false
    expect(h.build.mock.calls[0]![1].aborted).toBe(true)
    h.source.value = '/song-b.mp3'
    h.enabled.value = true
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
  })

  it('reuses completed timelines after revisiting a song and bounds the cache to three', async () => {
    const h = harness()
    for (let index = 0; index < 4; index += 1) {
      h.source.value = `/song-${index}.mp3`
      h.controller.start()
      await flushPromises()
      h.jobs[index]!.resolve(fixtureTimeline())
      await flushPromises()
    }
    expect(h.cache.size).toBe(3)
    h.source.value = '/song-1.mp3'
    expect(h.controller.timeline.value).toBeNull()
    h.controller.start()
    expect(h.controller.status.value.phase).toBe('ready')
    expect(h.build).toHaveBeenCalledTimes(4)
    h.source.value = '/song-0.mp3'
    h.controller.start()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(5)
  })

  it('keeps failures stable until an explicit retry and never retries merely on another play event', async () => {
    const h = harness()
    h.controller.start()
    await flushPromises()
    h.jobs[0]!.reject(new Error('当前音源不允许读取音频'))
    await flushPromises()
    expect(h.controller.status.value).toMatchObject({
      phase: 'error',
      error: '当前音源不允许读取音频',
    })
    h.controller.start()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
    h.controller.retry()
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(2)
  })

  it('respects capability errors and discards late completions after unmount', async () => {
    const h = harness()
    h.unavailableReason.value = '此浏览器暂不支持'
    h.controller.start()
    await flushPromises()
    expect(h.controller.status.value.error).toBe('此浏览器暂不支持')
    expect(h.build).not.toHaveBeenCalled()
    h.unavailableReason.value = null
    await flushPromises()
    expect(h.build).toHaveBeenCalledTimes(1)
    h.wrapper.unmount()
    expect(h.build.mock.calls[0]![1].aborted).toBe(true)
    h.jobs[0]!.resolve(fixtureTimeline())
    await flushPromises()
    expect(h.controller.timeline.value).toBeNull()
    expect(h.cache.size).toBe(0)
  })
})
