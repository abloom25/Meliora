import {
  createBeatTimelineBuilder,
  type BeatTimeRange,
  type BeatTimelineBuilder,
} from '../core/analysis/beat-timeline'
import {
  createBeatSchedulingController,
  type BeatPlaybackState,
} from '../core/analysis/beat-scheduling'
import {
  createBeatCheckpoint,
  beatCheckpointBuffers,
  nextBufferedBeatWindow,
  validateBeatCheckpoint,
  type BeatCheckpointSignature,
} from '../core/analysis/beat-checkpoint'
import {
  BEAT_THIS_BANDS,
  BEAT_THIS_FPS,
  createBeatThisFeaturesBuilder,
} from '../core/analysis/beat-this-features'
import {
  BEAT_THIS_CHUNK_FRAMES,
  beatThisWindows,
  createBeatThisProbe,
  matchesBeatThisProbe,
  postprocessBeatThisWindow,
} from '../core/analysis/beat-this-prediction'
import {
  blendBeatThisTimeline,
  createBeatThisTimelineAssembler,
} from '../core/analysis/beat-this-timeline'
import type {
  BeatThisBuildRequest,
  BeatThisRequest,
  BeatThisResponse,
} from '../core/analysis/beat-this-protocol'
import { BEAT_THIS_PROBES } from '../core/analysis/beat-this-probes'

let generation = 0
let updatePlayback: ((state: BeatPlaybackState, bufferSeconds?: number) => void) | null = null
let wakeBuild: (() => void) | null = null
let requestYield: (() => void) | null = null

function reply(message: BeatThisResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer })
}

const yieldThread = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function build(request: BeatThisBuildRequest, current: number): Promise<void> {
  let session: import('onnxruntime-web/all').InferenceSession | null = null
  let reportedProgress = 0
  let activeRange: BeatTimeRange | undefined
  const active = (): boolean => current === generation
  const progress = (value: number): void => {
    reportedProgress = Math.max(reportedProgress, value)
    if (active()) reply({ type: 'progress', progress: reportedProgress, activeRange })
  }
  const closeSession = async (): Promise<void> => {
    const previous = session
    session = null
    await previous?.release().catch(() => undefined)
  }
  try {
    const features = createBeatThisFeaturesBuilder(
      request.channels,
      request.sampleRate,
      new Float32Array(request.filterbank),
    )
    const duration = request.channels[0]!.length / request.sampleRate
    const signature: BeatCheckpointSignature = {
      sampleRate: request.sampleRate,
      sampleCount: request.channels[0]!.length,
      channels: request.channels.length,
      modelId: request.modelId,
    }
    const windows = beatThisWindows(features.frames, duration)
    const ranges = windows.map((window) => window.range)
    if (request.checkpoint) validateBeatCheckpoint(request.checkpoint, signature, windows.length)
    const completed = new Set(request.checkpoint?.completedWindows)
    const assembled = createBeatThisTimelineAssembler(duration, windows, request.checkpoint)
    let bufferSeconds = request.bufferSeconds
    const maximum = request.maxWindows ?? 3
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('节拍构建窗口数量无效')
    let builtWindows = 0
    let yielded = false
    let backend: 'webgpu' | 'wasm' | undefined
    const work = createBeatSchedulingController(
      duration,
      request.playback ?? {
        timeSeconds: request.prioritySeconds ?? 0,
        playing: false,
        playbackRate: 1,
        seeking: false,
      },
      performance.now(),
    )
    if (request.checkpoint) work.observeWorkDuration(request.checkpoint.estimatedWorkMs)
    let revision = 0
    let resume: (() => void) | null = null
    wakeBuild = (): void => {
      resume?.()
      resume = null
    }
    requestYield = (): void => {
      yielded = true
      wakeBuild?.()
    }
    updatePlayback = (state, nextBuffer): void => {
      if (nextBuffer !== undefined && nextBuffer !== bufferSeconds) {
        bufferSeconds = nextBuffer
        revision += 1
      }
      const now = performance.now()
      const previous = work.playbackAt(now)
      work.updatePlayback(state, now)
      const next = work.playbackAt(now)
      // Ordinary timeupdate messages only correct clock drift. Repeatedly
      // restarting slow preprocessing as playback advances would starve inference.
      if (
        previous.seeking !== next.seeking ||
        previous.playing !== next.playing ||
        previous.playbackRate !== next.playbackRate ||
        Math.abs(previous.timeSeconds - next.timeSeconds) > 2
      )
        revision += 1
      wakeBuild?.()
    }
    const waitForStablePlayback = async (): Promise<void> => {
      while (active() && !yielded && work.playbackAt(performance.now()).seeking)
        await new Promise<void>((resolve) => {
          resume = resolve
        })
    }
    const checkpoint = () =>
      createBeatCheckpoint(
        signature,
        assembled.timeline,
        completed,
        work.estimatedWorkMs,
        assembled.snapshotSeams(),
      )
    const select = (): number | null =>
      nextBufferedBeatWindow(
        ranges,
        completed,
        assembled.timeline,
        work.playbackAt(performance.now()).timeSeconds,
        bufferSeconds,
        work.next(ranges, completed, performance.now()),
        0.25,
      )
    const returnBuffer = async (): Promise<void> => {
      await closeSession()
      if (!active()) return
      const saved = checkpoint()
      const audio = { channels: request.channels, sampleRate: request.sampleRate }
      reply({ type: 'buffered', checkpoint: saved, audio, backend }, [
        ...beatCheckpointBuffers(saved),
        ...request.channels.map((channel) => channel.buffer as ArrayBuffer),
      ])
    }
    if (
      bufferSeconds !== undefined &&
      !work.playbackAt(performance.now()).seeking &&
      completed.size < windows.length &&
      select() === null
    ) {
      await returnBuffer()
      return
    }
    const initializationStarted = performance.now()
    const ort = await import('onnxruntime-web/all')
    if (!active()) return
    if (yielded) {
      await returnBuffer()
      return
    }
    // Threads require cross-origin isolation; one worker already keeps the UI free.
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false
    if (request.wasmBinary) ort.env.wasm.wasmBinary = new Uint8Array(request.wasmBinary)
    if (request.wasmPaths) ort.env.wasm.wasmPaths = request.wasmPaths
    const run = async (
      data: Float32Array,
    ): Promise<{ beat: Float32Array; downbeat: Float32Array }> => {
      if (!session) throw new Error('Beat This! 推理引擎未就绪')
      const input = new ort.Tensor('float32', data, [1, BEAT_THIS_CHUNK_FRAMES, BEAT_THIS_BANDS])
      let outputs: Awaited<ReturnType<typeof session.run>> | null = null
      try {
        outputs = await session.run({ spect: input })
        const beat = outputs.beat?.data
        const downbeat = outputs.downbeat?.data
        if (!(beat instanceof Float32Array) || !(downbeat instanceof Float32Array)) {
          throw new Error('Beat This! 模型输出格式无效')
        }
        if (
          beat.length !== BEAT_THIS_CHUNK_FRAMES ||
          downbeat.length !== BEAT_THIS_CHUNK_FRAMES ||
          beat.some((value) => !Number.isFinite(value)) ||
          downbeat.some((value) => !Number.isFinite(value))
        ) {
          throw new Error('Beat This! 模型输出数值无效')
        }
        return { beat: beat.slice(), downbeat: downbeat.slice() }
      } finally {
        input.dispose()
        if (outputs) for (const output of Object.values(outputs)) output.dispose()
      }
    }
    const openSession = async (backend: 'webgpu' | 'wasm'): Promise<void> => {
      session = await ort.InferenceSession.create(request.model, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
      })
      if (!active()) return
      if (
        !session.inputNames.includes('spect') ||
        !session.outputNames.includes('beat') ||
        !session.outputNames.includes('downbeat')
      ) {
        throw new Error('Beat This! 模型格式不匹配，请重新下载模型')
      }
      const started = performance.now()
      const probe = await run(createBeatThisProbe())
      if (!matchesBeatThisProbe(probe.beat, probe.downbeat, BEAT_THIS_PROBES[request.modelId])) {
        throw new Error('Beat This! 推理结果校验未通过，请重新下载模型或切换基础模式')
      }
      work.seedWorkDuration(performance.now() - started)
    }
    backend = 'webgpu'
    try {
      await openSession('webgpu')
    } catch {
      await closeSession()
      if (!active()) return
      backend = 'wasm'
      await openSession('wasm')
    }
    if (!active()) return
    // Bounded jobs reopen the model on each batch. Include that startup in the
    // first window's estimate so the next refill starts before its buffer runs out.
    let initializationMs =
      bufferSeconds === undefined ? 0 : performance.now() - initializationStarted
    interface PreparedWindow {
      builder: BeatTimelineBuilder
      basicProgress: number
      featureProgress: number
      workMs: number
    }
    // Features remain cached for the entire song. Keep only two DSP warmups so
    // dragging through many positions cannot retain one full timeline per seek.
    const prepared = new Map<number, PreparedWindow>()
    windowLoop: while (completed.size < windows.length) {
      await waitForStablePlayback()
      if (!active()) return
      if (yielded || (bufferSeconds !== undefined && builtWindows >= maximum)) break
      const index = select()
      if (index === null) break
      const window = windows[index]!
      let selectedRevision = revision
      activeRange = window.range
      let job = prepared.get(index)
      if (!job) {
        const started = performance.now()
        job = {
          builder: createBeatTimelineBuilder(request.channels, request.sampleRate, {
            startSeconds: Math.max(0, window.startFrame / BEAT_THIS_FPS),
            endSeconds: Math.min(
              duration,
              (window.startFrame + BEAT_THIS_CHUNK_FRAMES) / BEAT_THIS_FPS + 0.1,
            ),
          }),
          basicProgress: 0,
          featureProgress: 0,
          workMs: performance.now() - started,
        }
      }
      prepared.delete(index)
      prepared.set(index, job)
      if (prepared.size > 2) prepared.delete(prepared.keys().next().value!)
      const reportWork = (): void =>
        progress(
          0.05 +
            ((completed.size + job.basicProgress * 0.15 + job.featureProgress * 0.25) /
              windows.length) *
              0.93,
        )
      reportWork()
      for (;;) {
        const yieldStarted = performance.now()
        await yieldThread()
        if (!active()) return
        job.workMs += performance.now() - yieldStarted
        // Waiting on the drag is deliberately outside the measured work time.
        // A new build wakes this wait too, allowing stale sessions to be released.
        await waitForStablePlayback()
        if (!active()) return
        if (yielded) break windowLoop
        if (selectedRevision !== revision) {
          selectedRevision = revision
          if (select() !== index) continue windowLoop
        }
        if (job.basicProgress >= 1 && job.featureProgress >= 1) break
        const started = performance.now()
        if (job.basicProgress < 1) job.basicProgress = job.builder.process(60)
        if (job.featureProgress < 1)
          job.featureProgress = features.processRange(
            window.startFrame,
            window.startFrame + BEAT_THIS_CHUNK_FRAMES,
            25,
          )
        job.workMs += performance.now() - started
        reportWork()
      }
      const started = performance.now()
      const input = features.chunk(window.startFrame, BEAT_THIS_CHUNK_FRAMES)
      let output: { beat: Float32Array; downbeat: Float32Array }
      try {
        output = await run(input)
      } catch (error) {
        if (backend === 'wasm') throw error
        await closeSession()
        if (!active()) return
        backend = 'wasm'
        await openSession('wasm')
        if (!active()) return
        // Retry only this window. Earlier validated regions remain unchanged.
        output = await run(input)
      }
      if (!active()) return
      const part = blendBeatThisTimeline(
        job.builder.finish(),
        postprocessBeatThisWindow(output.beat, output.downbeat, window.startFrame),
      )
      assembled.add(window, part)
      completed.add(window.index)
      builtWindows += 1
      work.observeWorkDuration(initializationMs + job.workMs + performance.now() - started)
      initializationMs = 0
      prepared.delete(index)
      progress(0.05 + (completed.size / windows.length) * 0.93)
      if (completed.size < windows.length) {
        const saved = checkpoint()
        const timeline = saved.timeline
        reply(
          { type: 'partial', timeline, progress: reportedProgress, activeRange, checkpoint: saved },
          [...timeline.levels, timeline.sustain].map((values) => values.buffer as ArrayBuffer),
        )
      }
    }
    if (completed.size < windows.length) {
      await returnBuffer()
      return
    }
    if (!request.checkpoint) features.finish()
    const timeline = assembled.timeline
    if (
      timeline.completedRanges?.length !== 1 ||
      timeline.completedRanges[0]!.startSeconds !== 0 ||
      timeline.completedRanges[0]!.endSeconds !== duration
    )
      throw new Error('Beat This! 分段预测尚未完整覆盖歌曲')
    delete timeline.completedRanges
    delete timeline.builtUntilSeconds
    // The host terminates this worker as soon as it receives completion. Release
    // GPU allocations first instead of relying on a finally that may never run.
    await closeSession()
    if (!active()) return
    reply(
      {
        type: 'complete',
        timeline,
        backend,
        ...(request.bufferSeconds !== undefined
          ? { audio: { channels: request.channels, sampleRate: request.sampleRate } }
          : {}),
      },
      [...timeline.levels, timeline.sustain]
        .map((values) => values.buffer as ArrayBuffer)
        .concat(
          request.bufferSeconds !== undefined
            ? request.channels.map((channel) => channel.buffer as ArrayBuffer)
            : [],
        ),
    )
  } catch (error) {
    // The host terminates this worker on an error as well as on success.
    await closeSession()
    if (active())
      reply({
        type: 'error',
        message: error instanceof Error ? error.message : 'Beat This! 节拍分析失败',
      })
  } finally {
    if (active()) {
      updatePlayback = null
      wakeBuild = null
      requestYield = null
    }
    await closeSession()
  }
}

self.onmessage = (event: MessageEvent<BeatThisRequest>): void => {
  if (event.data.type === 'yield') {
    requestYield?.()
    return
  }
  if (event.data.type === 'prioritize') {
    if (Number.isFinite(event.data.timeSeconds)) {
      updatePlayback?.(
        {
          timeSeconds: event.data.timeSeconds,
          playing: event.data.playing ?? false,
          playbackRate: event.data.playbackRate ?? 1,
          seeking: event.data.seeking ?? false,
        },
        event.data.bufferSeconds,
      )
    }
    return
  }
  generation += 1
  wakeBuild?.()
  wakeBuild = null
  updatePlayback = null
  requestYield = null
  void build(event.data, generation)
}
