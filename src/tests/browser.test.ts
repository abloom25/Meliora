import { afterEach, describe, expect, it, vi } from 'vitest'
import { isApplePlatform } from '../utils/browser'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('isApplePlatform', () => {
  it.each([
    ['MacIntel', 'Chrome', true],
    ['MacIntel', 'Safari', true],
    ['iPhone', 'Mobile Safari', true],
    ['iPad', 'Mobile Safari', true],
    ['', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', true],
    ['', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', true],
    ['Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', false],
    ['Linux armv8l', 'Mozilla/5.0 (Linux; Android 15)', false],
    ['Linux x86_64', 'Firefox', false],
  ])('detects platform %s with user agent %s', (platform, userAgent, expected) => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
    expect(isApplePlatform()).toBe(expected)
  })

  it('is safe outside a browser', () => {
    vi.stubGlobal('navigator', undefined)
    expect(isApplePlatform()).toBe(false)
  })
})
