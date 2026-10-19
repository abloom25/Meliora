import {
  beatRangesDuration,
  normalizeBeatRanges,
  type BeatBuildStatus,
  type BeatTimeline,
  type BeatTimeRange,
} from '../../core/analysis/beat-timeline'
import type { BeatPreanalysisResponse } from '../../core/analysis/beat-preanalysis-protocol'
import type { BeatThisModelId } from '../../core/analysis/beat-this-models'
import type { BeatThisBuildRequest } from '../../core/analysis/beat-this-protocol'
import type { BeatPlaybackState } from '../../core/analysis/beat-scheduling'
import type { BeatAnalysisCheckpoint } from '../../core/analysis/beat-checkpoint'
import { httpFetch, type HttpFetcher } from '../../services/http'
import { readBeatThisModel } from './useBeatThisModels'
import { createBeatAudioCache, type BeatAudioCache, type BeatAudioData } from './beat-audio-cache'

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

export type BeatTimelineBuilder = (
  source: string,
  signal: AbortSignal,
  onStatus: (status: BeatBuildStatus) => void,
  dependencies?: BeatPreanalysisDependencies,
) => Promise<BeatTimeline>

export interface BeatPreanalysisDependencies {
  /** Read from the active media element before requesting a full-file decode. */
  durationSeconds?: number
  modelId?: BeatThisModelId
  onPartial?: (timeline: BeatTimeline) => void
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
  readModel?: (
    id: BeatThisModelId,
    signal: AbortSignal,
  ) => Promise<Pick<BeatThisBuildRequest, 'model' | 'filterbank' | 'wasmBinary' | 'wasmPaths'>>
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
  model?: Pick<BeatThisBuildRequest, 'model' | 'filterbank' | 'wasmBinary' | 'wasmPaths'>,
  onAudioReturned?: (audio: BeatAudioData) => void,
): Promise<BeatTimeline> {
  return new Promise<BeatTimeline>((resolve, reject) => {
    signal.throwIfAborted()
    if (!dependencies.createWorker && typeof Worker === 'undefined') {
      reject(new Error('此浏览器无法在后台构建高亮，播放不受影响'))
      return
    }
    const worker = dependencies.createWorker
      ? dependencies.createWorker()
      : model
        ? new Worker(new URL('../../workers/beat-this.worker.ts', import.meta.url), {
            type: 'module',
          })
        : new Worker(new URL('../../workers/beat-preanalysis.worker.ts', import.meta.url), {
            type: 'module',
          })
    let settled = false
    let unsubscribePriority: (() => void) | undefined
    let unsubscribeYield: (() => void) | undefined
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      unsubscribePriority?.()
      unsubscribeYield?.()
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
      action()
    }
    const abort = (): void => finish(() => reject(abortError()))
    const timer = window.setTimeout(
      () => finish(() => reject(new Error('高亮构建超时，可稍后重试'))),
      dependencies.analysisTimeoutMs ?? (model ? MODEL_ANALYSIS_TIMEOUT_MS : ANALYSIS_TIMEOUT_MS),
    )
    signal.addEventListener('abort', abort, { once: true })
    const receive = (message: BeatPreanalysisResponse): void => {
      if (settled) return
      if (message.type === 'progress') {
        if (Number.isFinite(message.progress))
          onProgress(Math.max(0, Math.min(1, message.progress)), message.activeRange)
      } else if (message.type === 'partial') {
        if (message.checkpoint) dependencies.onCheckpoint?.(message.checkpoint)
        dependencies.onPartial?.(message.timeline)
        onProgress(Math.max(0, Math.min(1, message.progress)), message.activeRange)
      } else if (message.type === 'buffered') {
        onAudioReturned?.(message.audio as BeatAudioData)
        dependencies.onCheckpoint?.(message.checkpoint)
        dependencies.onPartial?.(message.checkpoint.timeline)
        const timeline = message.checkpoint.timeline
        onProgress(
          Math.min(
            1,
            beatRangesDuration(timeline.completedRanges ?? []) / timeline.durationSeconds,
          ),
        )
        finish(() => resolve(timeline))
      } else if (message.type === 'complete') {
        if (message.audio) onAudioReturned?.(message.audio as BeatAudioData)
        finish(() => resolve(message.timeline))
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
          prioritySeconds: dependencies.getPrioritySeconds?.() ?? 0,
          playback: dependencies.getPlaybackState?.(),
          checkpoint: dependencies.checkpoint,
          bufferSeconds: dependencies.getBufferSeconds?.(),
          maxWindows: dependencies.maxWindows,
          ...(model ? { ...model, modelId: dependencies.modelId } : {}),
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
): Promise<{ channels: Float32Array<ArrayBuffer>[]; sampleRate: number }> {
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
  return { channels, sampleRate: audio.sampleRate }
}

export async function buildBeatTimeline(
  source: string,
  signal: AbortSignal,
  onStatus: (status: BeatBuildStatus) => void,
  dependencies: BeatPreanalysisDependencies = {},
): Promise<BeatTimeline> {
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
  let model:
    | Pick<BeatThisBuildRequest, 'model' | 'filterbank' | 'wasmBinary' | 'wasmPaths'>
    | undefined
  if (dependencies.modelId) {
    update('loading-model')
    const readModel = dependencies.readModel ?? readBeatThisModel
    model = await readModel(dependencies.modelId, signal)
    signal.throwIfAborted()
  }
  const audioCache = dependencies.audioCache ?? sharedAudioCache
  let audio = audioCache.takePcm(source)
  if (!audio) {
    let encoded = audioCache.readEncoded(source)
    if (encoded && encoded.byteLength > (dependencies.maxAudioBytes ?? MAX_AUDIO_BYTES)) {
      audioCache.delete(source)
      encoded = undefined
    }
    if (!encoded) {
      update('fetching')
      encoded = await readAudio(
        source,
        signal,
        (progress) => update('fetching', progress),
        dependencies,
      )
      signal.throwIfAborted()
      audioCache.putEncoded(source, encoded)
    }
    update('decoding')
    try {
      audio = await decodeChannels(encoded, signal, dependencies)
    } catch (error) {
      // Interrupted native work can retry from the encoded copy. Invalid files
      // should be fetched again on an explicit retry instead of poisoning cache.
      if (!signal.aborted) audioCache.delete(source)
      throw error
    }
  }
  const { channels, sampleRate } = audio
  try {
    signal.throwIfAborted()
    durationSeconds = channels[0]!.length / sampleRate
    update('analysing')
    return await analyse(
      channels,
      sampleRate,
      signal,
      (progress, nextRange) => {
        activeRange = nextRange
        update('analysing', progress)
      },
      {
        ...dependencies,
        onPartial: (timeline) => {
          completedRanges = normalizeBeatRanges(
            timeline.completedRanges ?? [
              {
                startSeconds: 0,
                endSeconds: timeline.builtUntilSeconds ?? timeline.durationSeconds,
              },
            ],
            timeline.durationSeconds,
          )
          availableSeconds = beatRangesDuration(completedRanges)
          dependencies.onPartial?.(timeline)
        },
      },
      model,
      (returned) => audioCache.putPcm(source, returned),
    )
  } finally {
    // Before dispatch (or if postMessage failed), the main thread still owns the
    // PCM. After a successful transfer these views are detached and rejected.
    audioCache.putPcm(source, audio)
  }
}
