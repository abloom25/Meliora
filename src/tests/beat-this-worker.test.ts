import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BeatThisBuildRequest,
  BeatThisRequest,
  BeatThisResponse,
} from '../core/analysis/beat-this-protocol'
import type { BeatThisFeaturesBuilder } from '../core/analysis/beat-this-features'
import type { BeatPlaybackState } from '../core/analysis/beat-scheduling'

const runtime = vi.hoisted(() => ({
  badGpu: false,
  badWasm: false,
  failGpuSong: false,
  failGpuAfter: 0,
  nonfiniteGpuAfter: 0,
  rejectWasm: false,
  probeWait: null as Promise<void> | null,
  songWait: null as Promise<void> | null,
  releaseWait: null as Promise<void> | null,
  onSong: null as (() => void) | null,
  clock: 0,
  probeMs: 0,
  createMs: 0,
  songMs: 0,
  featureMs: 0,
  workDurations: [] as number[],
  fast: false,
  cancel: null as (() => void) | null,
  sessions: [] as Array<{
    backend: string
    run: ReturnType<typeof vi.fn>
    release: ReturnType<typeof vi.fn>
  }>,
  inputs: [] as Array<{ data: Float32Array; dims: number[]; dispose: ReturnType<typeof vi.fn> }>,
  outputs: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
  featureBuilders: [] as BeatThisFeaturesBuilder[],
  featureBatches: [] as number[],
  env: {
    wasm: {
      numThreads: 0,
      proxy: true,
      wasmPaths: undefined as unknown,
      wasmBinary: undefined as unknown,
    },
  },
}))

vi.mock('../core/analysis/beat-timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/analysis/beat-timeline')>()
  return {
    ...actual,
    createBeatTimelineBuilder: (...args: Parameters<typeof actual.createBeatTimelineBuilder>) => {
      if (!runtime.fast) return actual.createBeatTimelineBuilder(...args)
      const duration = args[0][0]!.length / args[1]
      const snapshot = () => actual.createBeatTimelineBuffer(duration)
      return { process: () => 1, snapshot, finish: snapshot }
    },
  }
})

vi.mock('../core/analysis/beat-scheduling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/analysis/beat-scheduling')>()
  return {
    ...actual,
    createBeatSchedulingController: (
      ...args: Parameters<typeof actual.createBeatSchedulingController>
    ) => {
      const work = actual.createBeatSchedulingController(...args)
      const observe = work.observeWorkDuration
      work.observeWorkDuration = (duration) => {
        runtime.workDurations.push(duration)
        observe(duration)
      }
      return work
    },
  }
})

vi.mock('../core/analysis/beat-this-features', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/analysis/beat-this-features')>()
  return {
    ...actual,
    createBeatThisFeaturesBuilder: (
      ...args: Parameters<typeof actual.createBeatThisFeaturesBuilder>
    ) => {
      // Window scheduling needs cached-frame accounting, not repeated FFT work.
      // The original parity/integration tests keep the real frontend enabled.
      const builder: BeatThisFeaturesBuilder = (() => {
        if (!runtime.fast) return actual.createBeatThisFeaturesBuilder(...args)
        if (!args[0][0]?.length) throw new Error('音频声道数据无效')
        const frames = Math.floor((args[0][0].length / args[1]) * 50) + 1
        const ready = new Uint8Array(frames)
        let processed = 0
        const processRange = (start: number, end: number, maxFrames: number) => {
          let count = 0
          let done = 0
          start = Math.max(0, start)
          end = Math.min(frames, end)
          for (let index = start; index < end; index++) {
            if (!ready[index] && count < maxFrames) {
              ready[index] = 1
              count += 1
              processed += 1
            }
            done += ready[index]!
          }
          return end > start ? done / (end - start) : 1
        }
        return {
          frames,
          get processedFrames() {
            return processed
          },
          process: (maxFrames) => processRange(0, frames, maxFrames),
          processRange,
          chunk: (_start, count) => new Float32Array(count * 128),
          view: () => ({ frames, data: new Float32Array(0) }),
          finish: () => {
            if (processed !== frames) throw new Error('Unfinished feature frames')
            return { frames, data: new Float32Array(0) }
          },
        }
      })()
      const process = builder.process
      builder.process = (frames) => {
        runtime.featureBatches.push(frames)
        return process(frames)
      }
      const processRange = builder.processRange
      builder.processRange = (start, end, frames) => {
        runtime.featureBatches.push(frames)
        runtime.clock += runtime.featureMs
        return processRange(start, end, frames)
      }
      runtime.featureBuilders.push(builder)
      return builder
    },
  }
})

vi.mock('../core/analysis/beat-this-probes', () => ({
  BEAT_THIS_PROBES: {
    small: { beat: new Array(32).fill(3), downbeat: new Array(32).fill(4) },
    standard: { beat: new Array(32).fill(3), downbeat: new Array(32).fill(4) },
  },
}))

vi.mock('onnxruntime-web/all', () => ({
  env: runtime.env,
  Tensor: class {
    readonly dispose = vi.fn()
    readonly type: string
    readonly data: Float32Array
    readonly dims: number[]
    constructor(type: string, data: Float32Array, dims: number[]) {
      this.type = type
      this.data = data
      this.dims = dims
      runtime.inputs.push(this)
    }
  },
  InferenceSession: {
    create: vi.fn(async (_model: ArrayBuffer, options: { executionProviders: string[] }) => {
      runtime.clock += runtime.createMs
      const backend = options.executionProviders[0]!
      if (backend === 'wasm' && runtime.rejectWasm) throw new Error('CPU inference unavailable')
      let runs = 0
      const session = {
        backend,
        inputNames: ['spect'],
        outputNames: ['beat', 'downbeat'],
        release: vi.fn(async () => {
          if (backend === 'wasm') await runtime.releaseWait
        }),
        run: vi.fn(async () => {
          runs += 1
          runtime.clock += runs === 1 ? runtime.probeMs : runtime.songMs
          if (runs > 1) {
            runtime.onSong?.()
            if (runtime.songWait) {
              const pending = runtime.songWait
              runtime.songWait = null
              await pending
            }
          }
          if (runs === 1 && runtime.probeWait) {
            const pending = runtime.probeWait
            runtime.probeWait = null
            await pending
          }
          if (
            runs > 1 &&
            backend === 'webgpu' &&
            (runtime.failGpuSong || (runtime.failGpuAfter > 0 && runs > runtime.failGpuAfter))
          )
            throw new Error('GPU device lost')
          const invalid = backend === 'webgpu' ? runtime.badGpu : runtime.badWasm
          const output = (value: number) => {
            const tensor = {
              data: new Float32Array(1500).fill(runs === 1 ? (invalid ? 0 : value) : -1),
              dispose: vi.fn(),
            }
            runtime.outputs.push(tensor)
            return tensor
          }
          const beat = output(3)
          const downbeat = output(4)
          if (runs > 1) {
            for (let frame = 8; frame < 1500; frame += 25) beat.data[frame] = 4
          }
          if (
            backend === 'webgpu' &&
            runtime.nonfiniteGpuAfter > 0 &&
            runs > runtime.nonfiniteGpuAfter
          )
            beat.data[100] = Number.NaN
          return { beat, downbeat }
        }),
      }
      runtime.sessions.push(session)
      return session
    }),
  },
}))

async function loadWorker() {
  const responses: BeatThisResponse[] = []
  const transfers: Transferable[][] = []
  const computedFrames: number[] = []
  let listener: ((message: BeatThisResponse) => void) | null = null
  const scope = {
    onmessage: null as ((event: MessageEvent<BeatThisRequest>) => void) | null,
    postMessage(message: BeatThisResponse, options: { transfer: Transferable[] }) {
      responses.push(message)
      transfers.push(options.transfer)
      computedFrames.push(runtime.featureBuilders.at(-1)?.processedFrames ?? 0)
      listener?.(message)
    },
  }
  vi.stubGlobal('self', scope)
  await import('../workers/beat-this.worker')
  runtime.cancel = () => {
    listener = null
    scope.onmessage?.(
      new MessageEvent<BeatThisRequest>('message', {
        data: {
          type: 'build',
          channels: [],
          sampleRate: 8000,
          modelId: 'small',
          model: new ArrayBuffer(0),
          filterbank: new ArrayBuffer(0),
          wasmBinary: new ArrayBuffer(0),
        },
      }),
    )
  }
  const send = (
    seconds = 0.1,
    prioritySeconds = 0,
    playback?: BeatPlaybackState,
    options: Pick<
      Partial<BeatThisBuildRequest>,
      'bufferSeconds' | 'maxWindows' | 'checkpoint'
    > = {},
  ) => {
    const request: BeatThisRequest = {
      type: 'build',
      modelId: 'small',
      channels: [new Float32Array(Math.round(22050 * seconds))],
      sampleRate: 22050,
      model: new ArrayBuffer(8),
      filterbank: new Float32Array(513 * 128).buffer,
      wasmBinary: new ArrayBuffer(8),
      wasmPaths: { mjs: 'https://example.test/ort.mjs' },
      prioritySeconds,
      playback,
      ...options,
    }
    scope.onmessage?.({ data: request } as MessageEvent<BeatThisRequest>)
    return request
  }
  const prioritize = (
    timeSeconds: number,
    state: Partial<BeatPlaybackState> & { bufferSeconds?: number } = {},
  ) =>
    scope.onmessage?.({
      data: { type: 'prioritize', timeSeconds, ...state },
    } as MessageEvent<BeatThisRequest>)
  const onResponse = (callback: (message: BeatThisResponse) => void) => {
    listener = callback
  }
  const yieldBuild = () =>
    scope.onmessage?.({ data: { type: 'yield' } } as MessageEvent<BeatThisRequest>)
  return { responses, transfers, computedFrames, send, prioritize, onResponse, yieldBuild }
}

async function flush() {
  await vi.runAllTimersAsync()
  await vi.dynamicImportSettled()
  await vi.runAllTimersAsync()
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  runtime.badGpu = false
  runtime.badWasm = false
  runtime.failGpuSong = false
  runtime.failGpuAfter = 0
  runtime.nonfiniteGpuAfter = 0
  runtime.rejectWasm = false
  runtime.probeWait = null
  runtime.songWait = null
  runtime.releaseWait = null
  runtime.onSong = null
  runtime.clock = 0
  runtime.probeMs = 0
  runtime.createMs = 0
  runtime.songMs = 0
  runtime.featureMs = 0
  runtime.workDurations.length = 0
  runtime.fast = false
  runtime.cancel = null
  vi.spyOn(performance, 'now').mockImplementation(() => runtime.clock)
  runtime.sessions.length = 0
  runtime.inputs.length = 0
  runtime.outputs.length = 0
  runtime.featureBuilders.length = 0
  runtime.featureBatches.length = 0
})

afterEach(async () => {
  runtime.cancel?.()
  await vi.runAllTimersAsync()
  await vi.dynamicImportSettled()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Beat This! worker lifecycle and inference validation', () => {
  it('includes repeated model initialization and validation in bounded refill estimates', async () => {
    runtime.fast = true
    runtime.createMs = 2000
    runtime.probeMs = 1000
    runtime.songMs = 3000
    const worker = await loadWorker()
    worker.send(100, 0, undefined, { bufferSeconds: 20, maxWindows: 1 })
    await flush()
    expect(runtime.workDurations).toEqual([6000])
    expect(worker.responses.at(-1)).toMatchObject({
      type: 'buffered',
      checkpoint: { estimatedWorkMs: 5250 },
    })
  })

  it('finishes asynchronous session disposal before reporting an inference error', async () => {
    runtime.fast = true
    runtime.badGpu = true
    runtime.badWasm = true
    let released!: () => void
    runtime.releaseWait = new Promise<void>((resolve) => {
      released = resolve
    })
    const worker = await loadWorker()
    worker.send(100, 0, undefined, { bufferSeconds: 20 })
    await flush()
    expect(runtime.sessions[1]!.release).toHaveBeenCalledOnce()
    expect(worker.responses.some((message) => message.type === 'error')).toBe(false)
    released()
    await flush()
    expect(worker.responses.at(-1)).toMatchObject({ type: 'error' })
    expect(runtime.sessions.every((session) => session.release.mock.calls.length === 1)).toBe(true)
  })

  it('buffers one intro window and restores it at the next boundary without repeating its inference', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    const request = worker.send(100, 0, undefined, { bufferSeconds: 20, maxWindows: 1 })
    await flush()
    const first = worker.responses.at(-1)!
    expect(first.type).toBe('buffered')
    if (first.type !== 'buffered') throw new Error('Missing checkpoint')
    expect(first.checkpoint.completedWindows).toEqual([0])
    expect(first.checkpoint.timeline.completedRanges).toEqual([
      { startSeconds: 0, endSeconds: 23.75 },
    ])
    expect(first.checkpoint.seams).toHaveLength(1)
    expect(first.audio.channels[0]).toBe(request.channels[0])
    expect(worker.transfers.at(-1)).toContain(request.channels[0]!.buffer)
    expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(2)
    expect(runtime.sessions[0]!.release).toHaveBeenCalledOnce()
    worker.send(100, 24, undefined, {
      bufferSeconds: 20,
      maxWindows: 3,
      checkpoint: first.checkpoint,
    })
    await flush()
    const second = worker.responses.at(-1)!
    if (second.type !== 'buffered') throw new Error('Missing resumed checkpoint')
    expect(second.checkpoint.completedWindows).toEqual([0, 1])
    expect(second.checkpoint.timeline.completedRanges).toEqual([
      { startSeconds: 0, endSeconds: 47.75 },
    ])
    expect(runtime.sessions[1]!.run).toHaveBeenCalledTimes(2)
    expect(runtime.featureBuilders[1]!.processedFrames).toBe(1500)
    const count = runtime.sessions.length
    worker.send(100, 25, undefined, { bufferSeconds: 15, checkpoint: second.checkpoint })
    await flush()
    expect(worker.responses.at(-1)?.type).toBe('buffered')
    expect(runtime.sessions).toHaveLength(count) // already enough: no model initialization
  })

  it('repairs a left seam after restoring a middle-only checkpoint at exactly 24 seconds', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    worker.send(100, 30, undefined, { bufferSeconds: 15, maxWindows: 1 })
    await flush()
    const middle = worker.responses.at(-1)!
    if (middle.type !== 'buffered') throw new Error('Missing middle checkpoint')
    expect(middle.checkpoint.completedWindows).toEqual([1])
    worker.send(100, 24, undefined, { bufferSeconds: 10, checkpoint: middle.checkpoint })
    await flush()
    const repaired = worker.responses.at(-1)!
    if (repaired.type !== 'buffered') throw new Error('Missing repaired checkpoint')
    expect(repaired.checkpoint.completedWindows).toEqual([0, 1])
    expect(repaired.checkpoint.timeline.completedRanges).toEqual([
      { startSeconds: 0, endSeconds: 47.75 },
    ])
    expect(runtime.sessions[1]!.run).toHaveBeenCalledTimes(2)
  })

  it('respects the per-batch window limit and publishes restartable checkpoints after each finished window', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    worker.send(100, 0, undefined, { bufferSeconds: 60, maxWindows: 1 })
    await flush()
    const first = worker.responses.at(-1)!
    if (first.type !== 'buffered') throw new Error('Missing checkpoint')
    expect(first.checkpoint.completedWindows).toEqual([0])
    const published = worker.responses.find((message) => message.type === 'partial')
    expect(published?.checkpoint?.completedWindows).toEqual([0])
    expect(published?.timeline).toBe(published?.checkpoint?.timeline)
    worker.send(100, 0, undefined, { bufferSeconds: 60, checkpoint: first.checkpoint })
    await flush()
    const second = worker.responses.at(-1)!
    if (second.type !== 'buffered') throw new Error('Missing checkpoint')
    expect(second.checkpoint.completedWindows).toEqual([0, 1, 2])
    expect(runtime.sessions[1]!.run).toHaveBeenCalledTimes(3) // probe + only two missing windows
  })

  it.each(['preprocessing', 'inference'] as const)(
    'yields during %s without discarding completed model windows',
    async (stage) => {
      runtime.fast = true
      const worker = await loadWorker()
      let sent = false
      if (stage === 'preprocessing')
        worker.onResponse((message) => {
          if (!sent && message.type === 'progress' && runtime.featureBatches.length > 0) {
            sent = true
            worker.yieldBuild()
          }
        })
      else
        runtime.onSong = () => {
          if (!sent) {
            sent = true
            worker.yieldBuild()
          }
        }
      worker.send(100, 0, undefined, { bufferSeconds: 60 })
      await flush()
      const result = worker.responses.at(-1)!
      if (result.type !== 'buffered') throw new Error('Missing yielded checkpoint')
      expect(result.checkpoint.completedWindows).toEqual(stage === 'preprocessing' ? [] : [0])
      expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(stage === 'preprocessing' ? 1 : 2)
      expect(runtime.sessions[0]!.release).toHaveBeenCalledOnce()
      expect(result.audio.channels[0]!.length).toBe(22050 * 100)
    },
  )

  it('wakes a seek wait for yielding and can shrink the requested buffer before inference', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    worker.send(
      100,
      0,
      { timeSeconds: 0, playing: false, playbackRate: 1, seeking: true },
      { bufferSeconds: 60 },
    )
    await flush()
    worker.yieldBuild()
    await flush()
    expect(worker.responses.at(-1)).toMatchObject({
      type: 'buffered',
      checkpoint: { completedWindows: [] },
    })
    expect(vi.getTimerCount()).toBe(0)
    let shortened = false
    worker.onResponse((message) => {
      if (!shortened && message.type === 'progress') {
        shortened = true
        worker.prioritize(0, { bufferSeconds: 0 })
      }
    })
    worker.send(100, 0, undefined, { bufferSeconds: 60 })
    await flush()
    expect(worker.responses.at(-1)).toMatchObject({
      type: 'buffered',
      checkpoint: { completedWindows: [] },
    })
    expect(runtime.sessions[1]!.run).toHaveBeenCalledOnce()
  })

  it('reports real completion only when the bounded request covers the entire short song', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    worker.send(10, 0, undefined, { bufferSeconds: 20 })
    await flush()
    expect(worker.responses.at(-1)).toMatchObject({
      type: 'complete',
      audio: { sampleRate: 22050 },
    })
    expect(worker.transfers.at(-1)).toHaveLength(6)
  })

  it('uses measured slow-window work to prepare where playback will be when inference finishes', async () => {
    runtime.fast = true
    runtime.probeMs = 20_000
    runtime.songMs = 35_000
    const worker = await loadWorker()
    worker.send(144, 0, { timeSeconds: 0, playing: true, playbackRate: 1, seeking: false })
    await flush()
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
    const starts = worker.responses
      .filter((message) => message.type === 'partial')
      .map((message) => message.activeRange?.startSeconds)
    expect(starts.slice(0, 3)).toEqual([24, 72, 120])
    expect(runtime.workDurations).toHaveLength(6)
    expect(runtime.workDurations.every((duration) => duration === 35_000)).toBe(true)
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
  })

  it('suspends cheap preprocessing through a seek storm and reuses cached features after it settles', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    let dragging = false
    worker.onResponse((message) => {
      if (message.type === 'progress' && runtime.featureBatches.length > 0 && !dragging) {
        dragging = true
        worker.prioritize(2, { seeking: true })
      }
    })
    worker.send(80, 50)
    await flush()
    const before = runtime.featureBuilders[0]!.processedFrames
    expect(before).toBeGreaterThan(0)
    expect(runtime.sessions[0]!.run).toHaveBeenCalledOnce()
    for (const target of [75, 28, 68, 2]) {
      runtime.clock += 100_000
      worker.prioritize(target, { seeking: true })
      await flush()
      expect(runtime.featureBuilders[0]!.processedFrames).toBe(before)
      expect(vi.getTimerCount()).toBe(0)
    }
    worker.prioritize(2, { seeking: false })
    await flush()
    const first = worker.responses.find((message) => message.type === 'partial')
    expect(first).toMatchObject({ activeRange: { startSeconds: 0 } })
    expect(runtime.workDurations.every((duration) => duration === 0)).toBe(true)
    expect(runtime.sessions).toHaveLength(1)
    expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(5)
    expect(runtime.featureBuilders[0]!.processedFrames).toBe(runtime.featureBuilders[0]!.frames)
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
  })

  it('keeps an expensive inference already in flight but starts no new window during dragging', async () => {
    runtime.fast = true
    let finishSong!: () => void
    runtime.songWait = new Promise<void>((resolve) => {
      finishSong = resolve
    })
    const worker = await loadWorker()
    runtime.onSong = () => {
      runtime.onSong = null
      worker.prioritize(75, { seeking: true })
    }
    worker.send(80)
    await flush()
    expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(2)
    finishSong()
    await flush()
    expect(worker.responses.find((message) => message.type === 'partial')).toMatchObject({
      activeRange: { startSeconds: 0 },
      timeline: { completedRanges: [{ startSeconds: 0, endSeconds: 23.75 }] },
    })
    expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    worker.prioritize(75)
    await flush()
    const starts = worker.responses
      .filter((message) => message.type === 'partial')
      .map((message) => message.activeRange?.startSeconds)
    expect(starts.slice(0, 2)).toEqual([0, 72])
    expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(5)
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
  })

  it('keeps paused position fixed and applies a new playback speed to the next prediction', async () => {
    runtime.fast = true
    runtime.probeMs = 20_000
    runtime.songMs = 1000
    const worker = await loadWorker()
    let changed = false
    worker.onResponse((message) => {
      if (message.type === 'partial' && !changed) {
        changed = true
        worker.prioritize(30, { playing: true, playbackRate: 4 })
      }
    })
    worker.send(96, 30, { timeSeconds: 30, playing: false, playbackRate: 4, seeking: false })
    await flush()
    const starts = worker.responses
      .filter((message) => message.type === 'partial')
      .map((message) => message.activeRange?.startSeconds)
    expect(starts.slice(0, 2)).toEqual([24, 72])
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
  })

  it('does not starve slow preprocessing when normal timeupdate messages advance playback', async () => {
    runtime.fast = true
    runtime.featureMs = 500
    const worker = await loadWorker()
    worker.onResponse((message) => {
      if (message.type === 'progress')
        worker.prioritize(runtime.clock / 1000, { playing: true, playbackRate: 1 })
    })
    worker.send(80, 0, { timeSeconds: 0, playing: true, playbackRate: 1, seeking: false })
    await flush()
    const first = worker.responses.find((message) => message.type === 'partial')
    expect(first).toMatchObject({ activeRange: { startSeconds: 0 } })
    expect(runtime.workDurations[0]).toBe(30_000)
    expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(5)
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
  })

  it('publishes the first window before computing later audio features, with bounded preprocessing batches', async () => {
    const worker = await loadWorker()
    worker.send(65)
    await flush()
    const partialIndex = worker.responses.findIndex((message) => message.type === 'partial')
    const completeIndex = worker.responses.findIndex((message) => message.type === 'complete')
    expect(partialIndex).toBeGreaterThan(0)
    expect(completeIndex).toBeGreaterThan(partialIndex)
    const partial = worker.responses[partialIndex]!
    const complete = worker.responses[completeIndex]!
    if (partial.type !== 'partial' || complete.type !== 'complete')
      throw new Error('Missing partial timeline')
    expect(partial.timeline.completedRanges).toEqual([{ startSeconds: 0, endSeconds: 23.75 }])
    expect(partial.timeline.durationSeconds).toBe(65)
    expect(partial.progress).toBeLessThan(1)
    expect(complete.timeline.builtUntilSeconds).toBeUndefined()
    expect(worker.transfers[partialIndex]).toHaveLength(5)
    expect(
      worker.transfers[partialIndex]!.every(
        (buffer) => !worker.transfers[completeIndex]!.includes(buffer),
      ),
    ).toBe(true)
    expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(4) // probe, then three model windows
    expect(worker.computedFrames[partialIndex]).toBe(1494)
    expect(worker.computedFrames[partialIndex]).toBeLessThan(runtime.featureBuilders[0]!.frames / 2)
    expect(runtime.featureBatches.every((frames) => frames >= 1 && frames <= 25)).toBe(true)
    expect(runtime.featureBuilders[0]!.processedFrames).toBe(runtime.featureBuilders[0]!.frames)
  })

  it('starts from the requested middle region without touching earlier PCM', async () => {
    const worker = await loadWorker()
    const request = worker.send(90, 50)
    request.channels[0]![0] = Number.NaN // would fail any sequential warmup from song start
    await flush()
    const first = worker.responses.find((message) => message.type === 'partial')
    expect(first).toMatchObject({
      type: 'partial',
      activeRange: { startSeconds: 48, endSeconds: 72 },
    })
    if (first?.type !== 'partial') throw new Error('Missing middle timeline')
    expect(first.timeline.completedRanges).toEqual([{ startSeconds: 48.25, endSeconds: 71.75 }])
    expect(first.timeline.levels[0].length).toBe(5401)
    expect(first.timeline.builtUntilSeconds).toBe(0)
    expect(worker.responses.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('无效采样'),
    })
  })

  it('prioritizes a seek without reopening the model and eventually fills every region', async () => {
    const worker = await loadWorker()
    let seekSent = false
    worker.onResponse((message) => {
      if (message.type === 'partial' && !seekSent) {
        seekSent = true
        worker.prioritize(2)
      }
    })
    worker.send(80, 50)
    await flush()
    const partials = worker.responses.filter((message) => message.type === 'partial')
    expect(partials.map((message) => message.activeRange?.startSeconds)).toEqual([48, 0, 24])
    expect(runtime.sessions).toHaveLength(1)
    expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(5)
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
    const final = worker.responses.at(-1)!
    if (final.type !== 'complete') throw new Error('Missing completed timeline')
    expect(final.timeline.completedRanges).toBeUndefined()
    expect(runtime.featureBuilders[0]!.processedFrames).toBe(runtime.featureBuilders[0]!.frames)
  })

  it.each(['device-loss', 'nonfinite-output'])(
    'retains completed middle regions when a later GPU window has %s',
    async (failure) => {
      // The first song window succeeds; only the second encounters a driver failure.
      if (failure === 'device-loss') runtime.failGpuAfter = 2
      else runtime.nonfiniteGpuAfter = 2
      const worker = await loadWorker()
      worker.send(80, 50)
      await flush()
      const partials = worker.responses.filter((message) => message.type === 'partial')
      expect(partials.map((message) => message.activeRange?.startSeconds)).toEqual([48, 24, 72])
      expect(runtime.sessions.map((session) => session.backend)).toEqual(['webgpu', 'wasm'])
      expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(3)
      expect(runtime.sessions[1]!.run).toHaveBeenCalledTimes(4) // probe plus only the three remaining windows
      expect(worker.responses.at(-1)).toMatchObject({ type: 'complete', backend: 'wasm' })
      expect(partials[1]!.timeline.completedRanges).toEqual([
        { startSeconds: 24.25, endSeconds: 71.75 },
      ])
      expect(partials[0]!.timeline.levels[0].slice(2895, 4305)).toEqual(
        partials[1]!.timeline.levels[0].slice(2895, 4305),
      )
    },
  )

  it('runs a verified GPU session, preserves silence and transfers only the completed timeline', async () => {
    const worker = await loadWorker()
    const request = worker.send()
    expect(worker.responses).toHaveLength(0)
    await flush()
    expect(runtime.sessions.map((session) => session.backend)).toEqual(['webgpu'])
    expect(runtime.sessions[0]!.run).toHaveBeenCalledTimes(2)
    const complete = worker.responses.at(-1)
    expect(complete?.type).toBe('complete')
    if (complete?.type !== 'complete') throw new Error('Missing timeline')
    expect(complete.backend).toBe('webgpu')
    expect(complete.timeline.levels.every((values) => values.every((value) => value === 0))).toBe(
      true,
    )
    expect(worker.transfers.at(-1)).toEqual(
      [...complete.timeline.levels, complete.timeline.sustain].map((values) => values.buffer),
    )
    expect(runtime.env.wasm.numThreads).toBe(1)
    expect(runtime.env.wasm.proxy).toBe(false)
    expect(runtime.env.wasm.wasmPaths).toEqual(request.wasmPaths)
    expect(runtime.env.wasm.wasmBinary).toEqual(new Uint8Array(request.wasmBinary))
    expect(runtime.inputs[0]!.dims).toEqual([1, 1500, 128])
    expect(runtime.inputs[0]!.data[129]).toBe(54 / 32)
    expect(runtime.inputs.every((input) => input.dispose.mock.calls.length === 1)).toBe(true)
    expect(runtime.outputs.every((output) => output.dispose.mock.calls.length === 1)).toBe(true)
    expect(runtime.sessions[0]!.release).toHaveBeenCalledOnce()
  })

  it('rejects finite but incorrect GPU results and uses independently verified WASM inference', async () => {
    runtime.badGpu = true
    const worker = await loadWorker()
    worker.send()
    await flush()
    expect(runtime.sessions.map((session) => session.backend)).toEqual(['webgpu', 'wasm'])
    expect(runtime.sessions[0]!.run).toHaveBeenCalledOnce()
    expect(runtime.sessions[0]!.release).toHaveBeenCalledOnce()
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete', backend: 'wasm' })
  })

  it('retries the current prediction on WASM after GPU device loss and keeps progress monotonic', async () => {
    runtime.failGpuSong = true
    const worker = await loadWorker()
    worker.send()
    await flush()
    expect(runtime.sessions.map((session) => session.backend)).toEqual(['webgpu', 'wasm'])
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete', backend: 'wasm' })
    const progress = worker.responses.flatMap((message) =>
      message.type === 'progress' ? [message.progress] : [],
    )
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
  })

  it('reports failed inference rather than silently returning the basic timeline', async () => {
    runtime.badGpu = true
    runtime.badWasm = true
    const worker = await loadWorker()
    worker.send()
    await flush()
    expect(worker.responses.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('校验未通过'),
    })
    expect(worker.responses.some((message) => message.type === 'complete')).toBe(false)
    expect(runtime.sessions.every((session) => session.release.mock.calls.length === 1)).toBe(true)
  })

  it('drops stale asynchronous inference and disposes its session after a new generation starts', async () => {
    let resolveProbe!: () => void
    runtime.probeWait = new Promise<void>((resolve) => {
      resolveProbe = resolve
    })
    const worker = await loadWorker()
    worker.send(0.2)
    await flush()
    expect(runtime.sessions).toHaveLength(1)
    worker.send(0.1)
    await flush()
    resolveProbe()
    await flush()
    const complete = worker.responses.filter((message) => message.type === 'complete')
    expect(complete).toHaveLength(1)
    expect(complete[0]!.timeline.durationSeconds).toBe(0.1)
    expect(runtime.sessions.every((session) => session.release.mock.calls.length === 1)).toBe(true)
  })

  it('wakes and releases a generation suspended during seeking when a new build arrives', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    worker.send(80, 50, { timeSeconds: 50, playing: false, playbackRate: 1, seeking: true })
    await flush()
    expect(runtime.sessions[0]!.run).toHaveBeenCalledOnce()
    expect(runtime.featureBatches).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    worker.send(0.1)
    await flush()
    const complete = worker.responses.filter((message) => message.type === 'complete')
    expect(complete).toHaveLength(1)
    expect(complete[0]!.timeline.durationSeconds).toBe(0.1)
    expect(runtime.sessions.every((session) => session.release.mock.calls.length === 1)).toBe(true)
  })
})
