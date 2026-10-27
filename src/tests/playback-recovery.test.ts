import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlaybackRecovery } from '../platform/web/playback-recovery'
import { resolveFailureAction } from '../core/audio/failure'

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((stop) => stop())
  vi.restoreAllMocks()
  vi.useRealTimers()
})
function setup() {
  vi.useFakeTimers()
  const retry = vi.fn()
  const onPhase = vi.fn()
  const recovery = createPlaybackRecovery({ retry, onPhase })
  cleanup.push(recovery.dispose)
  return { recovery, retry, onPhase }
}
describe('playback recovery', () => {
  it.each(['network', 'not-allowed', 'aborted'] as const)('never skips songs for %s', (reason) => {
    expect(
      resolveFailureAction(reason, { skipOnError: true, hasNextTrack: true, canFallBack: true }),
    ).toEqual({ kind: 'stop' })
  })
  it('waits offline without consuming attempts and resumes with a bounded retry after online', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const { recovery, retry, onPhase } = setup()
    recovery.fail()
    recovery.fail()
    await vi.advanceTimersByTimeAsync(60000)
    expect(retry).not.toHaveBeenCalled()
    expect(onPhase).toHaveBeenLastCalledWith('offline')
    online.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(800)
    expect(retry).toHaveBeenCalledTimes(1)
    recovery.fail()
    recovery.fail()
    await vi.advanceTimersByTimeAsync(2000)
    expect(retry).toHaveBeenCalledTimes(2)
    recovery.fail()
    expect(onPhase).toHaveBeenLastCalledWith('exhausted')
    await vi.advanceTimersByTimeAsync(60000)
    expect(retry).toHaveBeenCalledTimes(2)
  })
  it('times out a native play promise that never settles and cancels all work on user intent', async () => {
    const { recovery, retry, onPhase } = setup()
    recovery.fail()
    await vi.advanceTimersByTimeAsync(30000)
    expect(retry).toHaveBeenCalledTimes(2)
    expect(onPhase).toHaveBeenLastCalledWith('exhausted')
    recovery.cancel()
    recovery.fail()
    recovery.cancel()
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(60000)
    expect(retry).toHaveBeenCalledTimes(2)
    expect(recovery.active()).toBe(false)
  })
  it('keeps the retry budget across brief successes and releases listeners on disposal', async () => {
    const { recovery, retry, onPhase } = setup()
    recovery.fail()
    await vi.advanceTimersByTimeAsync(800)
    recovery.settled()
    recovery.fail()
    await vi.advanceTimersByTimeAsync(2000)
    recovery.settled()
    recovery.fail()
    expect(onPhase).toHaveBeenLastCalledWith('exhausted')
    recovery.dispose()
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(30000)
    expect(retry).toHaveBeenCalledTimes(2)
  })
})
