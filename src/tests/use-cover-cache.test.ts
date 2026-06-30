import { describe, expect, it } from 'vitest'
import { useCoverCache } from '../composables/useCoverCache'

describe('useCoverCache', () => {
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
