import { LruCache } from '../utils/lru-cache'

interface LyricsCacheEntry {
  promise: Promise<string>
  ready: boolean
}

const lyricsCache = new LruCache<string, LyricsCacheEntry>(64)

// 歌词请求的默认超时时间（毫秒）
const LYRICS_FETCH_TIMEOUT_MS = 8000

export function loadLyricsText(url: string, signal?: AbortSignal): Promise<string> {
  const existing = lyricsCache.get(url)
  if (existing) return withAbortSignal(existing.promise, signal, existing.ready)

  // 本地 controller：负责超时中止；同时把外部 signal 的 abort 事件转发过来
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LYRICS_FETCH_TIMEOUT_MS)

  // 链接外部 signal：外部 abort → 本地 abort
  // 将 forwardAbort 存入 entry 以便 cleanup 时精准移除，防止误删其他请求的监听器
  const entry: LyricsCacheEntry & { forwardAbort?: () => void } = {
    ready: false,
    promise: Promise.resolve(''),
  }
  const forwardAbort = () => controller.abort(signal?.reason)
  entry.forwardAbort = forwardAbort
  if (signal) {
    if (signal.aborted) {
      controller.abort(signal.reason)
    } else {
      signal.addEventListener('abort', forwardAbort, { once: true })
    }
  }

  // 清理本次请求占用的资源（定时器与外部 signal 监听器）
  const cleanup = () => {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', entry.forwardAbort!)
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
  return entry.promise
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
