import {
  createBeatTimelineBuilder,
  snapshotBeatTimeline,
  isBeatTimelineReadyAt,
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
import type { BeatInferenceMetrics } from '../core/analysis/beat-preanalysis-protocol'
import { createBeatFeatureCache, type BeatFeatureCache } from '../core/analysis/beat-feature-cache'

let generation = 0
let updatePlayback: ((state: BeatPlaybackState, bufferSeconds?: number) => void) | null = null
let wakeBuild: (() => void) | null = null
let requestYield: (() => void) | null = null
type Session = import('onnxruntime-web/all').InferenceSession
let retained: {
  session: Session
  modelId: BeatThisBuildRequest['modelId']
  model: ArrayBuffer
  filterbank: ArrayBuffer
  backend: 'webgpu' | 'wasm'
  probeMs: number
} | null = null
let buildQueue: Promise<void> = Promise.resolve()
// At most two exact audio identities, each with <=802 KiB of recent log-mel pages.
// No retained feature cache owns PCM or survives this worker's session lifetime.
const featureCaches = new Map<string, BeatFeatureCache>()

async function disposeRetainedSession(): Promise<void> {
  featureCaches.clear()
  const previous = retained
  retained = null
  await previous?.session.release().catch(() => undefined)
}

function reply(message: BeatThisResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer })
}

const yieldThread = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function build(request: BeatThisBuildRequest, current: number): Promise<void> {
  const reusable = request.retainSession && retained?.modelId === request.modelId ? retained : null
  if (!reusable) featureCaches.clear()
  if (retained && !reusable) await disposeRetainedSession()
  let session: Session | null = reusable?.session ?? null
  let backend: 'webgpu' | 'wasm' | undefined = reusable?.backend
  let probeMs = reusable?.probeMs ?? 0
  const metrics: BeatInferenceMetrics = {
    initializationMs: 0,
    inferenceMs: 0,
    sessionReused: reusable !== null,
    backend,
  }
  let successful = false
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
    if (retained?.session === previous) retained = null
    await previous?.release().catch(() => undefined)
  }
  const preserveOrClose = async (): Promise<void> => {
    if (request.retainSession && session && backend && active()) {
      retained = {
        session,
        modelId: request.modelId,
        model: model!,
        filterbank: filterbank!,
        backend,
        probeMs,
      }
    } else await closeSession()
    successful = true
    metrics.backend = backend
  }
  const filterbank = reusable?.filterbank ?? request.filterbank
  const model = reusable?.model ?? request.model
  try {
    if (!filterbank || !model) throw new Error('Beat This! 模型会话已失效，请重新构建')
    let featureCache: BeatFeatureCache | undefined
    if (request.retainSession && request.audioIdentity) {
      const key = JSON.stringify([
        request.audioIdentity,
        request.sampleRate,
        request.channels.length,
        request.channels[0]?.length,
      ])
      featureCache = featureCaches.get(key) ?? createBeatFeatureCache()
      featureCaches.delete(key)
      if (featureCaches.size >= 2) featureCaches.delete(featureCaches.keys().next().value!)
      featureCaches.set(key, featureCache)
    }
    const features = createBeatThisFeaturesBuilder(
      request.channels,
      request.sampleRate,
      new Float32Array(filterbank),
      featureCache,
    )
    const updateFeatureMetrics = (): void => {
      metrics.featureFrames = features.processedFrames
      metrics.reusedFeatureFrames = features.reusedFrames
      metrics.featureResidentBytes = features.residentBytes
      metrics.featurePeakResidentBytes = features.peakResidentBytes
    }
    metrics.featureInputBytes = 0
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
      await preserveOrClose()
      if (!active()) return
      const saved = checkpoint()
      const audio = {
        channels: request.channels,
        sampleRate: request.sampleRate,
        identity: request.audioIdentity,
      }
      updateFeatureMetrics()
      reply({ type: 'buffered', checkpoint: saved, audio, backend, metrics }, [
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
    interface PreparedWindow {
      builder: BeatTimelineBuilder
      basicProgress: number
      featureProgress: number
      workMs: number
      previewPublished: boolean
    }
    // A preview owns only small timeline arrays, never another copy of the PCM.
    // Retain at most two warmups while seeking; validated model checkpoints stay
    // wholly separate from these temporary basic results.
    const prepared = new Map<number, PreparedWindow>()
    const prepare = (index: number): PreparedWindow => {
      const window = windows[index]!
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
          previewPublished: false,
        }
      }
      prepared.delete(index)
      prepared.set(index, job)
      if (prepared.size > 2) prepared.delete(prepared.keys().next().value!)
      return job
    }
    const preview = (job: PreparedWindow): void => {
      if (!active() || job.previewPublished) return
      job.previewPublished = true
      const timeline = snapshotBeatTimeline(job.builder.finish())
      reply(
        { type: 'preview', timeline },
        [...timeline.levels, timeline.sustain].map((values) => values.buffer as ArrayBuffer),
      )
    }
    // Basic analysis is cheap enough to provide a usable first region before
    // model session creation/probing. Reuse this same builder for final blending.
    let previewIndex: number | null = null
    let previewRevision = -1
    let previewStartupMs = 0
    for (;;) {
      await waitForStablePlayback()
      if (!active()) return
      if (yielded) {
        await returnBuffer()
        return
      }
      if (previewRevision !== revision) {
        const playhead = work.playbackAt(performance.now()).timeSeconds
        // Model work deliberately looks ahead by its measured inference cost.
        // A display preview instead repairs the playhead's present gap, even
        // when a resumed checkpoint predicts a much later model completion.
        previewIndex = isBeatTimelineReadyAt(assembled.timeline, playhead)
          ? null
          : ranges.findIndex(
              (range) => playhead >= range.startSeconds && playhead < range.endSeconds,
            )
        if (previewIndex === -1) previewIndex = null
        previewRevision = revision
      }
      const index = previewIndex
      if (index === null) break
      activeRange = windows[index]!.range
      const job = prepare(index)
      const started = performance.now()
      job.basicProgress = job.builder.process(120)
      if (job.basicProgress >= 1) {
        previewStartupMs += performance.now() - started
        preview(job)
        break
      }
      progress(0)
      await yieldThread()
      previewStartupMs += performance.now() - started
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
      session = await ort.InferenceSession.create(model, {
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
      probeMs = performance.now() - started
      work.seedWorkDuration(probeMs)
    }
    if (session) work.seedWorkDuration(probeMs)
    else {
      backend = 'webgpu'
      try {
        await openSession('webgpu')
      } catch {
        await closeSession()
        if (!active()) return
        backend = 'wasm'
        await openSession('wasm')
      }
      metrics.initializationMs = performance.now() - initializationStarted
    }
    if (!active()) return
    // Cold batches include initialization; warm batches estimate only useful
    // work so the refill scheduler can adapt after the first successful window.
    let initializationMs =
      previewStartupMs +
      (bufferSeconds === undefined ? 0 : performance.now() - initializationStarted)
    windowLoop: while (completed.size < windows.length) {
      await waitForStablePlayback()
      if (!active()) return
      if (yielded || (bufferSeconds !== undefined && builtWindows >= maximum)) break
      const index = select()
      if (index === null) break
      const window = windows[index]!
      let selectedRevision = revision
      activeRange = window.range
      const job = prepare(index)
      // A seek can retain this basic warmup while its frequency pages are evicted.
      // Always revisit processRange: it rechecks residency and credits cache hits
      // without doing FFT work for frames that are still available.
      job.featureProgress = 0
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
        if (job.basicProgress >= 1) preview(job)
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
      metrics.featureInputBytes = input.byteLength
      let output: { beat: Float32Array; downbeat: Float32Array }
      try {
        const inferenceStarted = performance.now()
        try {
          output = await run(input)
        } finally {
          metrics.inferenceMs += performance.now() - inferenceStarted
        }
      } catch (error) {
        if (backend === 'wasm') throw error
        await closeSession()
        if (!active()) return
        backend = 'wasm'
        const fallbackStarted = performance.now()
        await openSession('wasm')
        metrics.initializationMs += performance.now() - fallbackStarted
        if (!active()) return
        // Retry only this window. Earlier validated regions remain unchanged.
        const inferenceStarted = performance.now()
        try {
          output = await run(input)
        } finally {
          metrics.inferenceMs += performance.now() - inferenceStarted
        }
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
    const timeline = assembled.timeline
    if (
      timeline.completedRanges?.length !== 1 ||
      timeline.completedRanges[0]!.startSeconds !== 0 ||
      timeline.completedRanges[0]!.endSeconds !== duration
    )
      throw new Error('Beat This! 分段预测尚未完整覆盖歌曲')
    delete timeline.completedRanges
    delete timeline.builtUntilSeconds
    updateFeatureMetrics()
    await preserveOrClose()
    if (!active()) return
    reply(
      {
        type: 'complete',
        timeline,
        backend: backend!,
        metrics,
        ...(request.bufferSeconds !== undefined
          ? {
              audio: {
                channels: request.channels,
                sampleRate: request.sampleRate,
                identity: request.audioIdentity,
              },
            }
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
    // Invalid inference or checkpoints must never re-enter the reusable pool.
    successful = false
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
    if (!successful) {
      featureCaches.clear()
      await closeSession()
    }
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
  const current = generation
  const request = event.data
  // A replaced job may still be returning from session.run(). Never release or
  // reuse its session until that actual work settles.
  buildQueue = buildQueue.then(async () => {
    if (request.type === 'dispose') {
      await disposeRetainedSession()
      reply({ type: 'disposed' })
    } else if (current === generation) await build(request, current)
  })
}
