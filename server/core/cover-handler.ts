import { normalizeShareCoverUrl } from '../../shared/share-cover'
import { consumeRateLimit, tryAcquireWorkSlot } from './rate-limit'

const MAX_IMAGE_BYTES = 1024 * 1024
const MAX_CACHE_BYTES = 4 * MAX_IMAGE_BYTES
const CACHE_TTL = 86_400_000
const RATE_LIMIT = { key: 'share-cover', limit: 30, windowMs: 60_000, blockMs: 60_000 }
interface CachedCover {
  bytes: Uint8Array<ArrayBuffer>
  type: string
  expiresAt: number
}
// Only completed bytes are shared. Edge requests never reuse another request's I/O.
const cache = new Map<string, CachedCover>()
let cachedBytes = 0

function removeCached(key: string): void {
  cachedBytes -= cache.get(key)?.bytes.byteLength ?? 0
  cache.delete(key)
}

function coverResponse(cover: CachedCover, hit: boolean): Response {
  const maxAge = Math.max(0, Math.floor((cover.expiresAt - Date.now()) / 1000))
  return new Response(cover.bytes, {
    headers: {
      'Content-Type': cover.type,
      'Content-Length': String(cover.bytes.byteLength),
      'Cache-Control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
      'X-Content-Type-Options': 'nosniff',
      'X-Cover-Cache': hit ? 'HIT' : 'MISS',
    },
  })
}

function unavailable(status: number, retryAfter?: string): Response {
  return Response.json(
    { error: '封面暂时无法载入' },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
      },
    },
  )
}

function imageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value))
    return 'image/png'
  if (
    bytes.length >= 12 &&
    [82, 73, 70, 70].every((value, index) => bytes[index] === value) &&
    [87, 69, 66, 80].every((value, index) => bytes[index + 8] === value)
  )
    return 'image/webp'
  return null
}

async function readCover(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error('Empty image')
  const reader = response.body.getReader()
  const cancel = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  let complete = false
  try {
    signal.throwIfAborted()
    while (true) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > MAX_IMAGE_BYTES) throw new Error('Image too large')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    complete = true
    return bytes
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!complete) cancel()
    reader.releaseLock()
  }
}

async function fetchCover(url: string, signal: AbortSignal): Promise<CachedCover> {
  let target = url
  for (let redirects = 0; redirects <= 2; redirects++) {
    signal.throwIfAborted()
    const response = await fetch(target, {
      redirect: 'manual',
      signal,
      headers: { Accept: 'image/jpeg, image/png, image/webp' },
    })
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      void response.body?.cancel().catch(() => {})
      const location = response.headers.get('Location')
      const next = location && normalizeShareCoverUrl(new URL(location, target).href)
      if (!next) throw new Error('Unsupported redirect')
      target = next
      continue
    }
    const type = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    if (
      !response.ok ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(type ?? '') ||
      Number(response.headers.get('Content-Length')) > MAX_IMAGE_BYTES
    ) {
      void response.body?.cancel().catch(() => {})
      throw new Error('Invalid image response')
    }
    const bytes = await readCover(response, signal)
    const detectedType = imageType(bytes)
    if (!detectedType || detectedType !== type) throw new Error('Invalid image content')
    return { bytes, type: detectedType, expiresAt: Date.now() + CACHE_TTL }
  }
  throw new Error('Too many redirects')
}

/** Same-origin canvas export fallback, restricted to the public music artwork CDNs. */
export async function getShareCover(request: Request, clientIp?: string): Promise<Response> {
  if (request.method !== 'GET')
    return Response.json(
      { error: '仅支持 GET' },
      { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } },
    )
  const params = new URL(request.url).searchParams
  const url = normalizeShareCoverUrl(params.get('url') ?? '')
  if (!url || params.getAll('url').length !== 1 || [...params.keys()].some((key) => key !== 'url'))
    return Response.json(
      { error: '不支持的封面地址' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  if (request.signal.aborted) return unavailable(503)
  const cached = cache.get(url)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      cache.delete(url)
      cache.set(url, cached)
      return coverResponse(cached, true)
    }
    removeCached(url)
  }
  const rate = consumeRateLimit(RATE_LIMIT, clientIp)
  if (!rate.allowed) return unavailable(429, String(rate.retryAfterSeconds))
  const release = tryAcquireWorkSlot('share-cover', 4)
  if (!release) return unavailable(503, '2')
  const controller = new AbortController()
  const cancel = (): void => controller.abort(request.signal.reason)
  request.signal.addEventListener('abort', cancel, { once: true })
  if (request.signal.aborted) cancel()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const cover = await fetchCover(url, controller.signal)
    controller.signal.throwIfAborted()
    removeCached(url)
    while (cache.size >= 16 || cachedBytes + cover.bytes.byteLength > MAX_CACHE_BYTES) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      removeCached(oldest)
    }
    cache.set(url, cover)
    cachedBytes += cover.bytes.byteLength
    return coverResponse(cover, false)
  } catch {
    return unavailable(502)
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', cancel)
    release()
  }
}
