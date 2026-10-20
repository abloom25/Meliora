import { flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBeatTimelineBuffer, type BeatTimeline } from '../core/analysis/beat-timeline'
import type { BeatResultStore } from '../core/analysis/beat-result-cache'
import type { BeatPlaybackState } from '../core/analysis/beat-scheduling'
import type { BeatPreanalysisResponse } from '../core/analysis/beat-preanalysis-protocol'
import type { BeatAnalysisCheckpoint } from '../core/analysis/beat-checkpoint'
import { createBeatAudioCache, type BeatAudioData } from '../platform/web/beat-audio-cache'
import {
  buildBeatTimeline,
  persistKnownBeatCheckpoint,
  type BeatPreanalysisDependencies,
} from '../platform/web/beat-preanalysis'
import { setHttpFetcher } from '../services/http'
import { invalidateBeatModelSessions } from '../platform/web/beat-worker-pool'
import * as workerPool from '../platform/web/beat-worker-pool'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

class MockWorker {
  onmessage: ((event: MessageEvent<BeatPreanalysisResponse>) => void) | null = null
  onerror: (() => void) | null = null
  onmessageerror: (() => void) | null = null
  postMessage = vi.fn()
  terminate = vi.fn()

  reply(message: BeatPreanalysisResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<BeatPreanalysisResponse>)
  }
}

function fixtureTimeline(): BeatTimeline {
  return {
    durationSeconds: 1,
    stepSeconds: 1 / 60,
    levels: Array.from({ length: 4 }, () => new Float32Array(60)) as BeatTimeline['levels'],
    sustain: new Float32Array(60),
  }
}

function fixtureCheckpoint(): BeatAnalysisCheckpoint {
  return {
    version: 1,
    signature: { sampleRate: 48000, sampleCount: 48000, channels: 2, modelId: 'basic' },
    timeline: {
      ...createBeatTimelineBuffer(1),
      completedRanges: [{ startSeconds: 0, endSeconds: 0.4 }],
      builtUntilSeconds: 0.4,
    },
    completedWindows: [0],
    estimatedWorkMs: 150,
  }
}

/** Reproduce postMessage ownership transfer, which a plain vi.fn does not perform. */
function transferAudio(worker: MockWorker): BeatAudioData {
  const request = worker.postMessage.mock.calls[0]![0] as BeatAudioData
  return structuredClone(
    { channels: request.channels, sampleRate: request.sampleRate },
    { transfer: request.channels.map((channel) => channel.buffer) },
  )
}

function audioBuffer(overrides: Partial<AudioBuffer> = {}): AudioBuffer {
  return {
    sampleRate: 48000,
    duration: 1,
    length: 48000,
    numberOfChannels: 2,
    copyFromChannel: vi.fn((destination: Float32Array, channel: number) => {
      destination.fill(channel === 0 ? 0.5 : -0.25)
    }),
    ...overrides,
  } as unknown as AudioBuffer
}

function harness(overrides: BeatPreanalysisDependencies = {}) {
  const worker = new MockWorker()
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'content-type': 'audio/mpeg', 'content-length': '3' },
    }),
  )
  const decode = vi
    .fn<(data: ArrayBuffer) => Promise<AudioBuffer>>()
    .mockResolvedValue(audioBuffer())
  const createWorker = vi.fn(() => worker as unknown as Worker)
  const dependencies = {
    fetcher,
    decode,
    createWorker,
    durationSeconds: 1,
    audioCache: createBeatAudioCache(),
    ...overrides,
  }
  const controller = new AbortController()
  const onStatus = vi.fn()
  const promise = buildBeatTimeline('/song.mp3', controller.signal, onStatus, dependencies)
  return { promise, controller, onStatus, worker, fetcher, decode, createWorker }
}

afterEach(() => {
  invalidateBeatModelSessions()
  vi.useRealTimers()
  setHttpFetcher(null)
  vi.restoreAllMocks()
})

describe('browser beat preanalysis', () => {
  function persistentFixture() {
    const cache = createBeatAudioCache()
    cache.putPcm('/song.mp3', {
      channels: [new Float32Array(48000), new Float32Array(48000)],
      sampleRate: 48000,
      identity: `sha256:${'a'.repeat(64)}`,
    })
    const checkpoint: BeatAnalysisCheckpoint = {
      version: 1,
      signature: { sampleRate: 48000, sampleCount: 48000, channels: 2, modelId: 'basic' },
      timeline: createBeatTimelineBuffer(1),
      completedWindows: [0],
      estimatedWorkMs: 150,
    }
    checkpoint.timeline.completedRanges = [{ startSeconds: 0, endSeconds: 0.4 }]
    const store: BeatResultStore = {
      generation: 0,
      get: vi.fn().mockResolvedValue(checkpoint),
      set: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      refresh: vi.fn().mockResolvedValue(undefined),
    }
    return { cache, checkpoint, store }
  }

  it('validates full encoded bytes then returns cached coverage without decoding, reading assets or acquiring a lease', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    cache.clear()
    checkpoint.signature.modelId = 'small'
    checkpoint.timeline.completedRanges = [{ startSeconds: 0, endSeconds: 1 }]
    const readModel = vi.fn().mockRejectedValue(new Error('model unavailable'))
    const acquire = vi.spyOn(workerPool, 'acquireBeatModelSession')
    const hash = vi.spyOn(globalThis.crypto.subtle, 'digest')
    const onPartial = vi.fn()
    const onMetrics = vi.fn()
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'cold-cache', eligible: () => true },
      modelId: 'small',
      reuseModelSession: true,
      readModel,
      onPartial,
      onMetrics,
      getBufferSeconds: () => 60,
    })
    await expect(h.promise).resolves.toBe(checkpoint.timeline)
    expect(h.fetcher).toHaveBeenCalledOnce()
    expect(hash).toHaveBeenCalledWith('SHA-256', new Uint8Array([1, 2, 3]).buffer)
    expect(store.get).toHaveBeenCalledWith(expect.stringContaining('beat-this-small0-v1'))
    expect(onPartial).toHaveBeenCalledExactlyOnceWith(checkpoint.timeline)
    expect(h.decode).not.toHaveBeenCalled()
    expect(readModel).not.toHaveBeenCalled()
    expect(acquire).not.toHaveBeenCalled()
    expect(h.createWorker).not.toHaveBeenCalled()
    expect(onMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheOrigin: 'persistent',
        cacheOnly: true,
        cacheReadyMs: expect.any(Number),
        cacheReadMs: expect.any(Number),
        hashMs: expect.any(Number),
        decodeMs: 0,
        modelPreparationMs: 0,
        encodedBytes: 3,
        pcmBytes: 0,
        inferenceMs: 0,
      }),
    )
    expect(cache.pcmEntries).toBe(0)
  })

  it('publishes partial cached coverage before decoder and model preparation begin, then resumes it', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    cache.clear()
    checkpoint.signature.modelId = 'small'
    const order: string[] = []
    const decoded = deferred<AudioBuffer>()
    const model = deferred<{
      model: ArrayBuffer
      filterbank: ArrayBuffer
      wasmBinary: ArrayBuffer
    }>()
    const decode = vi.fn(() => {
      order.push('decode')
      return decoded.promise
    })
    const readModel = vi.fn(() => {
      order.push('model')
      return model.promise
    })
    const onMetrics = vi.fn()
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'partial-before-prepare', eligible: () => true },
      modelId: 'small',
      readModel,
      decode,
      onPartial: () => {
        order.push('partial')
      },
      onMetrics,
      getBufferSeconds: () => 1,
    })
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce())
    expect(order[0]).toBe('partial')
    expect(readModel).toHaveBeenCalledOnce()
    expect(h.createWorker).not.toHaveBeenCalled()
    decoded.resolve(audioBuffer())
    model.resolve({
      model: new ArrayBuffer(8),
      filterbank: new ArrayBuffer(4),
      wasmBinary: new ArrayBuffer(8),
    })
    await flushPromises()
    expect(h.worker.postMessage.mock.calls[0]![0].checkpoint).toBe(checkpoint)
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
    expect(onMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheOrigin: 'persistent',
        cacheOnly: false,
        cacheReadyMs: expect.any(Number),
        decodeMs: expect.any(Number),
        modelPreparationMs: expect.any(Number),
        pcmBytes: 384000,
      }),
    )
  })

  it('rechecks the live playhead after cache publication instead of returning coverage for the old position', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    cache.clear()
    let position = 0
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'moved-playhead', eligible: () => true },
      getBufferSeconds: () => 0.2,
      getPrioritySeconds: () => position,
      onPartial: () => {
        position = 0.8
      },
    })
    await vi.waitFor(() => expect(h.createWorker).toHaveBeenCalledOnce())
    expect(h.worker.postMessage.mock.calls[0]![0]).toMatchObject({
      prioritySeconds: 0.8,
      checkpoint,
    })
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
  })

  it.each(['missing', 'wrong-model', 'wrong-duration', 'malformed'] as const)(
    'falls back normally from a %s persistent candidate',
    async (problem) => {
      const { cache, checkpoint, store } = persistentFixture()
      cache.clear()
      const onPartial = vi.fn()
      if (problem === 'missing') vi.mocked(store.get).mockResolvedValue(null)
      if (problem === 'wrong-model') checkpoint.signature.modelId = 'standard'
      if (problem === 'wrong-duration') {
        checkpoint.signature.sampleCount = 48000 * 2
        checkpoint.timeline = createBeatTimelineBuffer(2)
      }
      if (problem === 'malformed') checkpoint.timeline.levels[0][0] = NaN
      const h = harness({
        audioCache: cache,
        resultCache: store,
        persistent: { trackKey: `fallback-${problem}`, eligible: () => true },
        onPartial,
        getBufferSeconds: () => 1,
      })
      await vi.waitFor(() => expect(h.createWorker).toHaveBeenCalledOnce())
      expect(h.decode).toHaveBeenCalledOnce()
      expect(onPartial).not.toHaveBeenCalled()
      expect(h.worker.postMessage.mock.calls[0]![0].checkpoint).toBeUndefined()
      h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
      await h.promise
    },
  )

  it('rejects promptly on cancellation during cache lookup and observes its late completion', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    cache.clear()
    const pending = deferred<BeatAnalysisCheckpoint | null>()
    vi.mocked(store.get).mockReturnValue(pending.promise)
    const onPartial = vi.fn()
    const readModel = vi.fn()
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'abort-before-decode', eligible: () => true },
      onPartial,
      modelId: 'small',
      readModel,
    })
    const rejected = expect(h.promise).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(store.get).toHaveBeenCalledOnce())
    h.controller.abort()
    await rejected
    pending.resolve(checkpoint)
    await flushPromises()
    expect(onPartial).not.toHaveBeenCalled()
    expect(h.decode).not.toHaveBeenCalled()
    expect(readModel).not.toHaveBeenCalled()
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('rejects cached data when eligibility is removed while the read is pending', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    cache.clear()
    const pending = deferred<BeatAnalysisCheckpoint | null>()
    vi.mocked(store.get).mockReturnValue(pending.promise)
    let eligible = true
    const onPartial = vi.fn()
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'eligibility-revoked', eligible: () => eligible },
      onPartial,
    })
    await vi.waitFor(() => expect(store.get).toHaveBeenCalledOnce())
    eligible = false
    pending.resolve(checkpoint)
    await flushPromises()
    expect(onPartial).not.toHaveBeenCalled()
    expect(h.worker.postMessage.mock.calls[0]![0].checkpoint).toBeUndefined()
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
    expect(store.set).not.toHaveBeenCalled()
  })

  it('does not publish after an onCheckpoint callback cancels the build', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    checkpoint.timeline.completedRanges = [{ startSeconds: 0, endSeconds: 1 }]
    const onPartial = vi.fn()
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'callback-abort', eligible: () => true },
      getBufferSeconds: () => 1,
      onCheckpoint: () => h.controller.abort(),
      onPartial,
    })
    await expect(h.promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(onPartial).not.toHaveBeenCalled()
    expect(h.decode).not.toHaveBeenCalled()
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('uses a valid in-memory checkpoint without even fetching encoded audio', async () => {
    const checkpoint = fixtureCheckpoint()
    checkpoint.timeline.completedRanges = [{ startSeconds: 0, endSeconds: 1 }]
    const onMetrics = vi.fn()
    const h = harness({ checkpoint, getBufferSeconds: () => 1, onMetrics })
    await expect(h.promise).resolves.toBe(checkpoint.timeline)
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(h.decode).not.toHaveBeenCalled()
    expect(h.createWorker).not.toHaveBeenCalled()
    expect(onMetrics).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheOrigin: 'memory',
        cacheOnly: true,
        encodedBytes: 0,
        pcmBytes: 0,
      }),
    )
  })

  it('restores only content-verified frequent-song output and resumes the missing windows', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    const onCheckpoint = vi.fn()
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'source:id', eligible: () => true },
      getBufferSeconds: () => 1,
      onCheckpoint,
    })
    await flushPromises()
    expect(h.fetcher).not.toHaveBeenCalled()
    expect(store.get).toHaveBeenCalledWith(expect.stringContaining(`sha256:${'a'.repeat(64)}`))
    expect(h.worker.postMessage.mock.calls[0]![0].checkpoint).toBe(checkpoint)
    const complete = createBeatTimelineBuffer(1)
    delete complete.completedRanges
    delete complete.builtUntilSeconds
    h.worker.reply({ type: 'complete', timeline: complete })
    await h.promise
    const saved = vi.mocked(store.set).mock.calls.at(-1)![2]
    expect(saved.completedWindows).toEqual([0])
    expect(saved.timeline.completedRanges).toBeUndefined()
    expect(onCheckpoint).toHaveBeenLastCalledWith(saved)
  })

  it('uses complete persistent coverage without starting another worker', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    delete checkpoint.timeline.completedRanges
    delete checkpoint.timeline.builtUntilSeconds
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'full-song', eligible: () => true },
      getBufferSeconds: () => 60,
    })
    await expect(h.promise).resolves.toBe(checkpoint.timeline)
    expect(h.createWorker).not.toHaveBeenCalled()
    expect(cache.takePcm('/song.mp3')?.identity).toContain('sha256:')
  })

  it('ignores restoration that finishes after cancellation or clearing', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    const read = deferred<BeatAnalysisCheckpoint | null>()
    vi.mocked(store.get).mockReturnValue(read.promise)
    const onPartial = vi.fn()
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'cancelled-song', eligible: () => true },
      onPartial,
    })
    await flushPromises()
    h.controller.abort()
    const result = expect(h.promise).rejects.toMatchObject({ name: 'AbortError' })
    read.resolve(checkpoint)
    await result
    expect(onPartial).not.toHaveBeenCalled()
    expect(h.createWorker).not.toHaveBeenCalled()

    const next = persistentFixture()
    const late = deferred<BeatAnalysisCheckpoint | null>()
    vi.mocked(next.store.get).mockReturnValue(late.promise)
    const second = harness({
      audioCache: next.cache,
      resultCache: next.store,
      persistent: { trackKey: 'cleared-song', eligible: () => true },
    })
    await flushPromises()
    Object.defineProperty(next.store, 'generation', { value: 1 })
    late.resolve(next.checkpoint)
    await flushPromises()
    expect(second.worker.postMessage.mock.calls[0]![0].checkpoint).toBeUndefined()
    second.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await second.promise
    expect(next.store.set).not.toHaveBeenCalled()
  })

  it('saves an already finished short song when it becomes frequent without rebuilding', async () => {
    const { cache, store } = persistentFixture()
    const onCheckpoint = vi.fn()
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'short-song', eligible: () => false },
      onCheckpoint,
    })
    await flushPromises()
    expect(store.get).not.toHaveBeenCalled()
    const complete = createBeatTimelineBuffer(1)
    delete complete.completedRanges
    delete complete.builtUntilSeconds
    h.worker.reply({ type: 'complete', timeline: complete })
    await h.promise
    expect(store.set).not.toHaveBeenCalled()
    const checkpoint = onCheckpoint.mock.calls[0]![0] as BeatAnalysisCheckpoint
    persistKnownBeatCheckpoint('/song.mp3', 'different-song', checkpoint)
    expect(store.set).not.toHaveBeenCalled()
    persistKnownBeatCheckpoint('/song.mp3', 'short-song', checkpoint)
    expect(store.set).toHaveBeenCalledOnce()
    expect(h.createWorker).toHaveBeenCalledOnce()
    Object.defineProperty(store, 'generation', { value: 1 })
    persistKnownBeatCheckpoint('/song.mp3', 'short-song', checkpoint)
    expect(store.set).toHaveBeenCalledOnce()
  })

  it('does not adopt a stored timeline belonging to different decoded audio dimensions', async () => {
    const { cache, checkpoint, store } = persistentFixture()
    checkpoint.signature.channels = 1
    const h = harness({
      audioCache: cache,
      resultCache: store,
      persistent: { trackKey: 'dimensions', eligible: () => true },
    })
    await flushPromises()
    expect(h.worker.postMessage.mock.calls[0]![0].checkpoint).toBeUndefined()
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
  })

  it('keeps two models independent and reuses warm workers without reading or transferring model assets again', async () => {
    const createWorker = vi.fn(() => new MockWorker() as unknown as Worker)
    const readModel = vi.fn(async () => ({
      model: new ArrayBuffer(8),
      filterbank: new ArrayBuffer(4),
      wasmBinary: new ArrayBuffer(8),
    }))
    const common = { createWorker, readModel, reuseModelSession: true }
    const metrics = {
      initializationMs: 12,
      inferenceMs: 20,
      sessionReused: false,
      backend: 'wasm' as const,
    }
    const first = harness({ ...common, modelId: 'small' })
    const second = harness({ ...common, modelId: 'standard' })
    await flushPromises()
    const small = createWorker.mock.results[0]!.value as unknown as MockWorker
    const standard = createWorker.mock.results[1]!.value as unknown as MockWorker
    small.reply({ type: 'complete', timeline: fixtureTimeline(), metrics })
    standard.reply({ type: 'complete', timeline: fixtureTimeline(), metrics })
    await Promise.all([first.promise, second.promise])
    const onMetrics = vi.fn()
    const warm = harness({ ...common, modelId: 'small', onMetrics })
    await flushPromises()
    expect(readModel).toHaveBeenCalledTimes(2)
    expect(createWorker).toHaveBeenCalledTimes(2)
    expect(small.terminate).not.toHaveBeenCalled()
    const [request, transfers] = small.postMessage.mock.calls.at(-1)!
    expect(request).toMatchObject({ modelId: 'small', retainSession: true })
    expect(request.model).toBeUndefined()
    expect(transfers).toHaveLength(2)
    small.reply({
      type: 'complete',
      timeline: fixtureTimeline(),
      metrics: { ...metrics, initializationMs: 0, sessionReused: true },
    })
    await warm.promise
    expect(onMetrics).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionReused: true,
        backend: 'wasm',
        totalMs: expect.any(Number),
      }),
    )
  })

  it('serializes same-model callers and cancels queued requests without interrupting the active worker', async () => {
    const createWorker = vi.fn(() => new MockWorker() as unknown as Worker)
    const readModel = vi.fn(async () => ({
      model: new ArrayBuffer(8),
      filterbank: new ArrayBuffer(4),
      wasmBinary: new ArrayBuffer(8),
    }))
    const common = { createWorker, readModel, reuseModelSession: true, modelId: 'small' as const }
    const first = harness(common)
    const queued = harness(common)
    const cancelled = expect(queued.promise).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    expect(createWorker).toHaveBeenCalledOnce()
    queued.controller.abort()
    await cancelled
    const worker = createWorker.mock.results[0]!.value as unknown as MockWorker
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.reply({
      type: 'complete',
      timeline: fixtureTimeline(),
      metrics: { initializationMs: 1, inferenceMs: 1, sessionReused: false, backend: 'wasm' },
    })
    await first.promise
    const waiting = harness(common)
    await flushPromises()
    expect(createWorker).toHaveBeenCalledOnce()
    const rejected = expect(waiting.promise).rejects.toMatchObject({ name: 'AbortError' })
    invalidateBeatModelSessions('small')
    await rejected
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('expires idle model workers, waits for disposal, and bounds missing acknowledgments', async () => {
    vi.useFakeTimers()
    const createWorker = vi.fn(() => new MockWorker() as unknown as Worker)
    const readModel = vi.fn(async () => ({
      model: new ArrayBuffer(8),
      filterbank: new ArrayBuffer(4),
      wasmBinary: new ArrayBuffer(8),
    }))
    const common = { createWorker, readModel, reuseModelSession: true, modelId: 'small' as const }
    const first = harness(common)
    await flushPromises()
    const worker = createWorker.mock.results[0]!.value as unknown as MockWorker
    worker.reply({
      type: 'complete',
      timeline: fixtureTimeline(),
      metrics: { initializationMs: 1, inferenceMs: 1, sessionReused: false, backend: 'wasm' },
    })
    await first.promise
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'dispose' })
    const next = harness(common)
    await flushPromises()
    expect(createWorker).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_000)
    await flushPromises()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(createWorker).toHaveBeenCalledTimes(2)
    const fresh = createWorker.mock.results[1]!.value as unknown as MockWorker
    fresh.reply({ type: 'complete', timeline: fixtureTimeline() })
    await next.promise
    expect(readModel).toHaveBeenCalledTimes(2)
  })

  it('overlaps selected model loading with audio fetch and decode, dispatching only after both are ready', async () => {
    const model = deferred<{
      model: ArrayBuffer
      filterbank: ArrayBuffer
      wasmBinary: ArrayBuffer
    }>()
    const decoded = deferred<AudioBuffer>()
    const readModel = vi.fn(() => model.promise)
    const decode = vi.fn(() => decoded.promise)
    const h = harness({ modelId: 'small', readModel, decode })
    await flushPromises()
    expect(readModel).toHaveBeenCalledOnce()
    expect(h.fetcher).toHaveBeenCalledOnce()
    expect(decode).toHaveBeenCalledOnce()
    expect(h.createWorker).not.toHaveBeenCalled()
    decoded.resolve(audioBuffer())
    await flushPromises()
    expect(h.createWorker).not.toHaveBeenCalled()
    expect(h.onStatus.mock.calls.at(-1)![0].phase).toBe('loading-model')
    model.resolve({
      model: new ArrayBuffer(8),
      filterbank: new ArrayBuffer(4),
      wasmBinary: new ArrayBuffer(8),
    })
    await flushPromises()
    expect(h.createWorker).toHaveBeenCalledOnce()
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
  })

  it('routes previews separately from formal coverage, progress and checkpoints', async () => {
    const onPreview = vi.fn()
    const onPartial = vi.fn()
    const onCheckpoint = vi.fn()
    const h = harness({ onPreview, onPartial, onCheckpoint })
    await flushPromises()
    const statuses = h.onStatus.mock.calls.length
    const preview = fixtureTimeline()
    h.worker.reply({ type: 'preview', timeline: preview })
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(preview)
    expect(onPartial).not.toHaveBeenCalled()
    expect(onCheckpoint).not.toHaveBeenCalled()
    expect(h.onStatus.mock.calls).toHaveLength(statuses)
    expect(h.worker.terminate).not.toHaveBeenCalled()
    const completion = expect(h.promise).rejects.toMatchObject({ name: 'AbortError' })
    h.controller.abort()
    await completion
    h.worker.reply({ type: 'preview', timeline: fixtureTimeline() })
    expect(onPreview).toHaveBeenCalledOnce()
  })

  it('observes late model rejection after an audio failure and cancels the model preparation signal', async () => {
    const model = deferred<never>()
    const readModel = vi.fn<NonNullable<BeatPreanalysisDependencies['readModel']>>(
      () => model.promise,
    )
    const h = harness({
      modelId: 'small',
      readModel,
      decode: vi.fn().mockRejectedValue(new Error('bad audio')),
    })
    await expect(h.promise).rejects.toThrow('无法解码')
    expect(readModel.mock.calls[0]![1].aborted).toBe(true)
    model.reject(new Error('late model failure'))
    await flushPromises()
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('returns prepared PCM to cache when model loading fails after decoding', async () => {
    const audioCache = createBeatAudioCache()
    const model = deferred<never>()
    const h = harness({ audioCache, modelId: 'small', readModel: () => model.promise })
    const completion = expect(h.promise).rejects.toThrow('模型不可用')
    await flushPromises()
    expect(h.decode).toHaveBeenCalledOnce()
    model.reject(new Error('模型不可用'))
    await completion
    expect(audioCache.pcmEntries).toBe(1)
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('aborts both parallel preparations promptly and observes their late failures', async () => {
    const model = deferred<never>()
    const decoded = deferred<AudioBuffer>()
    const readModel = vi.fn<NonNullable<BeatPreanalysisDependencies['readModel']>>(
      () => model.promise,
    )
    const h = harness({ modelId: 'small', readModel, decode: () => decoded.promise })
    const completion = expect(h.promise).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    h.controller.abort()
    await completion
    expect(readModel.mock.calls[0]![1].aborted).toBe(true)
    model.reject(new Error('late model rejection'))
    decoded.reject(new Error('late decode rejection'))
    await flushPromises()
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('sends bounded checkpoints without detaching visible timeline buffers and keeps prior coverage during loading', async () => {
    const checkpoint = fixtureCheckpoint()
    checkpoint.signature.modelId = 'small'
    const readModel = vi.fn().mockResolvedValue({
      model: new ArrayBuffer(8),
      filterbank: new ArrayBuffer(4),
      wasmBinary: new ArrayBuffer(8),
      wasmPaths: { mjs: '/runtime.mjs' },
    })
    const onCheckpoint = vi.fn()
    const onPartial = vi.fn()
    const h = harness({
      checkpoint,
      onCheckpoint,
      onPartial,
      modelId: 'small',
      readModel,
      durationSeconds: 2,
      getBufferSeconds: () => 60,
      maxWindows: 3,
    })
    await flushPromises()
    const [request, transfer] = h.worker.postMessage.mock.calls[0]!
    expect(request).toMatchObject({ checkpoint, bufferSeconds: 60, maxWindows: 3 })
    for (const values of [...checkpoint.timeline.levels, checkpoint.timeline.sustain])
      expect(transfer).not.toContain(values.buffer)
    for (const [status] of h.onStatus.mock.calls)
      expect(status).toMatchObject({
        availableSeconds: 0.4,
        durationSeconds: 1,
        completedRanges: checkpoint.timeline.completedRanges,
      })
    const audio = transferAudio(h.worker)
    const next = fixtureCheckpoint()
    next.signature.modelId = 'small'
    h.worker.reply({ type: 'partial', timeline: next.timeline, checkpoint: next, progress: 0.4 })
    expect(onCheckpoint).toHaveBeenLastCalledWith(next)
    expect(onPartial).toHaveBeenLastCalledWith(next.timeline)
    h.worker.reply({ type: 'buffered', checkpoint: next, audio })
    await expect(h.promise).resolves.toBe(next.timeline)
    expect(h.onStatus.mock.lastCall![0]).toMatchObject({
      progress: 0.4,
      availableSeconds: 0.4,
      activeRange: undefined,
    })
    expect(h.worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('reuses returned PCM across bounded batches without fetching or decoding again', async () => {
    const audioCache = createBeatAudioCache()
    const first = harness({ audioCache, getBufferSeconds: () => 0.4 })
    await flushPromises()
    const audio = transferAudio(first.worker)
    first.worker.reply({ type: 'buffered', checkpoint: fixtureCheckpoint(), audio })
    await first.promise
    expect(audioCache.pcmEntries).toBe(1)
    const second = harness({
      audioCache,
      checkpoint: fixtureCheckpoint(),
      getBufferSeconds: () => 0.7,
    })
    await flushPromises()
    expect(second.fetcher).not.toHaveBeenCalled()
    expect(second.decode).not.toHaveBeenCalled()
    expect(audioCache.pcmEntries).toBe(0)
    const returned = transferAudio(second.worker)
    expect(returned.channels[0]![0]).toBe(0.5)
    expect(returned.channels[1]![0]).toBe(-0.25)
    second.worker.reply({ type: 'complete', timeline: fixtureTimeline(), audio: returned })
    await second.promise
    expect(audioCache.pcmEntries).toBe(1)
    expect(first.worker.terminate).toHaveBeenCalledTimes(1)
    expect(second.worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('keeps encoded audio after a hard worker abort and decodes a fresh copy without refetching', async () => {
    const audioCache = createBeatAudioCache()
    const first = harness({ audioCache })
    const rejected = expect(first.promise).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    transferAudio(first.worker)
    first.controller.abort()
    await rejected
    expect(audioCache.pcmEntries).toBe(0)
    expect(audioCache.encodedEntries).toBe(1)
    const second = harness({ audioCache })
    await flushPromises()
    expect(second.fetcher).not.toHaveBeenCalled()
    expect(second.decode).toHaveBeenCalledTimes(1)
    expect(new Uint8Array(second.decode.mock.calls[0]![0])).toEqual(new Uint8Array([1, 2, 3]))
    second.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await second.promise
  })

  it('returns owned PCM if dispatch fails before transferring it', async () => {
    const audioCache = createBeatAudioCache()
    const worker = new MockWorker()
    worker.postMessage.mockImplementation(() => {
      throw new Error('postMessage failed')
    })
    const first = harness({ audioCache, createWorker: () => worker as unknown as Worker })
    await expect(first.promise).rejects.toThrow('postMessage failed')
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(audioCache.pcmEntries).toBe(1)
    const second = harness({ audioCache })
    await flushPromises()
    expect(second.fetcher).not.toHaveBeenCalled()
    expect(second.decode).not.toHaveBeenCalled()
    second.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await second.promise
  })

  it('posts cooperative yield and the latest requested buffer, then removes both subscriptions', async () => {
    let yieldWork!: () => void
    let prioritize!: (playback: BeatPlaybackState) => void
    let bufferSeconds = 20
    const unsubscribeYield = vi.fn()
    const unsubscribePriority = vi.fn()
    const h = harness({
      getBufferSeconds: () => bufferSeconds,
      subscribeYield: (listener) => {
        yieldWork = listener
        return unsubscribeYield
      },
      subscribePriority: (listener) => {
        prioritize = listener
        return unsubscribePriority
      },
    })
    await flushPromises()
    expect(h.worker.postMessage.mock.calls[0]![0].bufferSeconds).toBe(20)
    bufferSeconds = 60
    prioritize({ timeSeconds: 0.1, playing: true, playbackRate: 1, seeking: false })
    expect(h.worker.postMessage).toHaveBeenLastCalledWith({
      type: 'prioritize',
      timeSeconds: 0.1,
      playing: true,
      playbackRate: 1,
      seeking: false,
      bufferSeconds: 60,
    })
    yieldWork()
    expect(h.worker.postMessage).toHaveBeenLastCalledWith({ type: 'yield' })
    h.worker.reply({
      type: 'buffered',
      checkpoint: fixtureCheckpoint(),
      audio: transferAudio(h.worker),
    })
    await h.promise
    expect(unsubscribeYield).toHaveBeenCalledTimes(1)
    expect(unsubscribePriority).toHaveBeenCalledTimes(1)
    const count = h.worker.postMessage.mock.calls.length
    yieldWork()
    expect(h.worker.postMessage).toHaveBeenCalledTimes(count)
  })

  it('rejects callback failures and still terminates the session instead of leaving a pending job', async () => {
    const unsubscribeYield = vi.fn()
    const h = harness({
      onCheckpoint: () => {
        throw new Error('checkpoint callback failed')
      },
      subscribeYield: () => unsubscribeYield,
    })
    const rejected = expect(h.promise).rejects.toThrow('checkpoint callback failed')
    await flushPromises()
    h.worker.reply({
      type: 'partial',
      checkpoint: fixtureCheckpoint(),
      timeline: fixtureTimeline(),
      progress: 0.4,
    })
    await rejected
    expect(h.worker.terminate).toHaveBeenCalledTimes(1)
    expect(unsubscribeYield).toHaveBeenCalledTimes(1)
  })

  it('discards an encoded cache entry after a decoding failure so explicit retry can fetch again', async () => {
    const audioCache = createBeatAudioCache()
    const first = harness({
      audioCache,
      decode: async () => {
        throw new Error('corrupt')
      },
    })
    await expect(first.promise).rejects.toThrow('无法解码')
    expect(audioCache.encodedEntries).toBe(0)
    const second = harness({ audioCache })
    await flushPromises()
    expect(second.fetcher).toHaveBeenCalledTimes(1)
    second.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await second.promise
  })

  it('reads the latest playhead after decoding and reprioritizes without fetching or rebuilding', async () => {
    const decoded = deferred<AudioBuffer>()
    let playhead = 0.1
    let prioritize!: (playback: BeatPlaybackState) => void
    const unsubscribe = vi.fn()
    const decode = vi.fn(() => decoded.promise)
    const h = harness({
      decode,
      getPrioritySeconds: () => playhead,
      getPlaybackState: () => ({
        timeSeconds: playhead,
        playing: true,
        playbackRate: 2,
        seeking: false,
      }),
      subscribePriority: (listener) => {
        prioritize = listener
        return unsubscribe
      },
    })
    await flushPromises()
    playhead = 0.6
    decoded.resolve(audioBuffer())
    await flushPromises()
    expect(h.worker.postMessage.mock.calls[0]![0]).toMatchObject({
      type: 'build',
      prioritySeconds: 0.6,
      playback: { timeSeconds: 0.6, playing: true, playbackRate: 2, seeking: false },
    })
    prioritize({ timeSeconds: 0.8, playing: false, playbackRate: 2, seeking: true })
    expect(h.worker.postMessage).toHaveBeenLastCalledWith({
      type: 'prioritize',
      timeSeconds: 0.8,
      playing: false,
      playbackRate: 2,
      seeking: true,
    })
    expect(h.fetcher).toHaveBeenCalledTimes(1)
    expect(decode).toHaveBeenCalledTimes(1)
    expect(h.createWorker).toHaveBeenCalledTimes(1)
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    const messages = h.worker.postMessage.mock.calls.length
    prioritize({ timeSeconds: 0.2, playing: false, playbackRate: 1, seeking: false })
    expect(h.worker.postMessage).toHaveBeenCalledTimes(messages)
  })

  it('reports disjoint completed coverage and the active range without claiming the gaps', async () => {
    const h = harness({ durationSeconds: 2 })
    await flushPromises()
    const completedRanges = [
      { startSeconds: 0.2, endSeconds: 0.4 },
      { startSeconds: 0.7, endSeconds: 0.9 },
    ]
    const activeRange = { startSeconds: 0.4, endSeconds: 0.7 }
    h.worker.reply({
      type: 'partial',
      timeline: { ...fixtureTimeline(), completedRanges },
      progress: 0.6,
      activeRange,
    })
    const status = h.onStatus.mock.lastCall![0]
    expect(status.availableSeconds).toBeCloseTo(0.4)
    expect(status).toMatchObject({ durationSeconds: 1, completedRanges, activeRange })
    h.worker.reply({ type: 'progress', progress: 0.7, activeRange })
    expect(h.onStatus.mock.lastCall![0].completedRanges).toEqual(completedRanges)
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
  })

  it('unsubscribes priority messages on abort and preserves worker cancellation cleanup', async () => {
    const unsubscribe = vi.fn()
    const h = harness({ subscribePriority: () => unsubscribe })
    const rejected = expect(h.promise).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    h.controller.abort()
    await rejected
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(h.worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('reports partial coverage without resolving or terminating the ongoing worker', async () => {
    const onPartial = vi.fn()
    const h = harness({ onPartial })
    await flushPromises()
    const timeline = { ...fixtureTimeline(), builtUntilSeconds: 0.5 }
    h.worker.reply({ type: 'partial', timeline, progress: 0.5 })
    expect(onPartial).toHaveBeenCalledWith(timeline)
    expect(h.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'analysing',
        progress: 0.5,
        error: null,
        availableSeconds: 0.5,
        durationSeconds: 1,
        completedRanges: [{ startSeconds: 0, endSeconds: 0.5 }],
      }),
    )
    expect(h.worker.terminate).not.toHaveBeenCalled()
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
    expect(h.worker.terminate).toHaveBeenCalledTimes(1)
  })
  it('reads only the chosen cached model and transfers its runtime with the audio', async () => {
    const model = {
      model: new ArrayBuffer(8),
      filterbank: new ArrayBuffer(4),
      wasmBinary: new ArrayBuffer(8),
      wasmPaths: { mjs: '/models/runtime.mjs' },
    }
    const readModel = vi.fn().mockResolvedValue(model)
    const h = harness({ modelId: 'standard', readModel })
    await flushPromises()
    expect(readModel).toHaveBeenCalledWith('standard', expect.any(AbortSignal))
    expect(h.onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'loading-model', progress: 0, error: null }),
    )
    const [request, transfer] = h.worker.postMessage.mock.calls[0]!
    expect(request).toMatchObject({ modelId: 'standard', ...model })
    expect(transfer).toContain(model.model)
    expect(transfer).toContain(model.wasmBinary)
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
  })

  it('cancels parallel audio preparation when its selected model is missing, without starting inference', async () => {
    const readModel = vi.fn().mockRejectedValue(new Error('请先下载模型'))
    const h = harness({ modelId: 'small', readModel })
    await expect(h.promise).rejects.toThrow('请先下载模型')
    expect(h.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it.each([undefined, 0, NaN, Infinity, 601])(
    'rejects invalid or excessive duration %s before fetching and decoding',
    async (durationSeconds) => {
      const h = harness({ durationSeconds })
      await expect(h.promise).rejects.toThrow(/时长|过长/)
      expect(h.fetcher).not.toHaveBeenCalled()
      expect(h.decode).not.toHaveBeenCalled()
      expect(h.createWorker).not.toHaveBeenCalled()
    },
  )

  it('honors application transport injection when no per-build fetcher is supplied', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1])))
    setHttpFetcher(fetcher)
    const h = harness({ fetcher: undefined })
    await flushPromises()
    expect(fetcher).toHaveBeenCalledWith(
      '/song.mp3',
      expect.objectContaining({ headers: { Accept: 'audio/*' } }),
    )
    h.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await h.promise
  })

  it('reads full audio with HTTP caching, transfers PCM and publishes only completed output', async () => {
    const h = harness()
    let completed = false
    void h.promise.then(() => {
      completed = true
    })
    await flushPromises()
    expect(h.fetcher).toHaveBeenCalledWith('/song.mp3', {
      signal: expect.any(AbortSignal),
      cache: 'default',
      headers: { Accept: 'audio/*' },
    })
    expect(new Uint8Array(h.decode.mock.calls[0]![0])).toEqual(new Uint8Array([1, 2, 3]))
    const [request, transfer] = h.worker.postMessage.mock.calls[0]!
    expect(request.type).toBe('build')
    expect(request.sampleRate).toBe(48000)
    expect(request.channels[0][0]).toBe(0.5)
    expect(request.channels[1][0]).toBe(-0.25)
    expect(transfer).toEqual(request.channels.map((samples: Float32Array) => samples.buffer))
    h.worker.reply({ type: 'progress', progress: 0.5 })
    await flushPromises()
    expect(completed).toBe(false)
    expect(h.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'analysing', progress: 0.5, error: null }),
    )
    const timeline = fixtureTimeline()
    h.worker.reply({ type: 'complete', timeline })
    await expect(h.promise).resolves.toBe(timeline)
    expect(h.worker.terminate).toHaveBeenCalledTimes(1)
  })

  it.each([
    [206, 'audio/mpeg', '无法完整读取'],
    [200, 'text/html', '不提供完整音频'],
    [200, 'application/vnd.apple.mpegurl', '不提供完整音频'],
  ])(
    'rejects unsupported complete-file responses (%s %s)',
    async (status, contentType, message) => {
      const h = harness({
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response('payload', { status, headers: { 'content-type': contentType } }),
          ),
      })
      await expect(h.promise).rejects.toThrow(message)
      expect(h.decode).not.toHaveBeenCalled()
      expect(h.createWorker).not.toHaveBeenCalled()
    },
  )

  it('enforces the streamed byte limit even when content-length is absent', async () => {
    const h = harness({
      maxAudioBytes: 4,
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(5))),
    })
    await expect(h.promise).rejects.toThrow('文件较大')
    expect(h.decode).not.toHaveBeenCalled()
  })

  it('rejects excessive declared size before reading or decoding', async () => {
    const h = harness({
      maxAudioBytes: 4,
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('x', { headers: { 'content-length': '5' } })),
    })
    await expect(h.promise).rejects.toThrow('文件较大')
    expect(h.decode).not.toHaveBeenCalled()
  })

  it('stops promptly when cancelled during native decode and ignores its late result', async () => {
    const decoded = deferred<AudioBuffer>()
    const h = harness({ decode: () => decoded.promise })
    const rejected = expect(h.promise).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    h.controller.abort()
    await rejected
    decoded.resolve(audioBuffer())
    await flushPromises()
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('does not start native decoding after cancellation in the preceding microtask', async () => {
    const controller = new AbortController()
    const decode = vi.fn<(data: ArrayBuffer) => Promise<AudioBuffer>>()
    const promise = buildBeatTimeline(
      '/song.mp3',
      controller.signal,
      (status) => {
        if (status.phase === 'decoding') queueMicrotask(() => controller.abort())
      },
      {
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([1]))),
        durationSeconds: 1,
        decode,
        audioCache: createBeatAudioCache(),
      },
    )
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(decode).not.toHaveBeenCalled()
  })

  it('serializes native decoding across cancellation and skips abandoned queued jobs', async () => {
    const firstDecoded = deferred<AudioBuffer>()
    const decode = vi
      .fn<(data: ArrayBuffer) => Promise<AudioBuffer>>()
      .mockReturnValueOnce(firstDecoded.promise)
      .mockResolvedValue(audioBuffer())
    const first = harness({ decode })
    const firstRejected = expect(first.promise).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    first.controller.abort()
    await firstRejected
    const abandoned = harness({ decode })
    const abandonedRejected = expect(abandoned.promise).rejects.toMatchObject({
      name: 'AbortError',
    })
    await flushPromises()
    abandoned.controller.abort()
    await abandonedRejected
    const latest = harness({ decode })
    await flushPromises()
    expect(decode).toHaveBeenCalledTimes(1)
    firstDecoded.resolve(audioBuffer())
    await flushPromises()
    expect(decode).toHaveBeenCalledTimes(2)
    expect(first.createWorker).not.toHaveBeenCalled()
    expect(abandoned.createWorker).not.toHaveBeenCalled()
    latest.worker.reply({ type: 'complete', timeline: fixtureTimeline() })
    await latest.promise
  })

  it('terminates a worker on cancellation and detaches every callback', async () => {
    const h = harness()
    const rejected = expect(h.promise).rejects.toMatchObject({ name: 'AbortError' })
    await flushPromises()
    h.controller.abort()
    await rejected
    expect(h.worker.terminate).toHaveBeenCalledTimes(1)
    expect(h.worker.onmessage).toBeNull()
    expect(h.worker.onerror).toBeNull()
  })

  it('bounds native decoding and worker work with independent deadlines', async () => {
    vi.useFakeTimers()
    const decode = harness({ decode: () => new Promise(() => {}), decodeTimeoutMs: 30 })
    const decodeRejected = expect(decode.promise).rejects.toThrow('音频解码超时')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(31)
    await decodeRejected
    expect(decode.createWorker).not.toHaveBeenCalled()

    const analysis = harness({ analysisTimeoutMs: 40 })
    const analysisRejected = expect(analysis.promise).rejects.toThrow('高亮构建超时')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(41)
    await analysisRejected
    expect(analysis.worker.terminate).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts the audio transfer when its download deadline expires', async () => {
    vi.useFakeTimers()
    const fetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        )
      })
    const h = harness({ fetcher, fetchTimeoutMs: 25 })
    const rejected = expect(h.promise).rejects.toThrow('读取音频超时')
    await vi.advanceTimersByTimeAsync(26)
    await rejected
    expect(h.createWorker).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects decoded files over the duration limit before allocating transferred PCM', async () => {
    const decoded = audioBuffer({ duration: 1201 })
    const h = harness({ decode: async () => decoded })
    await expect(h.promise).rejects.toThrow('过长')
    expect(decoded.copyFromChannel).not.toHaveBeenCalled()
    expect(h.createWorker).not.toHaveBeenCalled()
  })

  it('reports worker failures without exposing raw implementation messages', async () => {
    const h = harness()
    const rejected = expect(h.promise).rejects.toThrow('高亮构建失败')
    await flushPromises()
    h.worker.reply({ type: 'error', message: 'Internal stack or model details' })
    await rejected
    expect(h.worker.terminate).toHaveBeenCalledTimes(1)
  })
})
