import { httpFetch } from './http'
import { toRaw } from 'vue'
import { LruCache } from '../core/util/lru-cache'
import type { LyricLine, LyricProviderSource, Track } from '../core/types'
import { mergeLyricAnnotations } from '../core/lyrics'
import { parseAnyLyrics } from '../core/lyrics'
import { getWordLyricsCacheToken, loadWordLyrics, type WordLyricsQuery } from './lyrics-db'
import { getNativeLyricsCacheToken, loadNativeLyrics, toNativeLyricsQuery } from './native-lyrics'
import {
  acquireLyricsRequest,
  initializeLyricsPriority,
  subscribeLyricsPriority,
} from './lyrics-requests'
import type { RequestPriority } from '../core/util/priority-request-queue'

interface LyricsCacheEntry {
  promise: Promise<string>
  ready: boolean
  settled: boolean
  subscribers: number
  controller: AbortController
}

interface TrackLyricsCacheEntry {
  cacheKey: string
  sourceToken: object | null
  promise: Promise<LyricLine[]>
  ready: boolean
  settled: boolean
  controller: AbortController
  subscribers: number
  latestLines: LyricLine[] | null
  listeners: Set<LyricsProgressListener>
}

export type LyricsProgressListener = (lines: LyricLine[]) => void

const lyricsCache = new LruCache<string, LyricsCacheEntry>(64)
const trackLyricsCache = new LruCache<string, TrackLyricsCacheEntry>(64)
const trackLyricsProviders = new WeakMap<Track, TrackLyricsProvider>()
const lyricsSources = new WeakMap<LyricLine[], LyricProviderSource>()

/** 只读实际加载结果的来源,未知提供者与空歌词都不猜测。 */
export function getLyricsSource(lines: LyricLine[]): LyricProviderSource | null {
  return lines.length ? (lyricsSources.get(toRaw(lines)) ?? null) : null
}

function recordLyricsSource(lines: LyricLine[], source: LyricProviderSource): void {
  if (lines.length) lyricsSources.set(toRaw(lines), source)
}

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

/**
 * 取歌词文本的传输层。缓存、去重、超时、取消都在本模块里,与传输方式无关;
 * 换平台只需换这一个函数 —— 桌面端可以走系统 HTTP(绕开 CORS)或直接读本地文件。
 * 失败时抛错即可,调用方按错误处理;收到 abort 信号时应尽快中止。
 */
export type LyricsTextFetcher = (url: string, signal: AbortSignal) => Promise<string>

const fetchLyricsTextViaHttp: LyricsTextFetcher = async (url, signal) => {
  const response = await httpFetch(url, { cache: 'force-cache', signal })
  if (!response.ok) throw new Error('Lyrics request failed')
  return response.text()
}

let fetchLyricsText: LyricsTextFetcher = fetchLyricsTextViaHttp

/** 替换歌词文本的取用方式。传 null 恢复为浏览器的 fetch */
export function setLyricsTextFetcher(fetcher: LyricsTextFetcher | null): void {
  fetchLyricsText = fetcher ?? fetchLyricsTextViaHttp
}

export interface TrackLyricsProvider {
  cacheKey: string
  /** 来源固定的提供者可声明此字段;组合提供者按实际胜出的分支记录来源。 */
  source?: LyricProviderSource
  priority?: number
  isCached?: () => boolean
  /** 已完成结果是否仍可复用;每次读取缓存都重新检查来源的有效期。 */
  cacheable?: () => boolean
  /** 来源本次缓存的稳定标识;重新获取或恢复缓存后应更换,失效时返回 null。 */
  cacheToken?: () => object | null
  load: (signal?: AbortSignal, onProgress?: LyricsProgressListener) => Promise<LyricLine[]>
}

function trackLyricsKey(track: Track): Track {
  return toRaw(track) as Track
}

export function loadLyricsText(url: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(createAbortReason(signal))
  const existing = lyricsCache.get(url)
  if (existing && !existing.controller.signal.aborted) return subscribeText(existing, signal, url)
  const controller = new AbortController()
  initializeLyricsPriority(controller.signal)
  const entry: LyricsCacheEntry = {
    ready: false,
    settled: false,
    subscribers: 0,
    controller,
    promise: Promise.resolve(''),
  }
  // Subscribe before starting IO so speculative requests enter the shared budget at low priority.
  lyricsCache.set(url, entry)
  const releasePriority = subscribeLyricsPriority(controller.signal, signal)
  const timer = setTimeout(
    () => controller.abort(createLyricsTimeoutError()),
    LYRICS_FETCH_TIMEOUT_MS,
  )
  entry.promise = (async () => {
    const release = await acquireLyricsRequest(controller.signal)
    try {
      controller.signal.throwIfAborted()
      const text = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(controller.signal.reason)
        controller.signal.addEventListener('abort', abort, { once: true })
        Promise.resolve()
          .then(() => fetchLyricsText(url, controller.signal))
          .then(resolve, reject)
          .finally(() => controller.signal.removeEventListener('abort', abort))
      })
      controller.signal.throwIfAborted()
      entry.ready = true
      return text
    } finally {
      release()
    }
  })()
    .catch((error: unknown) => {
      if (lyricsCache.get(url) === entry) lyricsCache.delete(url)
      throw controller.signal.aborted ? controller.signal.reason : error
    })
    .finally(() => {
      entry.settled = true
      clearTimeout(timer)
    })
  const result = subscribeText(entry, signal, url)
  releasePriority()
  return result
}

function subscribeText(
  entry: LyricsCacheEntry,
  signal: AbortSignal | undefined,
  url: string,
): Promise<string> {
  if (entry.ready) return entry.promise
  const releasePriority = subscribeLyricsPriority(entry.controller.signal, signal)
  entry.subscribers += 1
  return new Promise((resolve, reject) => {
    let finished = false
    const finish = (error: unknown, text?: string) => {
      if (finished) return
      finished = true
      signal?.removeEventListener('abort', abort)
      releasePriority()
      entry.subscribers -= 1
      if (!entry.subscribers && !entry.settled && !entry.ready) {
        if (lyricsCache.get(url) === entry) lyricsCache.delete(url)
        entry.controller.abort()
      }
      if (error !== undefined) reject(error)
      else resolve(text!)
    }
    const abort = () => finish(createAbortReason(signal!))
    signal?.addEventListener('abort', abort, { once: true })
    entry.promise.then(
      (text) => finish(undefined, text),
      (error: unknown) => finish(error),
    )
  })
}

function createAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function attachTrackLyricsSubscriber(
  entry: TrackLyricsCacheEntry,
  signal: AbortSignal | undefined,
  onProgress?: LyricsProgressListener,
): Promise<LyricLine[]> {
  if (signal?.aborted) return Promise.reject(createAbortReason(signal))
  if (onProgress && entry.latestLines) onProgress(entry.latestLines)
  if (entry.ready) return entry.promise

  const releasePriority = subscribeLyricsPriority(entry.controller.signal, signal)
  entry.subscribers += 1
  if (onProgress) entry.listeners.add(onProgress)
  let active = true

  const release = () => {
    if (!active) return
    active = false
    releasePriority()
    if (onProgress) entry.listeners.delete(onProgress)
    entry.subscribers = Math.max(0, entry.subscribers - 1)
    if (entry.subscribers === 0 && !entry.ready && !entry.settled) {
      if (trackLyricsCache.get(entry.cacheKey) === entry) trackLyricsCache.delete(entry.cacheKey)
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
  // 统一按内容特征选解析器;没有真实音节时保留整行高亮。
  return parseAnyLyrics(text)
}

export interface CombinedLyricsOptions {
  /** 普通歌词地址(LRC / 增强型 LRC / QRC 均可) */
  lyricsUrl?: string
  /** 逐字歌词库查询条件,命中时优先于 lyricsUrl */
  wordQuery?: WordLyricsQuery
}

const combinedSourceTokens = new WeakMap<object, WeakMap<object, object>>()

/** 两个来源分别过期/刷新时合并缓存都失效;相同来源版本始终返回同一个对象。 */
export function getCombinedLyricsCacheToken(query: WordLyricsQuery): object | null {
  const wordToken = getWordLyricsCacheToken(query)
  if (!wordToken) return null
  const nativeQuery = toNativeLyricsQuery(query)
  if (!nativeQuery) return wordToken
  const nativeToken = getNativeLyricsCacheToken(nativeQuery)
  if (!nativeToken) return null
  let nativeTokens = combinedSourceTokens.get(wordToken)
  if (!nativeTokens) {
    nativeTokens = new WeakMap()
    combinedSourceTokens.set(wordToken, nativeTokens)
  }
  let combined = nativeTokens.get(nativeToken)
  if (!combined) {
    combined = {}
    nativeTokens.set(nativeToken, combined)
  }
  return combined
}

/**
 * 三路并行,先到的先显示。主时间轴优先 AMLL,其次平台 YRC/QRC,最后普通歌词。
 * 缺失的翻译/音译由其他来源补齐;增强来源失败不打断已可用的歌词。
 */
export async function loadCombinedLyrics(
  options: CombinedLyricsOptions,
  signal?: AbortSignal,
  onProgress?: LyricsProgressListener,
): Promise<LyricLine[]> {
  const nativeQuery = options.wordQuery ? toNativeLyricsQuery(options.wordQuery) : null
  let wordLines: LyricLine[] | null = null
  let nativeLines: LyricLine[] | null = null
  let lrcLines: LyricLine[] = []
  let combinedLines = lrcLines
  let previousPrimary: LyricLine[] | null = null
  let previousNative: LyricLine[] | null = null
  let richPrimary = lrcLines
  let previousRich: LyricLine[] | null = null
  let previousLrc: LyricLine[] | null = null
  const publish = () => {
    if (signal?.aborted) return
    const primary = wordLines?.length ? wordLines : nativeLines?.length ? nativeLines : lrcLines
    const donor = primary === wordLines ? nativeLines : null
    if (primary !== previousPrimary || donor !== previousNative) {
      richPrimary = donor ? mergeLyricAnnotations(primary, donor) : primary
      previousPrimary = primary
      previousNative = donor
    }
    if (richPrimary === previousRich && lrcLines === previousLrc) return
    const available =
      richPrimary === lrcLines ? richPrimary : mergeLyricAnnotations(richPrimary, lrcLines)
    const source: LyricProviderSource = wordLines?.length
      ? 'amll'
      : nativeLines?.length && nativeQuery
        ? nativeQuery.source
        : 'meting'
    recordLyricsSource(available, source)
    previousRich = richPrimary
    previousLrc = lrcLines
    if (available === combinedLines) return
    combinedLines = available
    if (available.length) onProgress?.(available)
  }
  const wordTask = options.wordQuery
    ? loadWordLyrics(options.wordQuery, signal).then((lines) => {
        wordLines = lines
        publish()
        return lines
      })
    : Promise.resolve(null)
  const nativeTask = nativeQuery
    ? loadNativeLyrics(nativeQuery, signal).then((lines) => {
        nativeLines = lines
        publish()
        return lines
      })
    : Promise.resolve(null)
  const lrcTask = options.lyricsUrl
    ? loadLrcLyrics(options.lyricsUrl, signal).then((lines) => {
        lrcLines = lines
        publish()
        return lines
      })
    : Promise.resolve<LyricLine[]>([])

  // 单源失败不影响另一源,失败原因留到最后再决定是否抛出
  const [wordResult, nativeResult, lrcResult] = await Promise.allSettled([
    wordTask,
    nativeTask,
    lrcTask,
  ])
  if (signal?.aborted) throw createAbortReason(signal)
  // 各来源完成时已合并并发布;最终交付同一个数组,避免重复合并触发整面板重排。
  if (wordResult.status === 'fulfilled' && wordResult.value?.length) return combinedLines
  if (nativeResult.status === 'fulfilled' && nativeResult.value?.length) return combinedLines
  if (lrcResult.status === 'rejected') throw lrcResult.reason
  return combinedLines
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

function isTrackLyricsCacheCurrent(
  provider: TrackLyricsProvider,
  entry: TrackLyricsCacheEntry,
): boolean {
  if (provider.cacheable?.() === false) return false
  if (!provider.cacheToken) return true
  return entry.sourceToken !== null && entry.sourceToken === provider.cacheToken()
}

export function loadTrackLyrics(
  track: Track,
  signal?: AbortSignal,
  onProgress?: LyricsProgressListener,
  priority: RequestPriority = 'foreground',
): Promise<LyricLine[]> {
  if (priority === 'background' && signal) initializeLyricsPriority(signal, priority)
  const provider = trackLyricsProviders.get(trackLyricsKey(track))
  if (provider) {
    const existing = trackLyricsCache.get(provider.cacheKey)
    if (existing && (!existing.ready || isTrackLyricsCacheCurrent(provider, existing))) {
      return attachTrackLyricsSubscriber(existing, signal, onProgress)
    }
    if (existing) trackLyricsCache.delete(provider.cacheKey)
    if (signal?.aborted) return Promise.reject(createAbortReason(signal))

    const controller = new AbortController()
    initializeLyricsPriority(controller.signal)
    const releaseInitialPriority = subscribeLyricsPriority(controller.signal, signal)
    const entry: TrackLyricsCacheEntry = {
      cacheKey: provider.cacheKey,
      sourceToken: null,
      ready: false,
      settled: false,
      controller,
      subscribers: 0,
      latestLines: null,
      listeners: new Set(),
      promise: Promise.resolve([]),
    }
    const publish = (lines: LyricLine[]) => {
      if (controller.signal.aborted || entry.latestLines === lines) return
      if (provider.source) recordLyricsSource(lines, provider.source)
      entry.latestLines = lines
      for (const listener of entry.listeners) listener(lines)
    }
    entry.promise = provider
      .load(controller.signal, publish)
      .then((lines) => {
        entry.ready = true
        entry.settled = true
        entry.sourceToken = provider.cacheToken?.() ?? null
        publish(lines)
        if (
          !isTrackLyricsCacheCurrent(provider, entry) &&
          trackLyricsCache.get(provider.cacheKey) === entry
        ) {
          trackLyricsCache.delete(provider.cacheKey)
        }
        return lines
      })
      .catch((error) => {
        entry.settled = true
        if (trackLyricsCache.get(provider.cacheKey) === entry)
          trackLyricsCache.delete(provider.cacheKey)
        throw error
      })
    trackLyricsCache.set(provider.cacheKey, entry)
    const result = attachTrackLyricsSubscriber(entry, signal, onProgress)
    releaseInitialPriority()
    return result
  }
  return Promise.resolve([])
}

export function hasTrackLyricsSource(track: Track | null | undefined): boolean {
  return Boolean(track && trackLyricsProviders.has(trackLyricsKey(track)))
}

export function hasCachedTrackLyrics(track: Track): boolean {
  const provider = trackLyricsProviders.get(trackLyricsKey(track))
  // LRC 的永久缓存不能掩盖逐字来源的 TTL,否则预加载/重播会一直复用旧的合并结果。
  if (provider?.cacheable?.() === false) return false
  const entry = provider ? trackLyricsCache.get(provider.cacheKey) : undefined
  if (provider && entry?.ready) return isTrackLyricsCacheCurrent(provider, entry)
  if (provider?.isCached) return provider.isCached()
  return false
}
