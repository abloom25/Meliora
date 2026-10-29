import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlaybackWatchdog } from '../platform/web/playback-watchdog'

afterEach(() => vi.useRealTimers())

describe('playback progress watchdog', () => {
  it('resumes without reloading first, then escalates a genuinely stuck media clock', () => {
    vi.useFakeTimers()
    const sample = { identity: 'a', position: 10, ended: false }
    const onStall = vi.fn()
    const watchdog = createPlaybackWatchdog({ read: () => sample, onStall })
    watchdog.start()
    vi.advanceTimersByTime(12000)
    expect(onStall).toHaveBeenLastCalledWith(false)
    vi.advanceTimersByTime(6000)
    expect(onStall).toHaveBeenLastCalledWith(true)
    sample.position = 11
    vi.advanceTimersByTime(1000)
    onStall.mockClear()
    vi.advanceTimersByTime(11000)
    expect(onStall).not.toHaveBeenCalled()
    watchdog.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives a new playback intent a fresh deadline and stops checking at the end', () => {
    vi.useFakeTimers()
    const sample = { identity: 'a', position: 10, ended: false }
    const onStall = vi.fn()
    const watchdog = createPlaybackWatchdog({ read: () => sample, onStall })
    watchdog.start()
    vi.advanceTimersByTime(11000)
    sample.identity = 'b'
    vi.advanceTimersByTime(11000)
    expect(onStall).not.toHaveBeenCalled()
    sample.ended = true
    vi.advanceTimersByTime(30000)
    expect(onStall).not.toHaveBeenCalled()
    watchdog.stop()
  })

  it('does not treat a throttled callback or device sleep as twelve seconds of stalled playback', () => {
    vi.useFakeTimers()
    const onStall = vi.fn()
    const watchdog = createPlaybackWatchdog({
      read: () => ({ identity: 'a', position: 0, ended: false }),
      onStall,
    })
    watchdog.start()
    vi.advanceTimersByTime(11000)
    const clock = vi.spyOn(performance, 'now').mockReturnValue(90000)
    vi.advanceTimersByTime(1000)
    expect(onStall).not.toHaveBeenCalled()
    clock.mockRestore()
    watchdog.stop()
  })
})
