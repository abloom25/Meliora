import { describe, expect, it } from 'vitest'
import { consumeRateLimit, tryAcquireWorkSlot } from '../core/rate-limit'

describe('rate limit protection', () => {
  it('uses only the trusted client identity supplied by the deployment adapter', () => {
    const options = {
      key: 'trusted-client-test',
      limit: 1,
      windowMs: 60_000,
      blockMs: 60_000,
    }

    expect(consumeRateLimit(options, '203.0.113.1').allowed).toBe(true)
    expect(consumeRateLimit(options, '203.0.113.1').allowed).toBe(false)
    expect(consumeRateLimit(options, '203.0.113.2').allowed).toBe(true)
  })

  it('bounds high-cost work and releases slots idempotently', () => {
    const releaseFirst = tryAcquireWorkSlot('password-test', 2)
    const releaseSecond = tryAcquireWorkSlot('password-test', 2)

    expect(releaseFirst).toBeTypeOf('function')
    expect(releaseSecond).toBeTypeOf('function')
    expect(tryAcquireWorkSlot('password-test', 2)).toBeNull()

    releaseFirst?.()
    releaseFirst?.()
    const releaseReplacement = tryAcquireWorkSlot('password-test', 2)
    expect(releaseReplacement).toBeTypeOf('function')

    releaseSecond?.()
    releaseReplacement?.()
  })
})
