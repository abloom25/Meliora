import { describe, expect, it } from 'vitest'
import {
  lyricBrowseDelay,
  lyricBrowseReturnStiffness,
  lyricBrowseReturnWait,
} from '../core/lyrics/browse-return'

describe('reading before resuming lyric following', () => {
  it('allows more reading time for distant browsing with a bounded maximum', () => {
    expect(lyricBrowseDelay(0.1)).toBeLessThan(lyricBrowseDelay(2))
    expect(lyricBrowseDelay(100)).toBe(5600)
    expect(lyricBrowseDelay(Number.NaN)).toBe(2600)
  })
  it('never pulls back while touch inertia is still moving and reevaluates after it settles', () => {
    expect(lyricBrowseReturnWait(9000, 0.1, true)).toBe(250)
    expect(lyricBrowseReturnWait(9000, 0.1, false)).toBe(0)
    expect(lyricBrowseReturnWait(500, 1, false)).toBe(3100)
  })
  it('softens distant returns without changing ordinary follow springs', () => {
    expect(lyricBrowseReturnStiffness(3)).toBeLessThan(lyricBrowseReturnStiffness(0))
    expect(lyricBrowseReturnStiffness(100)).toBeGreaterThan(60)
  })
})
