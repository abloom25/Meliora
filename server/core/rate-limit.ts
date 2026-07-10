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
const activeWork = new Map<string, number>()

function clientKey(trustedClientIp?: string): string {
  const normalized = trustedClientIp?.trim()
  return normalized || 'unknown'
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
  { key, limit, windowMs, blockMs }: RateLimitOptions,
  trustedClientIp?: string,
): RateLimitResult {
  const now = Date.now()
  pruneExpired(now)

  const id = `${key}:${clientKey(trustedClientIp)}`
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

export function resetRateLimit(key: string, trustedClientIp?: string): void {
  attempts.delete(`${key}:${clientKey(trustedClientIp)}`)
}

/**
 * 限制单个实例内高成本工作的并发数。返回的释放函数可重复调用且只生效一次。
 * 这不是跨实例限流，但可阻止单个热实例被 PBKDF2 请求完全占满。
 */
export function tryAcquireWorkSlot(key: string, limit: number): (() => void) | null {
  const current = activeWork.get(key) ?? 0
  if (current >= limit) return null
  activeWork.set(key, current + 1)

  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (activeWork.get(key) ?? 1) - 1
    if (remaining > 0) activeWork.set(key, remaining)
    else activeWork.delete(key)
  }
}
