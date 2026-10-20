import {
  beatRangesDuration,
  createBeatTimelineBuffer,
  createBeatTimelineBuilder,
  mergeBeatTimelineRange,
  snapshotBeatTimeline,
  type BeatTimeRange,
  type BeatTimeline,
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
import type {
  BeatPreanalysisBuildRequest,
  BeatPreanalysisRequest,
  BeatPreanalysisResponse,
} from '../core/analysis/beat-preanalysis-protocol'

let generation = 0
let updatePlayback: ((state: BeatPlaybackState, bufferSeconds?: number) => void) | null = null
let wakeBuild: (() => void) | null = null
let requestYield: (() => void) | null = null

function reply(message: BeatPreanalysisResponse, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer })
}

const yieldThread = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function build(request: BeatPreanalysisBuildRequest, current: number): Promise<void> {
  const active = (): boolean => current === generation
  try {
    // Validate PCM before constructing a scheduler; no processing starts here.
    const validation = createBeatTimelineBuilder(request.channels, request.sampleRate)
    const duration = validation.snapshot().durationSeconds
    const ranges: BeatTimeRange[] = Array.from(
      { length: Math.ceil(duration / 10) },
      (_, index) => ({
        startSeconds: index * 10,
        endSeconds: Math.min(duration, (index + 1) * 10),
      }),
    )
    const signature: BeatCheckpointSignature = {
      sampleRate: request.sampleRate,
      sampleCount: request.channels[0]!.length,
      channels: request.channels.length,
      modelId: 'basic',
    }
    if (request.checkpoint) validateBeatCheckpoint(request.checkpoint, signature, ranges.length)
    const accumulated = request.checkpoint
      ? snapshotBeatTimeline(request.checkpoint.timeline)
      : createBeatTimelineBuffer(duration)
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
    interface PreparedRange {
      builder: BeatTimelineBuilder
      batches: number
      workMs: number
    }
    const prepared = new Map<number, PreparedRange>()
    const completed = new Set(request.checkpoint?.completedWindows)
    let activeRange: BeatTimeRange | undefined
    const checkpoint = () =>
      createBeatCheckpoint(signature, accumulated, completed, work.estimatedWorkMs)
    const select = (): number | null =>
      nextBufferedBeatWindow(
        ranges,
        completed,
        accumulated,
        work.playbackAt(performance.now()).timeSeconds,
        bufferSeconds,
        work.next(ranges, completed, performance.now()),
      )
    const publish = (finishedWindow = false, preview?: BeatTimeline): void => {
      const saved = finishedWindow ? checkpoint() : undefined
      const timeline = saved?.timeline ?? snapshotBeatTimeline(accumulated)
      // A display preview may cover half a window. Only finished windows belong
      // in the resumable checkpoint, so an interrupted warmup cannot freeze it.
      if (preview) mergeBeatTimelineRange(timeline, preview)
      const progress = beatRangesDuration(timeline.completedRanges ?? []) / duration
      reply(
        {
          type: 'partial',
          timeline,
          progress,
          activeRange,
          ...(saved ? { checkpoint: saved } : {}),
        },
        [...timeline.levels, timeline.sustain].map((values) => values.buffer as ArrayBuffer),
      )
    }
    rangeLoop: while (completed.size < ranges.length) {
      await waitForStablePlayback()
      if (!active()) return
      if (yielded || (bufferSeconds !== undefined && builtWindows >= maximum)) break
      const index = select()
      if (index === null) break
      activeRange = ranges[index]!
      let selectedRevision = revision
      let job = prepared.get(index)
      if (!job) {
        const started = performance.now()
        job = {
          builder: createBeatTimelineBuilder(request.channels, request.sampleRate, activeRange),
          batches: 0,
          workMs: performance.now() - started,
        }
      }
      prepared.delete(index)
      prepared.set(index, job)
      // Keep recent warmups for back-and-forth seeks without unbounded PCM history.
      if (prepared.size > 2) prepared.delete(prepared.keys().next().value!)
      for (;;) {
        const yieldStarted = performance.now()
        await yieldThread()
        if (!active()) return
        job.workMs += performance.now() - yieldStarted
        // A drag suspends work without polling or charging wait time to the estimate.
        await waitForStablePlayback()
        if (!active()) return
        if (yielded) break rangeLoop
        if (selectedRevision !== revision) {
          selectedRevision = revision
          if (select() !== index) continue rangeLoop
        }
        const started = performance.now()
        const progress = job.builder.process(60)
        if (progress >= 1) {
          mergeBeatTimelineRange(accumulated, job.builder.finish(), activeRange)
          work.observeWorkDuration(job.workMs + performance.now() - started)
          completed.add(index)
          builtWindows += 1
          publish(true)
          prepared.delete(index)
          break
        } else if (job.batches % 5 === 0) {
          publish(false, job.builder.snapshot())
        } else {
          reply({
            type: 'progress',
            progress: beatRangesDuration(accumulated.completedRanges ?? []) / duration,
            activeRange,
          })
        }
        job.batches += 1
        job.workMs += performance.now() - started
      }
    }
    if (!active()) return
    const audio = {
      channels: request.channels,
      sampleRate: request.sampleRate,
      identity: request.audioIdentity,
    }
    const audioBuffers = request.channels.map((channel) => channel.buffer as ArrayBuffer)
    if (completed.size < ranges.length) {
      const saved = checkpoint()
      reply({ type: 'buffered', checkpoint: saved, audio }, [
        ...beatCheckpointBuffers(saved),
        ...audioBuffers,
      ])
      return
    }
    const timeline = { ...accumulated }
    delete timeline.completedRanges
    delete timeline.builtUntilSeconds
    reply(
      { type: 'complete', timeline, ...(request.bufferSeconds !== undefined ? { audio } : {}) },
      [...timeline.levels, timeline.sustain]
        .map((values) => values.buffer as ArrayBuffer)
        .concat(request.bufferSeconds !== undefined ? audioBuffers : []),
    )
  } catch (error) {
    if (active())
      reply({
        type: 'error',
        message: error instanceof Error ? error.message : '节拍时间轴构建失败',
      })
  } finally {
    if (active()) {
      updatePlayback = null
      wakeBuild = null
      requestYield = null
    }
  }
}

self.onmessage = (event: MessageEvent<BeatPreanalysisRequest>): void => {
  const request = event.data
  if (request.type === 'yield') {
    requestYield?.()
    return
  }
  if (request.type === 'prioritize') {
    if (Number.isFinite(request.timeSeconds))
      updatePlayback?.(
        {
          timeSeconds: request.timeSeconds,
          playing: request.playing ?? false,
          playbackRate: request.playbackRate ?? 1,
          seeking: request.seeking ?? false,
        },
        request.bufferSeconds,
      )
    return
  }
  generation += 1
  wakeBuild?.()
  wakeBuild = null
  updatePlayback = null
  requestYield = null
  void build(request, generation)
}
