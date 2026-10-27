import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlaybackCoordinator } from '../platform/web/playback-coordinator'
import {
  createPlaybackSync,
  type TabPlaybackSnapshot,
  type TabPlaybackCommand,
} from '../platform/web/playback-sync'
import { safeStorage } from '../platform/web/storage'

class Bus {
  static all = new Set<Bus>()
  static messages: unknown[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  readonly name: string
  constructor(name: string) {
    this.name = name
    Bus.all.add(this)
  }
  postMessage(data: unknown): void {
    Bus.messages.push(data)
    for (const peer of Bus.all)
      if (peer !== this && peer.name === this.name) peer.onmessage?.({ data })
  }
  close(): void {
    Bus.all.delete(this)
  }
}
const peers: Array<{
  coordinator: ReturnType<typeof createPlaybackCoordinator>
  sync: ReturnType<typeof createPlaybackSync>
}> = []
function peer() {
  const state: TabPlaybackSnapshot = {
    track: { id: 'a', title: 'A', artist: 'Artist', audioUrl: '/a.mp3', kind: 'local' },
    position: 12,
    duration: 120,
    playbackRate: 1,
    playing: true,
    advancing: true,
    seeking: false,
  }
  const onSnapshot = vi.fn()
  const onStop = vi.fn()
  const onTick = vi.fn()
  const onCommand = vi.fn((action: TabPlaybackCommand) => {
    if (action.action === 'pause') state.playing = state.advancing = false
    if (action.action === 'play') state.playing = state.advancing = true
    if (action.action === 'seek') state.position = action.position
  })
  const coordinator = createPlaybackCoordinator({
    onLost: () => {
      state.playing = false
    },
  })
  const sync = createPlaybackSync({
    coordinator,
    getSnapshot: () => state,
    onSnapshot,
    onStop,
    onTick,
    onCommand,
  })
  const result = { state, coordinator, sync, onSnapshot, onStop, onTick, onCommand }
  peers.push(result)
  return result
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-27T00:00:00Z'))
  vi.stubGlobal('BroadcastChannel', Bus)
  localStorage.clear()
  Bus.messages = []
})
afterEach(() => {
  for (const item of peers.splice(0)) {
    item.sync.dispose()
    item.coordinator.dispose()
  }
  vi.runOnlyPendingTimers()
  expect(Bus.all.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
describe('shared playback transport and clock', () => {
  it('joins a playing owner immediately and interpolates between anchors, freezing during buffering or seeking', () => {
    const owner = peer()
    owner.coordinator.claim()
    owner.sync.setEnabled(true)
    const follower = peer()
    follower.sync.setEnabled(true)
    expect(follower.onSnapshot).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(500)
    expect(follower.sync.read()?.position).toBe(12.5)
    expect(follower.onTick).toHaveBeenCalledTimes(2)
    owner.state.position = 13
    owner.state.advancing = false
    owner.sync.publish(true)
    vi.advanceTimersByTime(500)
    expect(follower.sync.read()?.position).toBe(13)
    owner.state.advancing = true
    owner.state.seeking = true
    owner.sync.publish(true)
    vi.advanceTimersByTime(500)
    expect(follower.sync.read()?.position).toBe(13)
    expect(follower.coordinator.owns()).toBe(false)
    expect(follower.coordinator.canPersist()).toBe(false)
  })
  it('routes controls to the audio owner and immediately broadcasts the result to every follower', async () => {
    const owner = peer()
    owner.coordinator.claim()
    owner.sync.setEnabled(true)
    const a = peer()
    a.sync.setEnabled(true)
    const b = peer()
    b.sync.setEnabled(true)
    expect(a.sync.command({ action: 'seek', position: 63 })).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(a.sync.read()?.position).toBe(63)
    expect(b.sync.read()?.position).toBe(63)
    b.sync.command({ action: 'pause' })
    await vi.advanceTimersByTimeAsync(0)
    vi.advanceTimersByTime(2000)
    expect(a.sync.read()).toMatchObject({ position: 63, playing: false })
    a.sync.command({ action: 'select', trackId: 'b', queueIds: ['b', 'a'] })
    b.sync.command({ action: 'previous' })
    b.sync.command({ action: 'next' })
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.onCommand.mock.calls.map(([action]) => action.action)).toEqual([
      'seek',
      'pause',
      'select',
      'previous',
      'next',
    ])
    expect(a.onCommand).not.toHaveBeenCalled()
    expect(b.onCommand).not.toHaveBeenCalled()
  })
  it('stops following at the final position when the owner closes, without taking audio ownership', () => {
    const owner = peer()
    owner.coordinator.claim()
    owner.sync.setEnabled(true)
    const follower = peer()
    follower.sync.setEnabled(true)
    owner.state.position = 48
    owner.sync.dispose()
    owner.coordinator.dispose()
    expect(follower.onStop).toHaveBeenCalledWith(
      expect.objectContaining({ position: 48, playing: false }),
    )
    expect(follower.sync.read()).toBeNull()
    expect(follower.sync.command({ action: 'play' })).toBe(false)
    expect(follower.coordinator.owns()).toBe(false)
    expect(follower.coordinator.canPersist()).toBe(false)
  })
  it('expires a crashed owner and discards old owner states, malformed states and duplicate commands', async () => {
    const owner = peer()
    owner.coordinator.claim()
    owner.sync.setEnabled(true)
    const follower = peer()
    follower.sync.setEnabled(true)
    const wire = [...Bus.all].find((bus) => bus.name === 'meliora:playback-sync:v1')!
    follower.sync.command({ action: 'next' })
    const command = Bus.messages.at(-1)
    wire.onmessage?.({ data: command })
    wire.onmessage?.({ data: command })
    await vi.advanceTimersByTimeAsync(0)
    expect(owner.onCommand).toHaveBeenCalledTimes(1)
    const oldOwner = owner.coordinator.owner()
    owner.coordinator.release()
    vi.advanceTimersByTime(6250)
    expect(follower.onStop).toHaveBeenCalledOnce()
    expect(follower.sync.read()).toBeNull()
    const nextOwner = peer()
    nextOwner.coordinator.claim()
    nextOwner.sync.setEnabled(true)
    nextOwner.state.position = 80
    nextOwner.sync.publish(true)
    wire.postMessage({
      version: 1,
      kind: 'state',
      sender: 'old',
      sequence: 900,
      at: Date.now(),
      owner: oldOwner,
      state: owner.state,
    })
    wire.postMessage({
      version: 1,
      kind: 'state',
      sender: 'broken',
      sequence: 901,
      at: Date.now(),
      owner: nextOwner.coordinator.owner(),
      state: { ...nextOwner.state, position: NaN },
    })
    expect(follower.sync.read()?.position).toBe(80)
  })
  it('stops timers and messages when disabled and re-joins when enabled again', () => {
    const owner = peer()
    owner.coordinator.claim()
    owner.sync.setEnabled(true)
    const follower = peer()
    follower.sync.setEnabled(true)
    follower.sync.setEnabled(false)
    const count = follower.onSnapshot.mock.calls.length
    owner.state.position = 65
    vi.advanceTimersByTime(1500)
    expect(follower.onSnapshot).toHaveBeenCalledTimes(count)
    expect(follower.sync.command({ action: 'pause' })).toBe(false)
    follower.sync.setEnabled(true)
    expect(follower.sync.read()?.position).toBe(65)
  })
  it('supports storage-event transport when BroadcastChannel is unavailable', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const write = safeStorage.setItem.bind(safeStorage)
    vi.spyOn(safeStorage, 'setItem').mockImplementation((key, value) => {
      write(key, value)
      window.dispatchEvent(new StorageEvent('storage', { key, newValue: value }))
    })
    const owner = peer()
    owner.coordinator.claim()
    owner.sync.setEnabled(true)
    const follower = peer()
    follower.sync.setEnabled(true)
    expect(follower.sync.read()?.position).toBe(12)
    follower.sync.command({ action: 'seek', position: 90 })
    await vi.advanceTimersByTimeAsync(0)
    expect(follower.sync.read()?.position).toBe(90)
    expect(owner.onCommand).toHaveBeenCalledOnce()
  })
})
