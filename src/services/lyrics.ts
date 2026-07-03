import { toRaw } from 'vue'
import { LruCache } from '../utils/lru-cache'
import type { LyricLine, Track } from '../types/music'
import { hasMeaningfulLyrics, parseLyrics } from '../utils/lyrics'

interface LyricsCacheEntry {
  promise: Promise<string>
  ready: boolean
}

const lyricsCache = new LruCache<string, LyricsCacheEntry>(64)
const trackLyricsProviders = new WeakMap<Track, TrackLyricsProvider>()

// 歌词请求的默认超时时间（毫秒）
const LYRICS_FETCH_TIMEOUT_MS = 8000

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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LYRICS_FETCH_TIMEOUT_MS)

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
      // 超时或外部 abort 触发时，从 in-flight 缓存中移除该 URL，并把原始异常抛出
      lyricsCache.delete(url)
      cleanup()
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
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(createAbortReason(signal))
  if (alreadyReady) return promise

  return new Promise<string>((resolve, reject) => {
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

export function hasCachedLyrics(url: string): boolean {
  if (!lyricsCache.has(url)) return false
  return lyricsCache.get(url)?.ready ?? false
}

export async function loadLrcLyrics(url: string, signal?: AbortSignal): Promise<LyricLine[]> {
  const text = await loadLyricsText(url, signal)
  const lines = parseLyrics(text)
  return hasMeaningfulLyrics(lines) ? lines : []
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
  if (provider) return provider.load(signal)
  return Promise.resolve([])
}

export function hasTrackLyricsSource(track: Track | null | undefined): boolean {
  return Boolean(track && trackLyricsProviders.has(trackLyricsKey(track)))
}

export function hasCachedTrackLyrics(track: Track): boolean {
  const provider = trackLyricsProviders.get(trackLyricsKey(track))
  if (provider?.isCached) return provider.isCached()
  return false
}
