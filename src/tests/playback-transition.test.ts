import { describe, expect, it } from 'vitest'
import { createPlaybackTransition } from '../platform/web/playback-transition'

describe('playback transition ownership', () => {
  it('blocks reentry during preparation and invalidates callbacks after the next commit', () => {
    const transition = createPlaybackTransition()
    const first = transition.begin()!
    expect(transition.begin()).toBeNull()
    transition.release(first)
    expect(transition.isCurrent(first)).toBe(true)
    const second = transition.begin()!
    expect(first.signal.aborted).toBe(true)
    expect(transition.isCurrent(first)).toBe(false)
    transition.release(first)
    expect(transition.isPreparing()).toBe(true)
    transition.release(second)
    expect(transition.isPreparing()).toBe(false)
  })

  it('keeps a replacement locked when a cancelled task finally releases', () => {
    const transition = createPlaybackTransition()
    const first = transition.begin()!
    transition.cancel()
    const second = transition.begin()!
    transition.release(first)
    expect(transition.isPreparing()).toBe(true)
    expect(transition.isCurrent(second)).toBe(true)
    transition.cancel()
    expect(transition.isCurrent(second)).toBe(false)
    expect(transition.isPreparing()).toBe(false)
  })
})
