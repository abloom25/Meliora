import {
  beatRangesDuration,
  normalizeBeatRanges,
  createBeatTimelineBuffer,
  type BeatBuildStatus,
  type BeatTimeline,
  type BeatTimeRange,
} from '../../core/analysis/beat-timeline'
import type {
  BeatAnalysisMetrics,
  BeatPreanalysisResponse,
} from '../../core/analysis/beat-preanalysis-protocol'
import { BEAT_THIS_MODELS, type BeatThisModelId } from '../../core/analysis/beat-this-models'
import type { BeatThisModelAssets } from '../../core/analysis/beat-this-protocol'
import { continuousBeatCoverage, type BeatPlaybackState } from '../../core/analysis/beat-scheduling'
import {
  createBeatCheckpoint,
  validateBeatCheckpoint,
  type BeatAnalysisCheckpoint,
} from '../../core/analysis/beat-checkpoint'
import { beatThisWindows } from '../../core/analysis/beat-this-prediction'
import { BEAT_THIS_FPS } from '../../core/analysis/beat-this-features'
import { httpFetch, type HttpFetcher } from '../../services/http'
import { readBeatThisModel } from './useBeatThisModels'
import { createBeatAudioCache, type BeatAudioCache, type BeatAudioData } from './beat-audio-cache'
import { acquireBeatModelSession, type BeatWorkerLease } from './beat-worker-pool'
import { beatResultCache, BEAT_RESULT_VERSION, type BeatResultStore } from './beat-result-cache'
import { validPersistentCheckpoint } from '../../core/analysis/beat-result-cache'

const FETCH_TIMEOUT_MS = 120_000
const DECODE_TIMEOUT_MS = 45_000
const ANALYSIS_TIMEOUT_MS = 120_000
const MODEL_ANALYSIS_TIMEOUT_MS = 600_000
const MAX_AUDIO_BYTES = 64 * 1024 * 1024
const MAX_DURATION_SECONDS = 10 * 60
const MAX_PCM_SAMPLES = 64 * 1024 * 1024
const COPY_CHUNK_SAMPLES = 262144
type AudioDecoder = (encoded: ArrayBuffer) => Promise<AudioBuffer>
const decoderQueues = new WeakMap<AudioDecoder, Promise<void>>()
const sharedAudioCache = createBeatAudioCache()
let audioSequence = 0
const audioNamespace = Math.random().toString(36).slice(2)
const persistenceContexts = new Map<
  string,
  { key: string; trackKey: string; generation: number; store: BeatResultStore }
>()

/** Saves an already computed short song when its second listen qualifies after analysis finished. */
export function persistKnownBeatCheckpoint(
  source: string,
  trackKey: string,
  checkpoint: BeatAnalysisCheckpoint,
): void {
  const context = persistenceContexts.get(JSON.stringify([source, checkpoint.signature.modelId]))
  if (context?.trackKey === trackKey && context.generation === context.store.generation)
    void context.store.set(context.key, trackKey, checkpoint, context.generation).catch(() => {})
}

export function protectBeatAudioSource(source: string | null): void {
  sharedAudioCache.protectPcm(source)
}

/** Resident buffers only; excludes the current worker, model and browser media buffers. */
export function readBeatAudioCacheUsage(): Pick<
  BeatAudioCache,
  'pcmBytes' | 'encodedBytes' | 'pcmEntries' | 'encodedEntries'
> {
  return {
    pcmBytes: sharedAudioCache.pcmBytes,
    encodedBytes: sharedAudioCache.encodedBytes,
    pcmEntries: sharedAudioCache.pcmEntries,
    encodedEntries: sharedAudioCache.encodedEntries,
  }
}

export type BeatTimelineBuilder = (
  source: string,
  signal: AbortSignal,
  onStatus: (status: BeatBuildStatus) => void,
  dependencies?: BeatPreanalysisDependencies,
) => Promise<BeatTimeline>

export interface BeatPreanalysisDependencies {
  persistent?: { trackKey: string; eligible: () => boolean }
  resultCache?: BeatResultStore
  /** Read from the active media element before requesting a full-file decode. */
  durationSeconds?: number
  modelId?: BeatThisModelId
  onMetrics?: (metrics: BeatAnalysisMetrics) => void
  /** Test/custom worker factories remain isolated unless explicitly opted in. */
  reuseModelSession?: boolean
  onPartial?: (timeline: BeatTimeline) => void
  /** Temporary basic output; must not enter model coverage, cache, or checkpoints. */
  onPreview?: (timeline: BeatTimeline) => void
  checkpoint?: BeatAnalysisCheckpoint
  onCheckpoint?: (checkpoint: BeatAnalysisCheckpoint) => void
  getBufferSeconds?: () => number
  maxWindows?: number
  subscribeYield?: (listener: () => void) => () => void
  audioCache?: BeatAudioCache
  /** Read just before dispatch, so loading the model/audio does not freeze the priority. */
  getPrioritySeconds?: () => number
  getPlaybackState?: () => BeatPlaybackState
  /** Retarget pending windows without reloading audio, the model, or completed results. */
  subscribePriority?: (listener: (playback: BeatPlaybackState) => void) => () => void
  readModel?: (id: BeatThisModelId, signal: AbortSignal) => Promise<BeatThisModelAssets>
  fetcher?: HttpFetcher
  decode?: AudioDecoder
  createWorker?: () => Worker
  fetchTimeoutMs?: number
  decodeTimeoutMs?: number
  analysisTimeoutMs?: number
  maxAudioBytes?: number
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

async function fingerprint(encoded: ArrayBuffer): Promise<string | null> {
  try {
    const digest = await globalThis.crypto?.subtle?.digest('SHA-256', encoded)
    return digest
      ? `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
      : null
  } catch {
    return null
  }
}

/** Native decoding cannot be interrupted, so detach its late result after cancellation. */
function cancellable<T>(
  task: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      action()
    }
    const abort = (): void => finish(() => reject(abortError()))
    const timer = window.setTimeout(
      () => finish(() => reject(new Error(timeoutMessage))),
      timeoutMs,
    )
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted()
        return task()
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      )
  })
}

async function readAudio(
  source: string,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
  dependencies: BeatPreanalysisDependencies,
): Promise<ArrayBuffer> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const maximum = dependencies.maxAudioBytes ?? MAX_AUDIO_BYTES
  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, dependencies.fetchTimeoutMs ?? FETCH_TIMEOUT_MS)
  try {
    controller.signal.throwIfAborted()
    const response = await (dependencies.fetcher ?? httpFetch)(source, {
      signal: controller.signal,
      cache: 'default',
      // CORS-safelisted header also tells our SW to leave large audio bodies alone.
      headers: { Accept: 'audio/*' },
    })
    if (!response.ok || response.status === 206)
      throw new Error('无法完整读取这首歌曲，暂时无法构建高亮')
    const contentType = response.headers.get('content-type') ?? ''
    if (/text\/html|application\/(?:json|vnd\.apple\.mpegurl)|mpegurl/i.test(contentType))
      throw new Error('这个音源不提供完整音频文件，暂时无法构建高亮')
    const declaredSize = Number(response.headers.get('content-length'))
    if (declaredSize > maximum) throw new Error('这首歌曲文件较大，已跳过高亮构建')
    if (!response.body) {
      const data = await response.arrayBuffer()
      controller.signal.throwIfAborted()
      if (!data.byteLength || data.byteLength > maximum)
        throw new Error('这首歌曲文件大小不适合构建高亮')
      onProgress(1)
      return data
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array<ArrayBuffer>[] = []
    let received = 0
    try {
      for (;;) {
        controller.signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > maximum) throw new Error('这首歌曲文件较大，已跳过高亮构建')
        chunks.push(value)
        onProgress(declaredSize > 0 ? Math.min(1, received / declaredSize) : 0)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    controller.signal.throwIfAborted()
    if (!received) throw new Error('音频文件为空，暂时无法构建高亮')
    const encoded = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      encoded.set(chunk, offset)
      offset += chunk.length
    }
    onProgress(1)
    return encoded.buffer
  } catch (error) {
    if (signal.aborted) throw abortError()
    if (timedOut) throw new Error('读取音频超时，可稍后重新构建高亮', { cause: error })
    if (error instanceof TypeError)
      throw new Error('当前音源不允许读取音频或网络中断，播放不受影响', { cause: error })
    throw error
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    controller.abort()
  }
}

function decodeAudio(encoded: ArrayBuffer): Promise<AudioBuffer> {
  if (typeof OfflineAudioContext === 'undefined')
    throw new Error('此浏览器无法预分析音频，播放不受影响')
  // This context only decodes; it never connects to the playback graph or audio hardware.
  const context = new OfflineAudioContext(1, 1, 48000)
  return context.decodeAudioData(encoded)
}

function decodeSerially(
  encoded: ArrayBuffer,
  signal: AbortSignal,
  decoder: AudioDecoder,
): Promise<AudioBuffer> {
  // A cancelled native decode still owns its PCM allocation until it settles.
  // Queue behind that actual work, never behind the caller's abort/timeout race.
  let pendingData: ArrayBuffer | null = encoded
  const release = (): void => {
    pendingData = null
  }
  signal.addEventListener('abort', release, { once: true })
  if (signal.aborted) release()
  const previous = decoderQueues.get(decoder) ?? Promise.resolve()
  const work = previous.then(() => {
    signal.throwIfAborted()
    if (!pendingData) throw abortError()
    const data = pendingData
    pendingData = null
    return decoder(data)
  })
  const tail = work.then(
    () => undefined,
    () => undefined,
  )
  decoderQueues.set(decoder, tail)
  void tail.then(() => {
    signal.removeEventListener('abort', release)
    if (decoderQueues.get(decoder) === tail) decoderQueues.delete(decoder)
  })
  return work
}

async function copyChannels(
  audio: AudioBuffer,
  signal: AbortSignal,
): Promise<Float32Array<ArrayBuffer>[]> {
  if (
    !Number.isFinite(audio.duration) ||
    audio.duration <= 0 ||
    audio.duration > MAX_DURATION_SECONDS ||
    !Number.isFinite(audio.sampleRate) ||
    audio.sampleRate < 8000 ||
    audio.sampleRate > 192000 ||
    audio.numberOfChannels < 1 ||
    audio.numberOfChannels > 8 ||
    audio.length * audio.numberOfChannels > MAX_PCM_SAMPLES
  ) {
    throw new Error('这首歌曲过长或音频格式不适合预分析，播放不受影响')
  }
  // This OfflineAudioContext buffer is never played. Move its channel storage into
  // our exclusive ownership instead of allocating a second full-song PCM copy.
  // Some engines disallow detaching native buffers; keep the chunked fallback.
  if (typeof audio.getChannelData === 'function' && typeof structuredClone === 'function') {
    try {
      const views = Array.from({ length: audio.numberOfChannels }, (_, index) =>
        audio.getChannelData(index),
      )
      const buffers = [...new Set(views.map((view) => view.buffer))]
      if (
        views.every((view) => view.length === audio.length) &&
        buffers.every((buffer) => buffer instanceof ArrayBuffer)
      ) {
        signal.throwIfAborted()
        return structuredClone(views, { transfer: buffers }) as Float32Array<ArrayBuffer>[]
      }
    } catch (error) {
      if (signal.aborted) throw error
    }
  }
  const channels: Float32Array<ArrayBuffer>[] = []
  for (let channel = 0; channel < audio.numberOfChannels; channel += 1) {
    const samples = new Float32Array(audio.length)
    for (let offset = 0; offset < samples.length; offset += COPY_CHUNK_SAMPLES) {
      signal.throwIfAborted()
      audio.copyFromChannel(samples.subarray(offset, offset + COPY_CHUNK_SAMPLES), channel, offset)
      // Avoid a multi-megabyte synchronous PCM copy blocking playback controls.
      if (offset + COPY_CHUNK_SAMPLES < samples.length)
        await new Promise<void>((resolve, reject) => {
          const abort = (): void => {
            window.clearTimeout(timer)
            reject(abortError())
          }
          const timer = window.setTimeout(() => {
            signal.removeEventListener('abort', abort)
            resolve()
          }, 0)
          signal.addEventListener('abort', abort, { once: true })
        })
    }
    channels.push(samples)
  }
  signal.throwIfAborted()
  return channels
}

function analyse(
  channels: Float32Array<ArrayBuffer>[],
  sampleRate: number,
  signal: AbortSignal,
  onProgress: (progress: number, activeRange?: BeatTimeRange) => void,
  dependencies: BeatPreanalysisDependencies,
  model?: BeatThisModelAssets,
  onAudioReturned?: (audio: BeatAudioData) => void,
  lease?: BeatWorkerLease,
  started = performance.now(),
  audioIdentity?: string,
): Promise<BeatTimeline> {
  return new Promise<BeatTimeline>((resolve, reject) => {
    const signature = {
      sampleRate,
      sampleCount: channels[0]!.length,
      channels: channels.length,
      modelId: dependencies.modelId ?? ('basic' as const),
    }
    signal.throwIfAborted()
    if (!dependencies.createWorker && typeof Worker === 'undefined') {
      reject(new Error('此浏览器无法在后台构建高亮，播放不受影响'))
      return
    }
    const worker =
      lease?.worker ??
      (dependencies.createWorker
        ? dependencies.createWorker()
        : dependencies.modelId
          ? new Worker(new URL('../../workers/beat-this.worker.ts', import.meta.url), {
              type: 'module',
            })
          : new Worker(new URL('../../workers/beat-preanalysis.worker.ts', import.meta.url), {
              type: 'module',
            }))
    lease?.attach(worker)
    let settled = false
    let unsubscribePriority: (() => void) | undefined
    let unsubscribeYield: (() => void) | undefined
    const finish = (action: () => void, keepSession = false): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      unsubscribePriority?.()
      unsubscribeYield?.()
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      if (lease) lease.release(keepSession)
      else worker.terminate()
      action()
    }
    const abort = (): void => finish(() => reject(abortError()))
    const timer = window.setTimeout(
      () => finish(() => reject(new Error('高亮构建超时，可稍后重试'))),
      dependencies.analysisTimeoutMs ??
        (dependencies.modelId ? MODEL_ANALYSIS_TIMEOUT_MS : ANALYSIS_TIMEOUT_MS),
    )
    signal.addEventListener('abort', abort, { once: true })
    const receive = (message: BeatPreanalysisResponse): void => {
      if (settled) return
      if (message.type === 'preview') {
        dependencies.onPreview?.(message.timeline)
      } else if (message.type === 'progress') {
        if (Number.isFinite(message.progress))
          onProgress(Math.max(0, Math.min(1, message.progress)), message.activeRange)
      } else if (message.type === 'partial') {
        if (message.checkpoint) dependencies.onCheckpoint?.(message.checkpoint)
        dependencies.onPartial?.(message.timeline)
        onProgress(Math.max(0, Math.min(1, message.progress)), message.activeRange)
      } else if (message.type === 'buffered') {
        onAudioReturned?.({ ...message.audio, identity: audioIdentity } as BeatAudioData)
        dependencies.onCheckpoint?.(message.checkpoint)
        dependencies.onPartial?.(message.checkpoint.timeline)
        const timeline = message.checkpoint.timeline
        onProgress(
          Math.min(
            1,
            beatRangesDuration(timeline.completedRanges ?? []) / timeline.durationSeconds,
          ),
        )
        dependencies.onMetrics?.({
          initializationMs: 0,
          inferenceMs: 0,
          sessionReused: false,
          ...message.metrics,
          totalMs: performance.now() - started,
        })
        finish(() => resolve(timeline), !!message.metrics?.backend)
      } else if (message.type === 'complete') {
        if (message.audio)
          onAudioReturned?.({ ...message.audio, identity: audioIdentity } as BeatAudioData)
        const duration = signature.sampleCount / signature.sampleRate
        const count = dependencies.modelId
          ? beatThisWindows(Math.floor(duration * BEAT_THIS_FPS) + 1, duration).length
          : Math.ceil(duration / 10)
        const checkpoint = createBeatCheckpoint(
          signature,
          message.timeline,
          new Set(Array.from({ length: count }, (_, index) => index)),
          dependencies.checkpoint?.estimatedWorkMs ?? 0,
        )
        dependencies.onCheckpoint?.(checkpoint)
        dependencies.onMetrics?.({
          initializationMs: 0,
          inferenceMs: 0,
          sessionReused: false,
          ...message.metrics,
          totalMs: performance.now() - started,
        })
        finish(() => resolve(message.timeline), !!message.metrics?.backend)
      } else if (message.type === 'error') {
        finish(() =>
          reject(
            new Error(
              /[\u3400-\u9fff]/.test(message.message)
                ? message.message
                : '高亮构建失败，播放不受影响，可重新尝试',
            ),
          ),
        )
      }
    }
    worker.onmessage = (event: MessageEvent<BeatPreanalysisResponse>): void => {
      try {
        receive(event.data)
      } catch (error) {
        finish(() => reject(error))
      }
    }
    worker.onerror = worker.onmessageerror = (): void => {
      finish(() => reject(new Error('高亮构建失败，播放不受影响，可重新尝试')))
    }
    try {
      const transfer: Transferable[] = [...new Set(channels.map((data) => data.buffer))]
      if (model) transfer.push(model.model, model.filterbank, model.wasmBinary)
      worker.postMessage(
        {
          type: 'build',
          channels,
          sampleRate,
          audioIdentity,
          prioritySeconds: dependencies.getPrioritySeconds?.() ?? 0,
          playback: dependencies.getPlaybackState?.(),
          checkpoint: dependencies.checkpoint,
          bufferSeconds: dependencies.getBufferSeconds?.(),
          maxWindows: dependencies.maxWindows,
          ...(dependencies.modelId
            ? { ...model, modelId: dependencies.modelId, retainSession: !!lease }
            : {}),
        },
        transfer,
      )
      unsubscribePriority = dependencies.subscribePriority?.((playback) => {
        if (settled || !Number.isFinite(playback.timeSeconds)) return
        try {
          worker.postMessage({
            type: 'prioritize',
            ...playback,
            timeSeconds: Math.max(0, playback.timeSeconds),
            ...(dependencies.getBufferSeconds
              ? { bufferSeconds: dependencies.getBufferSeconds() }
              : {}),
          })
        } catch (error) {
          finish(() => reject(error))
        }
      })
      if (settled) {
        unsubscribePriority?.()
        return
      }
      unsubscribeYield = dependencies.subscribeYield?.(() => {
        if (settled) return
        try {
          worker.postMessage({ type: 'yield' })
        } catch (error) {
          finish(() => reject(error))
        }
      })
      if (settled) unsubscribeYield?.()
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

async function decodeChannels(
  encoded: ArrayBuffer,
  signal: AbortSignal,
  dependencies: BeatPreanalysisDependencies,
): Promise<BeatAudioData> {
  const decodeController = new AbortController()
  const abort = (): void => decodeController.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  let audio: AudioBuffer
  try {
    audio = await cancellable(
      () => decodeSerially(encoded, decodeController.signal, dependencies.decode ?? decodeAudio),
      decodeController.signal,
      dependencies.decodeTimeoutMs ?? DECODE_TIMEOUT_MS,
      '音频解码超时，可稍后重新构建高亮',
    )
  } catch (error) {
    if (signal.aborted) throw abortError()
    if (error instanceof Error && /浏览器|超时/.test(error.message)) throw error
    throw new Error('这首歌曲无法解码，暂时无法构建高亮', { cause: error })
  } finally {
    signal.removeEventListener('abort', abort)
    // Timed-out queued jobs must not start a native decode later.
    decodeController.abort()
  }
  signal.throwIfAborted()
  const channels = await copyChannels(audio, signal)
  // The decoder's full multichannel buffer leaves scope before starting the worker job.
  return {
    channels,
    sampleRate: audio.sampleRate,
    identity: `memory:${audioNamespace}:${++audioSequence}`,
  }
}

export async function buildBeatTimeline(
  source: string,
  signal: AbortSignal,
  onStatus: (status: BeatBuildStatus) => void,
  dependencies: BeatPreanalysisDependencies = {},
): Promise<BeatTimeline> {
  const started = performance.now()
  const savedTimeline = dependencies.checkpoint?.timeline
  let completedRanges: BeatTimeRange[] = savedTimeline
    ? normalizeBeatRanges(
        savedTimeline.completedRanges ?? [
          {
            startSeconds: 0,
            endSeconds: savedTimeline.builtUntilSeconds ?? savedTimeline.durationSeconds,
          },
        ],
        savedTimeline.durationSeconds,
      )
    : []
  let availableSeconds = beatRangesDuration(completedRanges)
  let activeRange: BeatTimeRange | undefined
  let durationSeconds = savedTimeline?.durationSeconds ?? dependencies.durationSeconds
  const update = (phase: BeatBuildStatus['phase'], progress = 0): void => {
    if (!signal.aborted)
      onStatus({
        phase,
        progress,
        error: null,
        availableSeconds,
        durationSeconds,
        completedRanges,
        activeRange,
        playbackSeconds: dependencies.getPrioritySeconds?.() ?? 0,
      })
  }
  signal.throwIfAborted()
  const duration = dependencies.durationSeconds
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('暂时无法确定歌曲时长，稍后可重新构建高亮')
  }
  // Reject long tracks before native decoding allocates the full PCM buffer.
  // Metadata can be inaccurate, so validate actual decoded dimensions again below.
  if (duration > MAX_DURATION_SECONDS || duration * 48000 * 2 > MAX_PCM_SAMPLES) {
    throw new Error('这首歌曲过长，已跳过高亮构建，播放不受影响')
  }
  const audioCache = dependencies.audioCache ?? sharedAudioCache
  const resultCache = dependencies.resultCache ?? beatResultCache.store
  const persistenceGeneration = resultCache.generation
  const persistent = dependencies.persistent
  const preparation = new AbortController()
  const abortPreparation = (): void => preparation.abort()
  signal.addEventListener('abort', abortPreparation, { once: true })
  let audio = audioCache.takePcm(source)
  let encoded: ArrayBuffer | undefined
  let identity = audio?.identity
  let persistenceKey: string | null = null
  let lease: BeatWorkerLease | undefined
  let sourcePreparation: Promise<void> | undefined
  let checkpoint = dependencies.checkpoint
  let restoredFromDisk = false
  const preparationMetrics: Pick<
    BeatAnalysisMetrics,
    | 'fetchMs'
    | 'hashMs'
    | 'cacheReadMs'
    | 'decodeMs'
    | 'modelPreparationMs'
    | 'cacheReadyMs'
    | 'cacheOrigin'
    | 'cacheOnly'
    | 'encodedBytes'
    | 'pcmBytes'
  > = {
    fetchMs: 0,
    hashMs: 0,
    cacheReadMs: 0,
    decodeMs: 0,
    modelPreparationMs: 0,
    cacheOrigin: 'none',
    cacheOnly: false,
    encodedBytes: 0,
    pcmBytes: audio
      ? [...new Set(audio.channels.map((channel) => channel.buffer))].reduce(
          (sum, buffer) => sum + buffer.byteLength,
          0,
        )
      : 0,
  }
  const publishPartial = (timeline: BeatTimeline): void => {
    completedRanges = normalizeBeatRanges(
      timeline.completedRanges ?? [
        { startSeconds: 0, endSeconds: timeline.builtUntilSeconds ?? timeline.durationSeconds },
      ],
      timeline.durationSeconds,
    )
    availableSeconds = beatRangesDuration(completedRanges)
    durationSeconds = timeline.durationSeconds
    dependencies.onPartial?.(timeline)
  }
  const canRestore = (): boolean =>
    persistenceGeneration === resultCache.generation && !!persistent?.eligible()
  const registerPersistence = (): void => {
    persistenceKey =
      persistent && identity?.startsWith('sha256:')
        ? JSON.stringify([
            BEAT_RESULT_VERSION,
            persistent.trackKey,
            dependencies.modelId ? BEAT_THIS_MODELS[dependencies.modelId].version : 'basic',
            identity,
          ])
        : null
    if (!persistenceKey || !persistent) return
    const contextKey = JSON.stringify([source, dependencies.modelId ?? 'basic'])
    persistenceContexts.delete(contextKey)
    persistenceContexts.set(contextKey, {
      key: persistenceKey,
      trackKey: persistent.trackKey,
      generation: persistenceGeneration,
      store: resultCache,
    })
    while (persistenceContexts.size > 6)
      persistenceContexts.delete(persistenceContexts.keys().next().value!)
  }
  const hashEncoded = async (bytes: ArrayBuffer): Promise<void> => {
    const hashStarted = performance.now()
    try {
      const hash = await cancellable(
        () => fingerprint(bytes),
        preparation.signal,
        30_000,
        '音频校验超时',
      )
      preparation.signal.throwIfAborted()
      if (hash) identity = hash
    } catch (error) {
      if (preparation.signal.aborted) throw error
      // Without a verifiable digest the normal in-memory build remains available.
    } finally {
      preparationMetrics.hashMs = performance.now() - hashStarted
    }
  }
  const prepareSource = (): Promise<void> => {
    sourcePreparation ??= (async () => {
      preparation.signal.throwIfAborted()
      if (audio) {
        if (persistent && !identity?.startsWith('sha256:')) {
          const cachedEncoded = audioCache.readEncoded(source)
          if (cachedEncoded) {
            preparationMetrics.encodedBytes = cachedEncoded.byteLength
            await hashEncoded(cachedEncoded)
            audio.identity = identity
          }
        }
        registerPersistence()
        return
      }
      encoded = audioCache.readEncoded(source)
      if (encoded && encoded.byteLength > (dependencies.maxAudioBytes ?? MAX_AUDIO_BYTES)) {
        audioCache.delete(source)
        encoded = undefined
      }
      if (!encoded) {
        update('fetching')
        const fetchStarted = performance.now()
        try {
          encoded = await readAudio(
            source,
            preparation.signal,
            (progress) => update('fetching', progress),
            dependencies,
          )
        } finally {
          preparationMetrics.fetchMs = performance.now() - fetchStarted
        }
        preparation.signal.throwIfAborted()
        audioCache.putEncoded(source, encoded)
      }
      preparationMetrics.encodedBytes = encoded.byteLength
      // decodeAudioData may detach its input. Verify the exact complete bytes first.
      if (persistent) await hashEncoded(encoded)
      registerPersistence()
    })()
    return sourcePreparation
  }
  const decodeSource = async (): Promise<void> => {
    await prepareSource()
    preparation.signal.throwIfAborted()
    if (audio) return
    update('decoding')
    const decodeStarted = performance.now()
    try {
      audio = await decodeChannels(encoded!, preparation.signal, dependencies)
      if (identity) audio.identity = identity
      identity = audio.identity
      preparationMetrics.pcmBytes = [
        ...new Set(audio.channels.map((channel) => channel.buffer)),
      ].reduce((sum, buffer) => sum + buffer.byteLength, 0)
    } catch (error) {
      // Cancelled siblings preserve compressed audio; malformed audio is retried fresh.
      if (!preparation.signal.aborted) audioCache.delete(source)
      throw error
    } finally {
      preparationMetrics.decodeMs = performance.now() - decodeStarted
      encoded = undefined
    }
  }
  const matchesAudio = (saved: BeatAnalysisCheckpoint): boolean => {
    if (!audio) return true
    try {
      const decodedDuration = audio.channels[0]!.length / audio.sampleRate
      validateBeatCheckpoint(
        saved,
        {
          sampleRate: audio.sampleRate,
          sampleCount: audio.channels[0]!.length,
          channels: audio.channels.length,
          modelId: dependencies.modelId ?? 'basic',
        },
        dependencies.modelId
          ? beatThisWindows(Math.floor(decodedDuration * BEAT_THIS_FPS) + 1, decodedDuration).length
          : Math.ceil(decodedDuration / 10),
      )
      return true
    } catch {
      return false
    }
  }
  const matchesCache = (saved: BeatAnalysisCheckpoint, checkMetadata = true): boolean =>
    validPersistentCheckpoint(saved) &&
    saved.signature.modelId === (dependencies.modelId ?? 'basic') &&
    // Media metadata and decoder padding can differ slightly. Content hashes are
    // authoritative, while this rejects a stale/malformed duration before decode.
    (!checkMetadata || Math.abs(saved.timeline.durationSeconds - duration) <= 0.25) &&
    matchesAudio(saved)
  const enoughCoverage = (saved: BeatAnalysisCheckpoint): boolean => {
    const target = dependencies.getBufferSeconds?.()
    const savedDuration = saved.timeline.durationSeconds
    const time =
      target === undefined
        ? 0
        : (dependencies.getPlaybackState?.().timeSeconds ??
          dependencies.getPrioritySeconds?.() ??
          0)
    if (
      !Number.isFinite(time) ||
      (target !== undefined && (!Number.isFinite(target) || target < 0))
    )
      return false
    const playhead = Math.max(0, Math.min(savedDuration, time))
    return (
      continuousBeatCoverage(
        saved.timeline.completedRanges ?? [
          { startSeconds: 0, endSeconds: saved.timeline.builtUntilSeconds ?? savedDuration },
        ],
        playhead,
        savedDuration,
      ) +
        0.01 >=
      Math.min(target ?? savedDuration, savedDuration - playhead)
    )
  }
  const publishCached = (saved: BeatAnalysisCheckpoint, origin: 'memory' | 'persistent'): void => {
    preparation.signal.throwIfAborted()
    preparationMetrics.cacheOrigin = origin
    preparationMetrics.cacheReadyMs = performance.now() - started
    dependencies.onCheckpoint?.(saved)
    preparation.signal.throwIfAborted()
    if (origin === 'persistent' && !canRestore()) return
    publishPartial(saved.timeline)
    preparation.signal.throwIfAborted()
    update(
      enoughCoverage(saved) ? 'buffered' : 'analysing',
      availableSeconds / saved.timeline.durationSeconds,
    )
  }
  const returnCached = (saved: BeatAnalysisCheckpoint): BeatTimeline => {
    preparation.signal.throwIfAborted()
    dependencies.onMetrics?.({
      initializationMs: 0,
      inferenceMs: 0,
      sessionReused: false,
      ...preparationMetrics,
      cacheOnly: true,
      totalMs: performance.now() - started,
    })
    preparation.signal.throwIfAborted()
    return saved.timeline
  }
  try {
    // In-memory checkpoints are already scoped to this source/model by the caller.
    // Validate before taking this fast path, and never acquire an inference lease.
    if (checkpoint && matchesCache(checkpoint, false)) {
      registerPersistence()
      publishCached(checkpoint, 'memory')
      if (enoughCoverage(checkpoint)) return returnCached(checkpoint)
    } else checkpoint = undefined

    if (!checkpoint && persistent && canRestore()) {
      await prepareSource()
      preparation.signal.throwIfAborted()
      if (persistenceKey && canRestore()) {
        const readStarted = performance.now()
        let restored: BeatAnalysisCheckpoint | null = null
        try {
          restored = await cancellable(
            () => resultCache.get(persistenceKey!),
            preparation.signal,
            2000,
            '节拍缓存读取超时',
          )
        } catch (error) {
          if (preparation.signal.aborted) throw error
        } finally {
          preparationMetrics.cacheReadMs = performance.now() - readStarted
        }
        preparation.signal.throwIfAborted()
        if (restored && canRestore() && matchesCache(restored)) {
          checkpoint = restored
          restoredFromDisk = true
          publishCached(restored, 'persistent')
          if (canRestore() && enoughCoverage(restored)) return returnCached(restored)
        }
      }
    }
    preparation.signal.throwIfAborted()
    let modelReady = !dependencies.modelId
    const prepareModel = async (): Promise<BeatThisModelAssets | undefined> => {
      preparation.signal.throwIfAborted()
      if (!dependencies.modelId) return undefined
      const modelStarted = performance.now()
      try {
        update('loading-model')
        if (
          dependencies.reuseModelSession ??
          (!dependencies.createWorker && !dependencies.readModel)
        ) {
          lease = await acquireBeatModelSession(dependencies.modelId, preparation.signal)
          lease.signal.addEventListener('abort', abortPreparation, { once: true })
          if (lease.signal.aborted) preparation.abort()
          preparation.signal.throwIfAborted()
          if (lease.ready) {
            modelReady = true
            return undefined
          }
        }
        const readModel = dependencies.readModel ?? readBeatThisModel
        const model = await cancellable<BeatThisModelAssets>(
          () => readModel(dependencies.modelId!, preparation.signal),
          preparation.signal,
          FETCH_TIMEOUT_MS,
          '模型读取超时，请重新尝试',
        )
        modelReady = true
        return model
      } finally {
        preparationMetrics.modelPreparationMs = performance.now() - modelStarted
      }
    }
    // Ordinary builds still overlap model preparation and audio fetch/decode.
    // A cache candidate is resolved first so it never waits on unavailable assets.
    const [model] = await Promise.all([
      prepareModel(),
      decodeSource().then(() => {
        if (!modelReady && !preparation.signal.aborted) update('loading-model')
      }),
    ]).catch((error: unknown) => {
      preparation.abort()
      throw error
    })
    preparation.signal.throwIfAborted()
    const { channels, sampleRate } = audio!
    durationSeconds = channels[0]!.length / sampleRate
    if (checkpoint && (!matchesAudio(checkpoint) || (restoredFromDisk && !canRestore()))) {
      checkpoint = undefined
      preparationMetrics.cacheOrigin = 'none'
      delete preparationMetrics.cacheReadyMs
      // Replace a previously published partial cache if the decoder or generation
      // invalidates it; stale coverage must not become the next resume checkpoint.
      const empty = createBeatCheckpoint(
        {
          sampleRate,
          sampleCount: channels[0]!.length,
          channels: channels.length,
          modelId: dependencies.modelId ?? 'basic',
        },
        createBeatTimelineBuffer(durationSeconds),
        new Set(),
        0,
      )
      dependencies.onCheckpoint?.(empty)
      publishPartial(empty.timeline)
    }
    update('analysing')
    return await analyse(
      channels,
      sampleRate,
      preparation.signal,
      (progress, nextRange) => {
        activeRange = nextRange
        update('analysing', progress)
      },
      {
        ...dependencies,
        checkpoint,
        onMetrics: (metrics) => dependencies.onMetrics?.({ ...metrics, ...preparationMetrics }),
        onCheckpoint: (next) => {
          dependencies.onCheckpoint?.(next)
          if (persistenceKey && persistent && canRestore() && !preparation.signal.aborted)
            void resultCache
              .set(persistenceKey, persistent.trackKey, next, persistenceGeneration)
              .catch(() => {})
        },
        onPartial: publishPartial,
      },
      model,
      (returned) => audioCache.putPcm(source, returned),
      lease,
      started,
      audio!.identity,
    )
  } finally {
    signal.removeEventListener('abort', abortPreparation)
    lease?.signal.removeEventListener('abort', abortPreparation)
    lease?.release(false)
    preparation.abort()
    if (audio) audioCache.putPcm(source, audio)
  }
}
