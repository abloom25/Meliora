interface RateLimitEntry {
  count: number
  resetAt: number
  blockedUntil: number
}

interface RateLimitOptions {
  key: string
  limit: number
  windowMs: number
  blockMs: number
}

interface RateLimitResult {
  allowed: boolean
  retryAfterSeconds: number
}

// 限流状态为模块级内存,Edge Function 多实例之间不共享:
// 实际生效阈值 ≈ limit × 实例数。这是 Edge 平台无共享存储下的固有限制,
// 需要严格全局限流应改用 Durable Objects / KV。当前实现用于抬高爆破成本。
const MAX_ENTRIES = 10_000
const attempts = new Map<string, RateLimitEntry>()

function clientKey(request: Request): string {
  const headers = request.headers
  // 优先使用平台设置的可信客户端 IP:CF-Connecting-IP(Cloudflare)、X-Real-IP(Netlify 等),
  // 最后回退 X-Forwarded-For 首项。注意:不将 User-Agent 纳入限流键 —— UA 完全由客户端控制,
  // 纳入会主动给攻击者提供一个免费绕过维度(换 UA 即换桶)。
  const ip =
    headers.get('CF-Connecting-IP') ||
    headers.get('X-Real-IP') ||
    headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  return ip
}

function pruneExpired(now: number): void {
  for (const [key, entry] of attempts) {
    if (entry.resetAt <= now && entry.blockedUntil <= now) {
      attempts.delete(key)
    }
  }
  // 防止伪造 IP/UA 组合撑爆 Map 导致 OOM:超容量时按 resetAt 升序淘汰最早到期的条目。
  if (attempts.size > MAX_ENTRIES) {
    const sorted = [...attempts.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt)
    const removeCount = attempts.size - MAX_ENTRIES
    for (let i = 0; i < removeCount; i += 1) {
      attempts.delete(sorted[i][0])
    }
  }
}

export function consumeRateLimit(
  request: Request,
  { key, limit, windowMs, blockMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now()
  pruneExpired(now)

  const id = `${key}:${clientKey(request)}`
  const existing = attempts.get(id)

  if (existing && existing.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((existing.blockedUntil - now) / 1000),
    }
  }

  const entry =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowMs, blockedUntil: 0 }

  entry.count += 1
  if (entry.count > limit) {
    entry.blockedUntil = now + blockMs
    attempts.set(id, entry)
    return { allowed: false, retryAfterSeconds: Math.ceil(blockMs / 1000) }
  }

  attempts.set(id, entry)
  return { allowed: true, retryAfterSeconds: 0 }
}

export function resetRateLimit(request: Request, key: string): void {
  attempts.delete(`${key}:${clientKey(request)}`)
}
