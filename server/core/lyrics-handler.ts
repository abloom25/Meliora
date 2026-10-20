import type { NativeLyricsResult, NativeLyricsSource } from '../../shared/native-lyrics'
import { jsonResponse } from './http'
import { fetchNeteaseLyrics } from './lyrics/netease'
import { fetchQqLyrics } from './lyrics/qq'
import { withLyricsAbort } from './lyrics/upstream'
import { consumeRateLimit, tryAcquireWorkSlot } from './rate-limit'

interface CachedNativeLyrics {
  body: string
  status: number
  expiresAt: number
  bytes: number
}

// Completed, immutable data only. In-flight I/O must stay within its owning edge request.
const cache = new Map<string, CachedNativeLyrics>()
let cachedBytes = 0
const MAX_CACHE_ENTRIES = 64
const MAX_CACHE_BYTES = 4 * 1024 * 1024
const POSITIVE_TTL = 24 * 60 * 60 * 1000
const NEGATIVE_TTL = 15 * 60 * 1000
const REQUEST_TIMEOUT_MS = 6000
const RATE_LIMIT = { key: 'native-lyrics', limit: 60, windowMs: 60_000, blockMs: 60_000 }

function removeCached(key: string): void {
  const old = cache.get(key)
  if (old) cachedBytes -= old.bytes
  cache.delete(key)
}

function cacheResponse(entry: CachedNativeLyrics, hit: boolean): Response {
  const maxAge = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000))
  return new Response(entry.body, {
    status: entry.status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
      'X-Lyrics-Cache': hit ? 'HIT' : 'MISS',
    },
  })
}

function unavailable(status: number, retryAfter?: string): Response {
  return jsonResponse({ status: 'unavailable' }, status, {
    'Cache-Control': 'no-store',
    ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
  })
}

function validId(source: NativeLyricsSource, id: string): boolean {
  if (/^[1-9]\d{0,15}$/.test(id)) return Number.isSafeInteger(Number(id))
  return source === 'qq' && /^(?=.*[a-zA-Z])[a-zA-Z0-9]{14}$/.test(id)
}

/** Public song data, behind the existing global API enabled/environment gates. */
export async function getNativeLyrics(request: Request, clientIp?: string): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse({ error: '仅支持 GET' }, 405, { Allow: 'GET', 'Cache-Control': 'no-store' })
  }
  const params = new URL(request.url).searchParams
  const source = params.get('source')
  const id = params.get('id')?.trim() ?? ''
  if (
    (source !== 'netease' && source !== 'qq') ||
    params.getAll('source').length !== 1 ||
    params.getAll('id').length !== 1 ||
    [...params.keys()].some((key) => key !== 'source' && key !== 'id') ||
    !validId(source, id)
  ) {
    return jsonResponse({ error: '歌词来源或歌曲 ID 无效' }, 400, { 'Cache-Control': 'no-store' })
  }
  if (request.signal.aborted) return unavailable(503)
  const key = `${source}:${id}`
  const cached = cache.get(key)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      cache.delete(key)
      cache.set(key, cached)
      return cacheResponse(cached, true)
    }
    removeCached(key)
  }
  const rateLimit = consumeRateLimit(RATE_LIMIT, clientIp)
  if (!rateLimit.allowed) return unavailable(429, String(rateLimit.retryAfterSeconds))
  const release = tryAcquireWorkSlot('native-lyrics', 4)
  if (!release) return unavailable(503, '2')

  const controller = new AbortController()
  const cancel = () => controller.abort(request.signal.reason)
  request.signal.addEventListener('abort', cancel, { once: true })
  if (request.signal.aborted) cancel()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const result: NativeLyricsResult = await withLyricsAbort(
      source === 'netease'
        ? fetchNeteaseLyrics(id, controller.signal)
        : fetchQqLyrics(id, controller.signal),
      controller.signal,
    )
    if (controller.signal.aborted || result.status === 'unavailable') return unavailable(502)
    const body = JSON.stringify(result)
    const entry: CachedNativeLyrics = {
      body,
      status: result.status === 'found' ? 200 : 404,
      expiresAt: Date.now() + (result.status === 'found' ? POSITIVE_TTL : NEGATIVE_TTL),
      bytes: new TextEncoder().encode(body).byteLength,
    }
    // A bounded warm-instance cache reduces upstream work without retaining request objects.
    // It is not shared between isolates and does not eliminate function invocations.
    if (entry.bytes <= MAX_CACHE_BYTES / 4) {
      removeCached(key)
      while (cache.size >= MAX_CACHE_ENTRIES || cachedBytes + entry.bytes > MAX_CACHE_BYTES) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        removeCached(oldest)
      }
      cache.set(key, entry)
      cachedBytes += entry.bytes
    }
    return cacheResponse(entry, false)
  } catch {
    return unavailable(502)
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', cancel)
    release()
  }
}
