import type { NativeLyricsData, NativeLyricsSource } from '../../shared/native-lyrics'
import type { MusicServer } from '../../shared/music-config'
import {
  NATIVE_LYRICS_API_URL,
  NATIVE_LYRICS_NEGATIVE_TTL_MS,
  NATIVE_LYRICS_POSITIVE_TTL_MS,
  NATIVE_LYRICS_TIMEOUT_MS,
} from '../config/lyrics'
import { mergeLyricAnnotations, parseAnyLyrics } from '../core/lyrics'
import type { LyricLine } from '../core/types'
import { LruCache } from '../core/util/lru-cache'
import {
  isLyricsCacheRecord,
  LYRICS_CACHE_CAPACITY,
  LYRICS_CACHE_MAX_TEXT_LENGTH,
  type LyricsCacheStore,
} from '../core/platform/lyrics-cache'
import { webLyricsCacheStore } from '../platform/web/lyrics-cache'
import { httpFetch } from './http'
import {
  acquireLyricsRequest,
  initializeLyricsPriority,
  subscribeLyricsPriority,
} from './lyrics-requests'

export interface NativeLyricsQuery {
  source: NativeLyricsSource
  id: string
}

interface CachedNativeLyrics {
  lines: LyricLine[] | null
  expiresAt: number
}

interface PendingNativeLyrics {
  controller: AbortController
  promise: Promise<LyricLine[] | null>
  subscribers: number
  settled: boolean
}

interface NativeLookup {
  text: string | null
  lines: LyricLine[] | null
  definitive: boolean
}

const cachedLyrics = new LruCache<string, CachedNativeLyrics>(LYRICS_CACHE_CAPACITY)
const pendingLyrics = new Map<string, PendingNativeLyrics>()
let cacheStore: LyricsCacheStore = webLyricsCacheStore

export function toNativeLyricsQuery(query: {
  platform?: MusicServer
  id?: string
}): NativeLyricsQuery | null {
  const id = query.id?.trim()
  if (!id || (query.platform !== 'netease' && query.platform !== 'tencent')) return null
  return { source: query.platform === 'netease' ? 'netease' : 'qq', id }
}

export function nativeLyricsCacheKey(query: NativeLyricsQuery): string {
  return `native-lyrics:v1:${query.source}:${encodeURIComponent(query.id.trim())}`
}

export function setNativeLyricsCacheStore(store: LyricsCacheStore | null): void {
  cacheStore = store ?? webLyricsCacheStore
}

export function getNativeLyricsCacheToken(query: NativeLyricsQuery): object | null {
  const entry = cachedLyrics.get(nativeLyricsCacheKey(query))
  return entry && entry.expiresAt > Date.now() ? entry : null
}

export function hasCachedNativeLyrics(query: NativeLyricsQuery): boolean {
  return getNativeLyricsCacheToken(query) !== null
}

export function resetNativeLyricsCache(): void {
  for (const entry of pendingLyrics.values()) entry.controller.abort()
  pendingLyrics.clear()
  cachedLyrics.clear()
}

function isNativeData(value: unknown, source: NativeLyricsSource): value is NativeLyricsData {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<NativeLyricsData>
  return (
    data.source === source &&
    data.format === (source === 'netease' ? 'yrc' : 'qrc') &&
    typeof data.lyrics === 'string' &&
    data.lyrics.length > 0 &&
    (data.translation === undefined || typeof data.translation === 'string') &&
    (data.romanization === undefined || typeof data.romanization === 'string')
  )
}

function parseNativeData(data: NativeLyricsData): LyricLine[] | null {
  let lines = parseAnyLyrics(data.lyrics)
  if (!lines.some((line) => line.wordSource === 'native')) return null
  if (data.translation) {
    const donor = parseAnyLyrics(data.translation).map((line) => ({
      time: line.time,
      text: line.text,
      translation: line.text,
    }))
    lines = mergeLyricAnnotations(lines, donor)
  }
  if (data.romanization) {
    const donor = parseAnyLyrics(data.romanization).map((line) => ({
      time: line.time,
      text: line.text,
      roman: line.text,
    }))
    lines = mergeLyricAnnotations(lines, donor)
  }
  return lines
}

/** 同时约束 fetch 和 response body;平台实现忽略 abort 时也不会无限等待。 */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('Native lyrics request cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function readSaved(
  key: string,
  store: LyricsCacheStore,
  signal: AbortSignal,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await withSignal(
      Promise.race([
        Promise.resolve().then(() => store.get(key)),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 500)
        }),
      ]),
      signal,
    )
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function requestNative(query: NativeLyricsQuery, signal: AbortSignal): Promise<NativeLookup> {
  const params = new URLSearchParams({ source: query.source, id: query.id.trim() })
  const unavailable: NativeLookup = { text: null, lines: null, definitive: false }
  const release = await acquireLyricsRequest(signal)
  try {
    signal.throwIfAborted()
    const response = await withSignal(
      httpFetch(`${NATIVE_LYRICS_API_URL}?${params}`, {
        signal,
        cache: 'no-cache',
      }),
      signal,
    )
    const text = await withSignal(response.text(), signal)
    if (text.length > LYRICS_CACHE_MAX_TEXT_LENGTH) return unavailable
    const result: unknown = JSON.parse(text)
    if (!result || typeof result !== 'object') return unavailable
    const payload = result as { status?: unknown; data?: unknown }
    if (response.status === 404 && payload.status === 'missing') {
      return { text: null, lines: null, definitive: true }
    }
    if (
      response.status !== 200 ||
      payload.status !== 'found' ||
      !isNativeData(payload.data, query.source)
    ) {
      return unavailable
    }
    const lines = parseNativeData(payload.data)
    // 200 + 坏正文/普通 LRC 也是故障,不能缓存为平台明确未命中。
    return lines ? { text: JSON.stringify(payload.data), lines, definitive: true } : unavailable
  } catch {
    return unavailable
  } finally {
    release()
  }
}

async function loadSavedOrRequest(
  query: NativeLyricsQuery,
  key: string,
  signal: AbortSignal,
): Promise<LyricLine[] | null> {
  const store = cacheStore
  const saved = await readSaved(key, store, signal)
  if (signal.aborted) return null
  if (isLyricsCacheRecord(saved) && saved.key === key && saved.expiresAt > Date.now()) {
    try {
      const data: unknown = saved.text === null ? null : JSON.parse(saved.text)
      const lines = isNativeData(data, query.source) ? parseNativeData(data) : null
      if (saved.text === null || lines) {
        cachedLyrics.set(key, { lines, expiresAt: saved.expiresAt })
        return lines
      }
    } catch {
      // 旧记录/损坏的 JSON 不得阻断新请求。
    }
  }
  const result = await requestNative(query, signal)
  if (signal.aborted) return null
  if (result.definitive) {
    const updatedAt = Date.now()
    const expiresAt =
      updatedAt + (result.lines ? NATIVE_LYRICS_POSITIVE_TTL_MS : NATIVE_LYRICS_NEGATIVE_TTL_MS)
    cachedLyrics.set(key, { lines: result.lines, expiresAt })
    void Promise.resolve()
      .then(() =>
        store.set({
          cacheVersion: 1,
          key,
          text: result.text,
          updatedAt,
          expiresAt,
        }),
      )
      .catch(() => undefined)
  }
  return result.lines
}

function subscribe(entry: PendingNativeLyrics, signal?: AbortSignal): Promise<LyricLine[] | null> {
  const releasePriority = subscribeLyricsPriority(entry.controller.signal, signal)
  entry.subscribers += 1
  return new Promise((resolve) => {
    let released = false
    const finish = (lines: LyricLine[] | null) => {
      if (released) return
      released = true
      releasePriority()
      signal?.removeEventListener('abort', onAbort)
      entry.subscribers -= 1
      if (!entry.subscribers && !entry.settled) entry.controller.abort()
      resolve(lines)
    }
    const onAbort = () => finish(null)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    entry.promise.then(finish, () => finish(null))
  })
}

/** 平台逐字歌词仅做增强,失败和取消均不会打断 LRC/AMLL。 */
export function loadNativeLyrics(
  query: NativeLyricsQuery,
  signal?: AbortSignal,
): Promise<LyricLine[] | null> {
  if (signal?.aborted || !query.id.trim()) return Promise.resolve(null)
  const key = nativeLyricsCacheKey(query)
  const cached = cachedLyrics.get(key)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.lines)
  if (cached) cachedLyrics.delete(key)
  const existing = pendingLyrics.get(key)
  if (existing && !existing.controller.signal.aborted) return subscribe(existing, signal)
  const controller = new AbortController()
  initializeLyricsPriority(controller.signal)
  const releaseInitialPriority = subscribeLyricsPriority(controller.signal, signal)
  const timer = setTimeout(() => controller.abort(), NATIVE_LYRICS_TIMEOUT_MS)
  const entry: PendingNativeLyrics = {
    controller,
    subscribers: 0,
    settled: false,
    promise: Promise.resolve(null),
  }
  entry.promise = loadSavedOrRequest(query, key, controller.signal)
    .catch(() => null)
    .finally(() => {
      entry.settled = true
      clearTimeout(timer)
      if (pendingLyrics.get(key) === entry) pendingLyrics.delete(key)
    })
  pendingLyrics.set(key, entry)
  const result = subscribe(entry, signal)
  releaseInitialPriority()
  return result
}
