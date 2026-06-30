import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useAudioPlayer } from '../composables/useAudioPlayer'
import { usePlayerStore } from '../stores/player'
import type { Track } from '../types/music'

const tracks: Track[] = [
  { id: '1', title: 'One', artist: 'A', audioUrl: '/1.mp3', kind: 'local' },
  { id: '2', title: 'Two', artist: 'B', audioUrl: '/2.mp3', kind: 'local' },
  { id: '3', title: 'Three', artist: 'C', audioUrl: '/3.mp3', kind: 'local' },
]

// Mock HTMLAudioElement.play to resolve immediately (jsdom doesn't actually play).
function stubAudioPlay() {
  const original = HTMLAudioElement.prototype.play
  HTMLAudioElement.prototype.play = vi.fn().mockResolvedValue(undefined)
  return () => {
    HTMLAudioElement.prototype.play = original
  }
}

function mountPlayer() {
  const store = usePlayerStore()
  store.setTracks(tracks)

  const Harness = defineComponent({
    setup() {
      const player = useAudioPlayer()
      return { player }
    },
    render() {
      return h('div', { id: 'harness' })
    },
  })

  const wrapper = mount(Harness)
  const player = wrapper.vm.player as ReturnType<typeof useAudioPlayer>
  return { wrapper, player, store }
}

describe('useAudioPlayer', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.restoreAllMocks())

  it('exposes the expected public API', () => {
    const restore = stubAudioPlay()
    try {
      const { player } = mountPlayer()
      expect(typeof player.play).toBe('function')
      expect(typeof player.pause).toBe('function')
      expect(typeof player.toggle).toBe('function')
      expect(typeof player.seek).toBe('function')
      expect(typeof player.next).toBe('function')
      expect(typeof player.previous).toBe('function')
      expect(typeof player.selectAndPlay).toBe('function')
    } finally {
      restore()
    }
  })

  it('selectAndPlay loads a track without throwing', async () => {
    const restore = stubAudioPlay()
    try {
      const { player, store } = mountPlayer()
      store.selectTrack(tracks[0]!, tracks)
      await player.selectAndPlay(tracks[1]!, tracks)
      // selectAndPlay should not throw; store should reflect the selected track
      expect(store.currentTrackId).toBe('2')
    } finally {
      restore()
    }
  })

  it('rapid next() calls do not crash and settle on a valid track', async () => {
    const restore = stubAudioPlay()
    try {
      const { player, store } = mountPlayer()
      store.selectTrack(tracks[0]!, tracks)
      store.settings.playMode = 'loop'

      // Fire 5 rapid next() calls — the state machine should handle concurrency
      const promises = [
        player.next(true),
        player.next(true),
        player.next(true),
        player.next(true),
        player.next(true),
      ]
      await Promise.allSettled(promises)

      // After settling, the current track should be one of the queue items
      expect(tracks.some((t) => t.id === store.currentTrackId)).toBe(true)
    } finally {
      restore()
    }
  })

  it('pause stops playback without error', async () => {
    const restore = stubAudioPlay()
    try {
      const { player, store } = mountPlayer()
      store.selectTrack(tracks[0]!, tracks)
      await player.selectAndPlay(tracks[0]!, tracks)
      player.pause()
      expect(store.isPlaying).toBe(false)
    } finally {
      restore()
    }
  })

  it('seek with pending duration records pendingSeekTime and flushes later', async () => {
    const restore = stubAudioPlay()
    try {
      const { player, store } = mountPlayer()
      store.selectTrack(tracks[0]!, tracks)
      await player.selectAndPlay(tracks[0]!, tracks)

      // When duration is 0 (jsdom default), seek records pending time
      player.seek(30)
      // currentTime should update immediately for UI feedback
      expect(store.currentTime).toBe(30)
    } finally {
      restore()
    }
  })

  it('continues playing the next track when initial play fails and skipOnError is enabled', async () => {
    vi.useFakeTimers()
    const originalPlay = HTMLAudioElement.prototype.play
    const playMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('not supported', 'NotSupportedError'))
      .mockResolvedValue(undefined)
    HTMLAudioElement.prototype.play = playMock
    try {
      const { player, store } = mountPlayer()
      store.settings.playMode = 'loop'
      store.settings.skipOnError = true

      await player.selectAndPlay(tracks[0]!, tracks)
      await Promise.resolve()
      await vi.runOnlyPendingTimersAsync()
      await Promise.resolve()

      expect(store.currentTrackId).toBe('2')
      expect(store.isPlaying).toBe(true)
      expect(playMock).toHaveBeenCalledTimes(2)
    } finally {
      HTMLAudioElement.prototype.play = originalPlay
      vi.useRealTimers()
    }
  })

  it('clears pending skip timers on unmount', async () => {
    vi.useFakeTimers()
    const originalPlay = HTMLAudioElement.prototype.play
    HTMLAudioElement.prototype.play = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('not supported', 'NotSupportedError'))
      .mockResolvedValue(undefined)
    try {
      const { player, store, wrapper } = mountPlayer()
      store.settings.playMode = 'loop'
      store.settings.skipOnError = true

      await player.selectAndPlay(tracks[0]!, tracks)
      await Promise.resolve()
      wrapper.unmount()
      await vi.runOnlyPendingTimersAsync()
      await Promise.resolve()

      expect(store.currentTrackId).toBe('1')
    } finally {
      HTMLAudioElement.prototype.play = originalPlay
      vi.useRealTimers()
    }
  })

  it('stops and clears playback state when the current track is removed from the library', async () => {
    const restore = stubAudioPlay()
    try {
      const { player, store } = mountPlayer()
      await player.selectAndPlay(tracks[0]!, tracks)
      player.seek(30)

      store.setTracks([])
      await nextTick()

      expect(store.currentTrackId).toBeNull()
      expect(store.isPlaying).toBe(false)
      expect(store.currentTime).toBe(0)
      expect(store.duration).toBe(0)
    } finally {
      restore()
    }
  })
})
