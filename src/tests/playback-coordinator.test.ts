import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPlaybackCoordinator } from '../platform/web/playback-coordinator'
import { safeStorage } from '../platform/web/storage'

const key = 'meliora:playback-owner:v1'
const coordinators: ReturnType<typeof createPlaybackCoordinator>[] = []
function coordinator() {
  const onLost = vi.fn()
  const result = createPlaybackCoordinator({ onLost })
  coordinators.push(result)
  return { ...result, onLost }
}
afterEach(() => {
  coordinators.splice(0).forEach((item) => item.dispose())
  localStorage.removeItem(key)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('playback tab coordination', () => {
  it('allows independent playback and session saving when disabled, then restores exclusion', () => {
    const first = coordinator()
    const second = coordinator()
    first.setEnabled(false)
    first.claim()
    second.claim()
    expect(first.owns()).toBe(true)
    expect(first.canPersist()).toBe(true)
    expect(first.onLost).not.toHaveBeenCalled()
    first.setEnabled(true)
    expect(first.owns()).toBe(false)
    first.claim()
    expect(second.canPersist()).toBe(false)
    expect(second.onLost).toHaveBeenCalledOnce()
  })
  it('lets the newest play claim win and prevents an old tab saving after the winner closes', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const first = coordinator()
    first.claim()
    const second = coordinator()
    expect(second.canPersist()).toBe(false)
    second.claim()
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key) }))
    expect(first.onLost).toHaveBeenCalledOnce()
    expect(first.owns()).toBe(false)
    expect(second.owns()).toBe(true)
    expect(first.canPersist()).toBe(false)
    second.dispose()
    expect(first.canPersist()).toBe(false)
    first.claim()
    expect(first.owns()).toBe(true)
    expect(first.canPersist()).toBe(true)
  })
  it('coordinates through BroadcastChannel even when storage is unavailable', () => {
    class Bus {
      static all = new Set<Bus>()
      onmessage: ((event: { data: unknown }) => void) | null = null
      constructor() {
        Bus.all.add(this)
      }
      postMessage(data: unknown) {
        for (const peer of Bus.all) if (peer !== this) peer.onmessage?.({ data })
      }
      close() {
        Bus.all.delete(this)
      }
    }
    vi.stubGlobal('BroadcastChannel', Bus)
    vi.spyOn(safeStorage, 'getItem').mockReturnValue(null)
    vi.spyOn(safeStorage, 'setItem').mockImplementation(() => {})
    const first = coordinator()
    const second = coordinator()
    first.claim()
    second.claim()
    expect(first.onLost).toHaveBeenCalledOnce()
    expect(first.canPersist()).toBe(false)
    expect(second.owns()).toBe(true)
    first.dispose()
    second.dispose()
    expect(Bus.all.size).toBe(0)
  })
  it('ignores malformed or stale claims and does not delete another page ownership on disposal', () => {
    const first = coordinator()
    first.claim()
    const second = coordinator()
    second.claim()
    const latest = localStorage.getItem(key)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '{broken' }))
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        newValue: JSON.stringify({ version: 1, id: 'old', revision: 1 }),
      }),
    )
    expect(second.owns()).toBe(true)
    first.dispose()
    expect(localStorage.getItem(key)).toBe(latest)
  })
})
