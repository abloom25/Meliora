import { describe, expect, it, vi } from 'vitest'
import { useCoverCache } from '../composables/useCoverCache'

describe('useCoverCache', () => {
  it('scopes failures to the cover URL and clears them after success or the retry window', () => {
    vi.useFakeTimers()
    try {
      const { failedCovers, markCoverLoaded, markCoverFailed } = useCoverCache()
      markCoverFailed('same-track', '/old-cover.jpg')
      expect(failedCovers.value.has('/old-cover.jpg')).toBe(true)
      expect(failedCovers.value.has('/new-cover.jpg')).toBe(false)
      markCoverLoaded('same-track', '/old-cover.jpg')
      expect(failedCovers.value.has('/old-cover.jpg')).toBe(false)
      markCoverFailed('same-track', '/new-cover.jpg')
      vi.advanceTimersByTime(5 * 60 * 1000)
      expect(failedCovers.value.has('/new-cover.jpg')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it('bounds loaded and failed cover state caches', () => {
    const { loadedCovers, failedCovers, markCoverLoaded, markCoverFailed } = useCoverCache()

    for (let i = 0; i < 530; i += 1) {
      markCoverLoaded(`loaded-${i}`)
      markCoverFailed(`failed-${i}`)
    }

    expect(loadedCovers.value.size).toBe(512)
    expect(failedCovers.value.size).toBe(512)
    expect(loadedCovers.value.has('loaded-0')).toBe(false)
    expect(failedCovers.value.has('failed-0')).toBe(false)
    expect(loadedCovers.value.has('loaded-529')).toBe(true)
    expect(failedCovers.value.has('failed-529')).toBe(true)
  })
})
