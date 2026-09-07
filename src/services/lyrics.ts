import { toRaw } from 'vue'
import { LruCache } from '../utils/lru-cache'
import type { LyricLine, Track } from '../types/music'
import { mergeLyricTranslations } from '../utils/lyrics'
import { parseAnyLyrics } from '../utils/lyrics-source'
import { loadWordLyrics, type WordLyricsQuery } from './lyrics-db'

interface LyricsCacheEntry {
  promise: Promise<string>
  ready: boolean
}

interface TrackLyricsCacheEntry {
  cacheKey: string
  promise: Promise<LyricLine[]>
  ready: boolean
  settled: boolean
  controller: AbortController
  subscribers: number
}

const lyricsCache = new LruCache<string, LyricsCacheEntry>(64)
const trackLyricsCache = new LruCache<string, TrackLyricsCacheEntry>(64)
const trackLyricsProviders = new WeakMap<Track, TrackLyricsProvider>()

// 歌词请求的默认超时时间（毫秒）
const LYRICS_FETCH_TIMEOUT_MS = 8000

// 缓存层超时错误的标识 name,供调用方与真正的用户取消(AbortError)区分
export const LYRICS_TIMEOUT_ERROR_NAME = 'LyricsTimeoutError'

export function createLyricsTimeoutError(): Error {
  const error = new Error(`Lyrics request timed out after ${LYRICS_FETCH_TIMEOUT_MS}ms`)
  error.name = LYRICS_TIMEOUT_ERROR_NAME
  return error
}

export function isLyricsTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === LYRICS_TIMEOUT_ERROR_NAME
}

export interface TrackLyricsProvider {
  cacheKey: string
  priority?: number
  isCached?: () => boolean
  load: (signal?: AbortSignal) => Promise<LyricLine[]>
}

function trackLyricsKey(track: Track): Track {
  return toRaw(track) as Track
}

export function loadLyricsText(url: string, signal?: AbortSignal): Promise<string> {
  const existing = lyricsCache.get(url)
  if (existing) return withAbortSignal(existing.promise, signal, existing.ready)
  if (signal?.aborted) return Promise.reject(createAbortReason(signal))

  // 本地 controller 只负责缓存层请求超时。调用方 abort 只取消自己的等待,
  // 不取消共享 fetch,避免快速切歌时把同 URL 的预加载/后续请求一起误伤。
  // 超时通过 abort(reason) 标记为可区分的超时错误,不会以 AbortError 形式暴露给订阅者。
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(createLyricsTimeoutError()),
    LYRICS_FETCH_TIMEOUT_MS,
  )

  const entry: LyricsCacheEntry = {
    ready: false,
    promise: Promise.resolve(''),
  }

  // 清理本次缓存层请求占用的资源。
  const cleanup = () => {
    clearTimeout(timer)
  }

  entry.promise = fetch(url, { cache: 'force-cache', signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error('Lyrics request failed')
      return response.text()
    })
    .then((text) => {
      entry.ready = true
      cleanup()
      return text
    })
    .catch((error) => {
      // 超时或外部 abort 触发时，从 in-flight 缓存中移除该 URL。
      // 规范实现下 fetch 会以 signal.reason reject;不透传 reason 的环境里
      // 本地 controller 中止只会产生 AbortError,这里统一归一为 abort 时记录的原因,
      // 保证超时始终以 LyricsTimeoutError 而不是 AbortError 暴露给订阅者。
      lyricsCache.delete(url)
      cleanup()
      if (
        controller.signal.aborted &&
        error instanceof DOMException &&
        error.name === 'AbortError'
      ) {
        throw controller.signal.reason ?? error
      }
      throw error
    })

  lyricsCache.set(url, entry)
  return withAbortSignal(entry.promise, signal, false)
}

function withAbortSignal(
  promise: Promise<string>,
  signal: AbortSignal | undefined,
  alreadyReady: boolean,
): Promise<string> {
  return withAbortSignalGeneric(promise, signal, alreadyReady)
}

function withAbortSignalGeneric<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  alreadyReady: boolean,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(createAbortReason(signal))
  if (alreadyReady) return promise

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(createAbortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (text) => {
        cleanup()
        resolve(text)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

function createAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function attachTrackLyricsSubscriber(
  entry: TrackLyricsCacheEntry,
  signal: AbortSignal | undefined,
): Promise<LyricLine[]> {
  if (signal?.aborted) return Promise.reject(createAbortReason(signal))
  if (entry.ready) return entry.promise

  entry.subscribers += 1
  let active = true

  const release = () => {
    if (!active) return
    active = false
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers === 0 && !entry.ready && !entry.settled) {
      trackLyricsCache.delete(entry.cacheKey)
      entry.controller.abort()
    }
  }

  if (!signal) {
    return entry.promise.finally(release)
  }

  return new Promise<LyricLine[]>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      release()
      reject(createAbortReason(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    entry.promise.then(
      (lines) => {
        cleanup()
        release()
        resolve(lines)
      },
      (error) => {
        cleanup()
        release()
        reject(error)
      },
    )
  })
}

export function hasCachedLyrics(url: string): boolean {
  if (!lyricsCache.has(url)) return false
  return lyricsCache.get(url)?.ready ?? false
}

export async function loadLrcLyrics(url: string, signal?: AbortSignal): Promise<LyricLine[]> {
  const text = await loadLyricsText(url, signal)
  // 扩展名不代表内容:后台上传的 .lrc 可能是 QRC/TTML,Meting 也可能返回增强型 LRC。
  // 统一按内容特征选解析器,并在这里补齐逐字时间轴(没有真实音节时按字符权重插值)
  return parseAnyLyrics(text)
}

export interface CombinedLyricsOptions {
  /** 普通歌词地址(LRC / 增强型 LRC / QRC 均可) */
  lyricsUrl?: string
  /** 逐字歌词库查询条件,命中时优先于 lyricsUrl */
  wordQuery?: WordLyricsQuery
}

/**
 * 逐字歌词库与普通歌词并行拉取,命中逐字数据时优先使用它,并把普通歌词里的
 * 译文补回逐字行(TTML 不一定带译文)。逐字查询失败不影响普通歌词;
 * 只有在逐字也没命中时,普通歌词的失败才会向上抛出为 error 态。
 */
export async function loadCombinedLyrics(
  options: CombinedLyricsOptions,
  signal?: AbortSignal,
): Promise<LyricLine[]> {
  const wordTask = options.wordQuery
    ? loadWordLyrics(options.wordQuery, signal)
    : Promise.resolve(null)
  const lrcTask = options.lyricsUrl
    ? loadLrcLyrics(options.lyricsUrl, signal)
    : Promise.resolve<LyricLine[]>([])

  // 单源失败不影响另一源,失败原因留到最后再决定是否抛出
  const [wordResult, lrcResult] = await Promise.allSettled([wordTask, lrcTask])
  const wordLines = wordResult.status === 'fulfilled' ? wordResult.value : null
  const lrcLines = lrcResult.status === 'fulfilled' ? lrcResult.value : []

  if (wordLines?.length) return mergeLyricTranslations(wordLines, lrcLines)
  if (lrcResult.status === 'rejected') throw lrcResult.reason
  return lrcLines
}

export function registerTrackLyrics(track: Track, provider: TrackLyricsProvider) {
  trackLyricsProviders.set(trackLyricsKey(track), provider)
}

export function transferTrackLyricsProvider(source: Track, target: Track) {
  const targetKey = trackLyricsKey(target)
  const provider = trackLyricsProviders.get(trackLyricsKey(source))
  if (provider) {
    trackLyricsProviders.set(targetKey, provider)
  } else {
    trackLyricsProviders.delete(targetKey)
  }
}

export function mergeTrackLyricsProvider(source: Track, target: Track) {
  const sourceProvider = trackLyricsProviders.get(trackLyricsKey(source))
  if (!sourceProvider) return
  const targetKey = trackLyricsKey(target)
  const targetProvider = trackLyricsProviders.get(targetKey)
  if (targetProvider && (targetProvider.priority ?? 0) >= (sourceProvider.priority ?? 0)) return
  transferTrackLyricsProvider(source, target)
}

export function loadTrackLyrics(track: Track, signal?: AbortSignal): Promise<LyricLine[]> {
  const provider = trackLyricsProviders.get(trackLyricsKey(track))
  if (provider) {
    const existing = trackLyricsCache.get(provider.cacheKey)
    if (existing) return attachTrackLyricsSubscriber(existing, signal)
    if (signal?.aborted) return Promise.reject(createAbortReason(signal))

    const controller = new AbortController()
    const entry: TrackLyricsCacheEntry = {
      cacheKey: provider.cacheKey,
      ready: false,
      settled: false,
      controller,
      subscribers: 0,
      promise: Promise.resolve([]),
    }
    entry.promise = provider
      .load(controller.signal)
      .then((lines) => {
        entry.ready = true
        entry.settled = true
        return lines
      })
      .catch((error) => {
        entry.settled = true
        trackLyricsCache.delete(provider.cacheKey)
        throw error
      })
    trackLyricsCache.set(provider.cacheKey, entry)
    return attachTrackLyricsSubscriber(entry, signal)
  }
  return Promise.resolve([])
}

export function hasTrackLyricsSource(track: Track | null | undefined): boolean {
  return Boolean(track && trackLyricsProviders.has(trackLyricsKey(track)))
}

export function hasCachedTrackLyrics(track: Track): boolean {
  const provider = trackLyricsProviders.get(trackLyricsKey(track))
  if (provider && (trackLyricsCache.get(provider.cacheKey)?.ready ?? false)) return true
  if (provider?.isCached) return provider.isCached()
  return false
}
