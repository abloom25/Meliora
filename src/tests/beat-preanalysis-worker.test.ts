import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  BeatPreanalysisRequest,
  BeatPreanalysisResponse,
  BeatPreanalysisBuildRequest,
} from '../core/analysis/beat-preanalysis-protocol'
import type { BeatPlaybackState } from '../core/analysis/beat-scheduling'

const runtime = vi.hoisted(() => ({
  clock: 0,
  batchMs: 0,
  batches: 0,
  durations: [] as number[],
  fast: false,
  cancel: null as (() => void) | null,
}))

vi.mock('../core/analysis/beat-timeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/analysis/beat-timeline')>()
  return {
    ...actual,
    createBeatTimelineBuilder: (...args: Parameters<typeof actual.createBeatTimelineBuilder>) => {
      // Scheduling tests control work duration, so a bounded stepper replaces FFT.
      // The original integration tests below still exercise the real analyser.
      const builder = (() => {
        if (!runtime.fast) return actual.createBeatTimelineBuilder(...args)
        const [channels, sampleRate, options] = args
        if (!channels[0]?.length) throw new Error('音频声道数据无效')
        const duration = channels[0].length / sampleRate
        const start = options?.startSeconds ?? 0
        const end = options?.endSeconds ?? duration
        const warmup = Math.max(0, Math.floor(start * 60) - 360)
        const frames = Math.floor(end * 60) - warmup + 1
        let processed = 0
        const snapshot = () => {
          const result = actual.createBeatTimelineBuffer(duration)
          const ready = Math.min(end, (warmup + processed - 1) / 60)
          result.completedRanges = ready > start ? [{ startSeconds: start, endSeconds: ready }] : []
          result.builtUntilSeconds = start === 0 ? Math.max(0, ready) : 0
          return result
        }
        return {
          process(maxFrames: number) {
            processed = Math.min(frames, processed + maxFrames)
            return processed / frames
          },
          snapshot,
          finish: snapshot,
        }
      })()
      const process = builder.process
      builder.process = (frames) => {
        runtime.clock += runtime.batchMs
        runtime.batches += 1
        return process(frames)
      }
      return builder
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
        runtime.durations.push(duration)
        observe(duration)
      }
      return work
    },
  }
})

async function loadWorker() {
  const responses: BeatPreanalysisResponse[] = []
  const transfers: Transferable[][] = []
  let listener: ((message: BeatPreanalysisResponse) => void) | null = null
  const scope = {
    onmessage: null as ((event: MessageEvent<BeatPreanalysisRequest>) => void) | null,
    postMessage(message: BeatPreanalysisResponse, options: { transfer: Transferable[] }): void {
      responses.push(message)
      transfers.push(options.transfer)
      listener?.(message)
    },
  }
  vi.stubGlobal('self', scope)
  await import('../workers/beat-preanalysis.worker')
  runtime.cancel = () => {
    listener = null
    scope.onmessage?.(
      new MessageEvent<BeatPreanalysisRequest>('message', {
        data: { type: 'build', channels: [], sampleRate: 8000 },
      }),
    )
  }
  return {
    responses,
    transfers,
    send(
      channels: Float32Array[],
      sampleRate = 48000,
      prioritySeconds = 0,
      playback?: BeatPlaybackState,
      options: Pick<
        Partial<BeatPreanalysisBuildRequest>,
        'bufferSeconds' | 'maxWindows' | 'checkpoint'
      > = {},
    ): void {
      scope.onmessage?.({
        data: { type: 'build', channels, sampleRate, prioritySeconds, playback, ...options },
      } as MessageEvent<BeatPreanalysisRequest>)
    },
    prioritize(
      timeSeconds: number,
      state: Partial<BeatPlaybackState> & { bufferSeconds?: number } = {},
    ): void {
      scope.onmessage?.({
        data: { type: 'prioritize', timeSeconds, ...state },
      } as MessageEvent<BeatPreanalysisRequest>)
    },
    onResponse(callback: (message: BeatPreanalysisResponse) => void): void {
      listener = callback
    },
    yieldBuild(): void {
      scope.onmessage?.({ data: { type: 'yield' } } as MessageEvent<BeatPreanalysisRequest>)
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  runtime.clock = 0
  runtime.batchMs = 0
  runtime.batches = 0
  runtime.durations.length = 0
  runtime.fast = false
  runtime.cancel = null
  vi.spyOn(performance, 'now').mockImplementation(() => runtime.clock)
})

afterEach(async () => {
  runtime.cancel?.()
  await vi.runAllTimersAsync()
  await vi.dynamicImportSettled()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('beat preanalysis worker', () => {
  it.each(['yield', 'seek'] as const)(
    'never stores unfinished display previews in checkpoints after %s',
    async (action) => {
      runtime.fast = true
      const worker = await loadWorker()
      let redirected = false
      worker.onResponse((message) => {
        if (
          !redirected &&
          message.type === 'partial' &&
          !message.checkpoint &&
          message.timeline.completedRanges?.length
        ) {
          redirected = true
          if (action === 'yield') worker.yieldBuild()
          else worker.prioritize(55)
        }
      })
      worker.send([new Float32Array(8000 * 100)], 8000, 0, undefined, {
        bufferSeconds: 10,
        maxWindows: 1,
      })
      await vi.runAllTimersAsync()
      const result = worker.responses.at(-1)!
      if (result.type !== 'buffered') throw new Error('Missing safe checkpoint')
      expect(result.checkpoint.completedWindows).toEqual(action === 'yield' ? [] : [5])
      expect(result.checkpoint.timeline.completedRanges).toEqual(
        action === 'yield' ? [] : [{ startSeconds: 50, endSeconds: 60 }],
      )
      for (const response of worker.responses)
        if (response.type === 'partial' && response.checkpoint)
          expect(response.checkpoint.timeline.completedRanges).toEqual([
            { startSeconds: 50, endSeconds: 60 },
          ])
    },
  )

  it('stops at a bounded goal, returns PCM and resumes only missing windows from a checkpoint', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    const channels = [new Float32Array(8000 * 100)]
    worker.send(channels, 8000, 0, undefined, { bufferSeconds: 20, maxWindows: 1 })
    await vi.runAllTimersAsync()
    const first = worker.responses.at(-1)!
    if (first.type !== 'buffered') throw new Error('Missing checkpoint')
    expect(first.checkpoint.completedWindows).toEqual([0])
    expect(first.checkpoint.timeline.completedRanges).toEqual([{ startSeconds: 0, endSeconds: 10 }])
    expect(first.audio.channels[0]).toBe(channels[0])
    expect(worker.transfers.at(-1)).toContain(channels[0]!.buffer)
    const batches = runtime.batches
    worker.send(channels, 8000, 0, undefined, { bufferSeconds: 20, checkpoint: first.checkpoint })
    await vi.runAllTimersAsync()
    const second = worker.responses.at(-1)!
    if (second.type !== 'buffered') throw new Error('Missing resumed checkpoint')
    expect(second.checkpoint.completedWindows).toEqual([0, 1])
    expect(second.checkpoint.timeline.completedRanges).toEqual([
      { startSeconds: 0, endSeconds: 20 },
    ])
    expect(runtime.batches - batches).toBe(17) // only 10..20 with its six-second warmup
    const readyBatches = runtime.batches
    worker.send(channels, 8000, 1, undefined, { bufferSeconds: 15, checkpoint: second.checkpoint })
    await vi.runAllTimersAsync()
    expect(runtime.batches).toBe(readyBatches)
    expect(worker.responses.at(-1)?.type).toBe('buffered')
  })

  it('can yield a seeking job immediately and keeps completed ranges when yielding between batches', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    const channels = [new Float32Array(8000 * 100)]
    worker.send(
      channels,
      8000,
      0,
      { timeSeconds: 0, playing: false, playbackRate: 1, seeking: true },
      { bufferSeconds: 60 },
    )
    await vi.runAllTimersAsync()
    worker.yieldBuild()
    await vi.runAllTimersAsync()
    expect(worker.responses.at(-1)).toMatchObject({
      type: 'buffered',
      checkpoint: { completedWindows: [] },
    })
    expect(runtime.batches).toBe(0)
    let yielded = false
    worker.onResponse((message) => {
      if (!yielded && message.type === 'partial' && message.checkpoint?.completedWindows.length) {
        yielded = true
        worker.yieldBuild()
      }
    })
    worker.send(channels, 8000, 0, undefined, { bufferSeconds: 60 })
    await vi.runAllTimersAsync()
    expect(worker.responses.at(-1)).toMatchObject({
      type: 'buffered',
      checkpoint: { completedWindows: [0] },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns a true full completion for short bounded songs and rejects mismatched checkpoints', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    worker.send([new Float32Array(8000 * 5)], 8000, 0, undefined, { bufferSeconds: 20 })
    await vi.runAllTimersAsync()
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete', audio: { sampleRate: 8000 } })
    worker.send([new Float32Array(8000 * 100)], 8000, 0, undefined, { bufferSeconds: 10 })
    await vi.runAllTimersAsync()
    const checkpoint = worker.responses.at(-1)!
    if (checkpoint.type !== 'buffered') throw new Error('Missing checkpoint')
    worker.send([new Float32Array(8000 * 90)], 8000, 0, undefined, {
      bufferSeconds: 10,
      checkpoint: checkpoint.checkpoint,
    })
    await vi.runAllTimersAsync()
    expect(worker.responses.at(-1)).toMatchObject({
      type: 'error',
      message: expect.stringContaining('不匹配'),
    })
  })

  it('moves ahead of playback when measured DSP work is slower than the audio', async () => {
    runtime.fast = true
    runtime.batchMs = 1000
    const worker = await loadWorker()
    worker.send([new Float32Array(8000 * 70)], 8000, 0, {
      timeSeconds: 0,
      playing: true,
      playbackRate: 1,
      seeking: false,
    })
    await vi.runAllTimersAsync()
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
    const starts = worker.responses.flatMap((message) =>
      'activeRange' in message && message.activeRange ? [message.activeRange.startSeconds] : [],
    )
    expect([...new Set(starts)].slice(0, 3)).toEqual([0, 20, 40])
    expect(runtime.durations[0]).toBe(11_000)
    expect(runtime.durations).toHaveLength(7)
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
  })

  it('waits through a drag storm without DSP batches or timers and resumes at the settled target', async () => {
    runtime.fast = true
    runtime.batchMs = 1000
    const worker = await loadWorker()
    let seeking = false
    worker.onResponse(() => {
      if (!seeking) {
        seeking = true
        worker.prioritize(25, { seeking: true })
      }
    })
    worker.send([new Float32Array(8000 * 45)], 8000, 25)
    await vi.runAllTimersAsync()
    const batches = runtime.batches
    for (const target of [35, 1, 40, 5]) {
      runtime.clock += 100_000
      worker.prioritize(target, { seeking: true })
      await vi.runAllTimersAsync()
      expect(runtime.batches).toBe(batches)
      expect(vi.getTimerCount()).toBe(0)
    }
    worker.prioritize(5)
    await vi.runAllTimersAsync()
    const firstReady = worker.responses.find(
      (message) => message.type === 'partial' && message.timeline.completedRanges?.length,
    )
    expect(firstReady).toMatchObject({ activeRange: { startSeconds: 0 } })
    expect(runtime.durations.every((duration) => duration < 20_000)).toBe(true)
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
  })

  it('uses pause and playback-rate updates without projecting a paused playhead forward', async () => {
    runtime.fast = true
    runtime.batchMs = 1000
    const worker = await loadWorker()
    let resumed = false
    worker.onResponse((message) => {
      if (
        message.type === 'partial' &&
        !resumed &&
        message.timeline.completedRanges?.some(
          (range) => range.startSeconds === 20 && range.endSeconds === 30,
        )
      ) {
        resumed = true
        worker.prioritize(25, { playing: true, playbackRate: 3 })
      }
    })
    worker.send([new Float32Array(8000 * 80)], 8000, 25, {
      timeSeconds: 25,
      playing: false,
      playbackRate: 3,
      seeking: false,
    })
    await vi.runAllTimersAsync()
    const starts = worker.responses.flatMap((message) =>
      'activeRange' in message && message.activeRange ? [message.activeRange.startSeconds] : [],
    )
    expect([...new Set(starts)].slice(0, 2)).toEqual([20, 70])
    expect(worker.responses.at(-1)).toMatchObject({ type: 'complete' })
  })

  it('keeps completed islands when preprocessing is redirected and releases a suspended generation', async () => {
    runtime.fast = true
    const worker = await loadWorker()
    let held = false
    worker.onResponse((message) => {
      if (
        message.type === 'partial' &&
        !held &&
        message.checkpoint &&
        message.timeline.completedRanges?.some(
          (range) => range.startSeconds === 20 && range.endSeconds > 20,
        )
      ) {
        held = true
        worker.prioritize(5, { seeking: true })
      }
    })
    worker.send([new Float32Array(8000 * 45)], 8000, 25)
    await vi.runAllTimersAsync()
    const saved = worker.responses.filter((message) => message.type === 'partial').at(-1)!
    expect(saved.timeline.completedRanges?.[0]?.startSeconds).toBe(20)
    worker.prioritize(5)
    await vi.runAllTimersAsync()
    const withHole = worker.responses.find(
      (message) => message.type === 'partial' && message.timeline.completedRanges?.length === 2,
    )
    expect(withHole).toMatchObject({
      type: 'partial',
      timeline: {
        completedRanges: [
          { startSeconds: 0, endSeconds: expect.any(Number) },
          saved.timeline.completedRanges![0],
        ],
      },
    })
    worker.send([new Float32Array(8000 * 45)], 8000, 25, {
      timeSeconds: 25,
      playing: false,
      playbackRate: 1,
      seeking: true,
    })
    await vi.runAllTimersAsync()
    worker.send([new Float32Array(800)], 8000)
    await vi.runAllTimersAsync()
    const completions = worker.responses.filter((message) => message.type === 'complete')
    expect(completions.map((message) => message.timeline.durationSeconds)).toEqual([45, 0.1])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('yields between batches and transfers a playable prefix before completion', async () => {
    const worker = await loadWorker()
    worker.send([new Float32Array(48000 * 2)])
    expect(worker.responses).toEqual([])
    await vi.advanceTimersToNextTimerAsync()
    expect(worker.responses.some((message) => message.type === 'complete')).toBe(false)
    expect(worker.responses[0]).toMatchObject({ type: 'partial', progress: 59 / 120 })
    const first = worker.responses[0]
    if (first?.type !== 'partial') throw new Error('Missing partial timeline')
    expect(first.timeline.builtUntilSeconds).toBeCloseTo(59 / 60)
    expect(first.timeline.levels[0].length).toBe(121)
    await vi.runAllTimersAsync()
    const completion = worker.responses.at(-1)
    expect(completion?.type).toBe('complete')
    if (completion?.type !== 'complete') throw new Error('Missing timeline')
    expect(completion.timeline.durationSeconds).toBe(2)
    expect(first.timeline.levels[0].length).toBe(121)
    expect(worker.transfers.at(-1)).toEqual(
      [...completion.timeline.levels, completion.timeline.sustain].map((values) => values.buffer),
    )
    expect(new Set(worker.transfers.at(-1)).size).toBe(5)
  })

  it('starts around playback and redirects unfinished warmup after a seek', async () => {
    const worker = await loadWorker()
    worker.send([new Float32Array(8000 * 45)], 8000, 25)
    await vi.advanceTimersToNextTimerAsync()
    expect(worker.responses[0]).toMatchObject({ activeRange: { startSeconds: 20, endSeconds: 30 } })
    worker.prioritize(5)
    await vi.runAllTimersAsync()
    const activeStarts = worker.responses.flatMap((response) =>
      'activeRange' in response && response.activeRange ? [response.activeRange.startSeconds] : [],
    )
    expect([...new Set(activeStarts)]).toEqual([20, 0, 10, 30, 40])
    const partials = worker.responses.filter((response) => response.type === 'partial')
    const firstReady = partials.find((response) => response.timeline.completedRanges?.length)
    expect(firstReady?.timeline.completedRanges?.[0]?.startSeconds).toBe(0)
    const complete = worker.responses.at(-1)
    expect(complete?.type).toBe('complete')
    if (complete?.type !== 'complete') throw new Error('Missing timeline')
    expect(complete.timeline.durationSeconds).toBe(45)
    expect(complete.timeline.completedRanges).toBeUndefined()
  })

  it('supersedes a build without publishing a stale completion', async () => {
    const worker = await loadWorker()
    worker.send([new Float32Array(48000 * 3)])
    await vi.advanceTimersToNextTimerAsync()
    worker.send([new Float32Array(4800)])
    await vi.runAllTimersAsync()
    const completed = worker.responses.filter((response) => response.type === 'complete')
    expect(completed).toHaveLength(1)
    expect(completed[0]?.timeline.durationSeconds).toBe(0.1)
  })

  it('reports invalid PCM as a structured error', async () => {
    const worker = await loadWorker()
    worker.send([], 48000)
    expect(worker.responses[0]).toEqual({ type: 'error', message: '音频声道数据无效' })
    worker.responses.length = 0
    const invalid = new Float32Array(100)
    invalid[0] = Number.NaN
    worker.send([invalid])
    await vi.runAllTimersAsync()
    expect(worker.responses).toEqual([{ type: 'error', message: '音频包含无效采样数据' }])
  })
})
