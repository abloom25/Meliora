import { httpFetch } from './http'
import {
  WORD_LYRICS_API_URL,
  WORD_LYRICS_MAX_CONCURRENT_REQUESTS,
  WORD_LYRICS_MAX_QUEUED_REQUESTS,
  WORD_LYRICS_MIRRORS,
  WORD_LYRICS_NEGATIVE_TTL_MS,
  WORD_LYRICS_PLATFORMS,
  WORD_LYRICS_POSITIVE_TTL_MS,
  WORD_LYRICS_QUERY_TIMEOUT_MS,
  WORD_LYRICS_TIMEOUT_MS,
} from '../config/lyrics'
import type { LyricLine } from '../core/types'
import type { MusicServer } from '../../shared/music-config'
import { LruCache } from '../core/util/lru-cache'
import {
  parseAnyLyrics,
  normalizeLyricsMetadata,
  selectWordLyricsCandidate,
  type WordLyricsCandidate,
  type WordLyricsMetadata,
} from '../core/lyrics'
import {
  isLyricsCacheRecord,
  LYRICS_CACHE_CAPACITY,
  LYRICS_CACHE_MAX_TEXT_LENGTH,
  type LyricsCacheStore,
} from '../core/platform/lyrics-cache'
import { webLyricsCacheStore } from '../platform/web/lyrics-cache'

export interface WordLyricsQuery extends WordLyricsMetadata {
  platform?: MusicServer
  /** 网易云数字 ID 或 QQ songmid。缺失时只做保守的元数据匹配。 */
  id?: string
}

interface CachedLyrics {
  lines: LyricLine[] | null
  expiresAt: number
}

interface PendingLyrics {
  controller: AbortController
  subscribers: number
  settled: boolean
  promise: Promise<LyricLine[] | null>
}

interface LookupResult {
  text: string | null
  lines?: LyricLine[] | null
  /** 仅官方明确的未命中可以负缓存;超时、限流、格式错误都不能。 */
  definitive: boolean
}

interface ApiSong extends WordLyricsCandidate {
  filename: string
  lyrics?: string
}

type ApiResult = { ok: true; data: unknown } | { ok: false; missing: boolean }

const wordLyricsCache = new LruCache<string, CachedLyrics>(LYRICS_CACHE_CAPACITY)
const pendingLyrics = new Map<string, PendingLyrics>()
let cacheStore: LyricsCacheStore = webLyricsCacheStore

/** 换平台/测试时替换持久缓存;传 null 恢复 IndexedDB。 */
export function setWordLyricsCacheStore(store: LyricsCacheStore | null): void {
  cacheStore = store ?? webLyricsCacheStore
}

/** 元数据也参与 key,避免无 ID 的歌曲或同一 ID 的不同版本相互串词。 */
export function getWordLyricsQueryKey(query: WordLyricsQuery): string {
  return JSON.stringify([
    query.platform ?? '',
    query.id?.trim() ?? '',
    normalizeLyricsMetadata(query.title),
    normalizeLyricsMetadata(query.artist),
    normalizeLyricsMetadata(query.album),
  ])
}

export function wordLyricsCacheKey(query: WordLyricsQuery): string {
  return `word-lyrics:${getWordLyricsQueryKey(query)}`
}

export function hasCachedWordLyrics(query: WordLyricsQuery): boolean {
  return getWordLyricsCacheToken(query) !== null
}

/** 同一查询刷新后 token 会变化,组合歌词缓存据此作废旧的合并结果。 */
export function getWordLyricsCacheToken(query: WordLyricsQuery): object | null {
  const entry = wordLyricsCache.get(getWordLyricsQueryKey(query))
  return entry && entry.expiresAt > Date.now() ? entry : null
}

/** 只清内存。持久缓存保留,便于刷新页面后重用;测试可注入隔离的 store。 */
export function resetWordLyricsCache(): void {
  for (const pending of pendingLyrics.values()) pending.controller.abort()
  pendingLyrics.clear()
  wordLyricsCache.clear()
}

let activeRequests = 0
const requestWaiters: Array<() => void> = []

function acquireRequest(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted || requestWaiters.length >= WORD_LYRICS_MAX_QUEUED_REQUESTS) {
      reject(new Error('Word lyrics request cancelled or queue full'))
      return
    }
    const onAbort = () => {
      const index = requestWaiters.indexOf(start)
      if (index >= 0) requestWaiters.splice(index, 1)
      reject(signal.reason)
    }
    const start = () => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) {
        reject(signal.reason)
        requestWaiters.shift()?.()
        return
      }
      activeRequests += 1
      let released = false
      resolve(() => {
        if (released) return
        released = true
        activeRequests -= 1
        requestWaiters.shift()?.()
      })
    }
    if (activeRequests < WORD_LYRICS_MAX_CONCURRENT_REQUESTS) start()
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      requestWaiters.push(start)
    }
  })
}

/** 单请求超时加整个查询预算。超时包含读 body,不受 fetch 是否正确响应 abort 影响。 */
async function fetchText(
  url: string,
  signal: AbortSignal,
): Promise<{ status: number; text: string }> {
  const release = await acquireRequest(signal)
  if (signal.aborted) {
    release()
    throw signal.reason
  }
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectAborted: (() => void) | undefined
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(controller.signal.reason ?? new Error('Lyrics request aborted'))
      controller.signal.addEventListener('abort', rejectAborted, { once: true })
      if (controller.signal.aborted) rejectAborted()
      timer = setTimeout(() => controller.abort(), WORD_LYRICS_TIMEOUT_MS)
    })
    const response = (async () => {
      const result = await httpFetch(url, { signal: controller.signal, cache: 'no-cache' })
      const text = await result.text()
      if (text.length > LYRICS_CACHE_MAX_TEXT_LENGTH) throw new Error('Lyrics response too large')
      return { status: result.status, text }
    })()
    return await Promise.race([response, aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
    if (rejectAborted) controller.signal.removeEventListener('abort', rejectAborted)
    release()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isApiSong(value: unknown): value is ApiSong {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.id) &&
    typeof value.filename === 'string' &&
    isStrings(value.musicNames) &&
    isStrings(value.artistNames) &&
    isStrings(value.albumNames) &&
    (value.lyrics === undefined || typeof value.lyrics === 'string')
  )
}

async function fetchApi(
  path: string,
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<ApiResult> {
  try {
    const response = await fetchText(`${WORD_LYRICS_API_URL}/${path}?${params}`, signal)
    const body: unknown = JSON.parse(response.text)
    if (!isRecord(body)) return { ok: false, missing: false }
    if (response.status === 404 && body.status === 404) return { ok: false, missing: true }
    if (response.status !== 200 || body.status !== 200) return { ok: false, missing: false }
    return { ok: true, data: body.data }
  } catch {
    return { ok: false, missing: false }
  }
}

function nativeLines(text: string): LyricLine[] | null {
  const lines = parseAnyLyrics(text)
  return lines.some((line) => line.wordSource === 'native') ? lines : null
}

function songResult(data: unknown): LookupResult {
  if (!isApiSong(data) || typeof data.lyrics !== 'string') {
    return { text: null, definitive: false }
  }
  const lines = nativeLines(data.lyrics)
  return { text: lines ? data.lyrics : null, lines, definitive: Boolean(lines) }
}

async function searchMetadata(query: WordLyricsQuery, signal: AbortSignal): Promise<LookupResult> {
  const params = new URLSearchParams({
    musicName: query.title!.trim(),
    artistName: query.artist!.trim(),
    pageSize: '100',
  })
  if (query.album?.trim()) params.set('albumName', query.album.trim())
  const response = await fetchApi('search', params, signal)
  if (!response.ok) return { text: null, definitive: response.missing }
  const data = response.data
  if (
    !isRecord(data) ||
    !Array.isArray(data.items) ||
    !data.items.every(isApiSong) ||
    !isRecord(data.pagination) ||
    typeof data.pagination.hasMore !== 'boolean'
  ) {
    return { text: null, definitive: false }
  }
  // 不只看第一页的「唯一」候选:后面可能还有相同标题的不同录音。
  if (data.pagination.hasMore) return { text: null, definitive: true }
  const candidate = selectWordLyricsCandidate(data.items, query)
  if (!candidate) return { text: null, definitive: true }
  const result = await fetchApi('get', new URLSearchParams({ id: String(candidate.id) }), signal)
  return result.ok ? songResult(result.data) : { text: null, definitive: result.missing }
}

async function fetchMirrors(
  platform: MusicServer,
  id: string,
  signal: AbortSignal,
): Promise<LookupResult> {
  const controller = new AbortController()
  const cancel = () => controller.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const source = WORD_LYRICS_PLATFORMS[platform]
  try {
    // 三个镜像共用全局网络并发预算;首个有效结果返回并中止其余请求。
    return await new Promise<LookupResult>((resolve) => {
      let found = false
      const tasks = WORD_LYRICS_MIRRORS.map(async (mirror) => {
        for (const extension of source.extensions) {
          if (controller.signal.aborted) return
          try {
            const url = `${mirror.baseUrl}/${source.directory}/${encodeURIComponent(id)}.${extension}`
            const result = await fetchText(url, controller.signal)
            if (result.status !== 200) {
              // 单个 CDN 的 404 可能只是同步滞后,不能认定整个库没有歌词。
              if (result.status === 404) continue
              return
            }
            const lines = nativeLines(result.text)
            if (!lines) continue
            if (!found) {
              found = true
              resolve({ text: result.text, lines, definitive: true })
              controller.abort()
            }
            return
          } catch {
            return
          }
        }
      })
      void Promise.allSettled(tasks).then(() => {
        if (!found) resolve({ text: null, definitive: false })
      })
    })
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

async function requestWordLyrics(
  query: WordLyricsQuery,
  signal: AbortSignal,
): Promise<LookupResult> {
  const id = query.id?.trim()
  const identity = query.platform && id ? { platform: query.platform, id } : null
  const canSearch = Boolean(query.title?.trim() && query.artist?.trim())
  let exactMissing = !identity
  if (identity) {
    const parameter = identity.platform === 'netease' ? 'ncmMusicId' : 'qqMusicId'
    const response = await fetchApi(
      'get',
      new URLSearchParams({ [parameter]: identity.id }),
      signal,
    )
    const exact = response.ok
      ? songResult(response.data)
      : { text: null, definitive: response.missing }
    if (exact.text) return exact
    exactMissing = exact.definitive
    if (!exactMissing && !signal.aborted) {
      const mirrored = await fetchMirrors(identity.platform, identity.id, signal)
      if (mirrored.text) return mirrored
    }
  }
  if (canSearch && !signal.aborted) {
    const searched = await searchMetadata(query, signal)
    return { ...searched, definitive: searched.definitive && exactMissing }
  }
  return { text: null, definitive: exactMissing && !signal.aborted }
}

async function loadCachedOrRequest(
  key: string,
  query: WordLyricsQuery,
  signal: AbortSignal,
): Promise<LyricLine[] | null> {
  // 捕获当前 store,避免测试/平台切换时一个旧请求写进新的存储。
  const store = cacheStore
  try {
    const saved = await new Promise<unknown>((resolve) => {
      const finish = (value: unknown) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = () => finish(null)
      const timer = setTimeout(() => finish(null), 500)
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
      else
        Promise.resolve()
          .then(() => store.get(key))
          .then(finish, () => finish(null))
    })
    if (signal.aborted) return null
    if (isLyricsCacheRecord(saved) && saved.key === key && saved.expiresAt > Date.now()) {
      const lines = saved.text === null ? null : nativeLines(saved.text)
      if (saved.text === null || lines) {
        wordLyricsCache.set(key, { lines, expiresAt: saved.expiresAt })
        return lines
      }
    }
  } catch {
    // 隐私模式、存储损坏和桌面端实现失败都只影响缓存。
  }
  if (signal.aborted) return null
  const result = await requestWordLyrics(query, signal)
  if (signal.aborted) return null
  const lines = result.lines ?? null
  if (lines || result.definitive) {
    const updatedAt = Date.now()
    const expiresAt =
      updatedAt + (lines ? WORD_LYRICS_POSITIVE_TTL_MS : WORD_LYRICS_NEGATIVE_TTL_MS)
    wordLyricsCache.set(key, { lines, expiresAt })
    void Promise.resolve()
      .then(() => store.set({ cacheVersion: 1, key, text: result.text, updatedAt, expiresAt }))
      .catch(() => undefined)
  }
  return lines
}

function subscribe(entry: PendingLyrics, signal?: AbortSignal): Promise<LyricLine[] | null> {
  if (signal?.aborted) return Promise.resolve(null)
  entry.subscribers += 1
  return new Promise((resolve) => {
    let released = false
    const finish = (lines: LyricLine[] | null) => {
      if (released) return
      released = true
      signal?.removeEventListener('abort', onAbort)
      entry.subscribers -= 1
      if (!entry.subscribers && !entry.settled) entry.controller.abort()
      resolve(lines)
    }
    const onAbort = () => finish(null)
    signal?.addEventListener('abort', onAbort, { once: true })
    entry.promise.then(finish, () => finish(null))
  })
}

/** 逐字歌词是增强项:未命中、故障或取消都返回 null,不会打断普通歌词。 */
export function loadWordLyrics(
  query: WordLyricsQuery,
  signal?: AbortSignal,
): Promise<LyricLine[] | null> {
  if (signal?.aborted) return Promise.resolve(null)
  const key = getWordLyricsQueryKey(query)
  if (!(query.platform && query.id?.trim()) && !(query.title?.trim() && query.artist?.trim())) {
    wordLyricsCache.set(key, { lines: null, expiresAt: Date.now() + WORD_LYRICS_NEGATIVE_TTL_MS })
    return Promise.resolve(null)
  }
  const cached = wordLyricsCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.lines)
  if (cached) wordLyricsCache.delete(key)
  const existing = pendingLyrics.get(key)
  if (existing && !existing.controller.signal.aborted) return subscribe(existing, signal)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WORD_LYRICS_QUERY_TIMEOUT_MS)
  const entry: PendingLyrics = {
    controller,
    subscribers: 0,
    settled: false,
    promise: Promise.resolve(null),
  }
  entry.promise = loadCachedOrRequest(key, query, controller.signal)
    .catch(() => null)
    .finally(() => {
      entry.settled = true
      clearTimeout(timer)
      if (pendingLyrics.get(key) === entry) pendingLyrics.delete(key)
    })
  pendingLyrics.set(key, entry)
  return subscribe(entry, signal)
}
