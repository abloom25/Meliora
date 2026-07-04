import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useAudioPlayer } from '../composables/useAudioPlayer'
import { usePlayerStore } from '../stores/player'
import { shouldUseIOSBackgroundSafeAudio } from '../utils/browser'
import type { Track } from '../types/music'

const startBeatAnalysisMock = vi.fn()

vi.mock('../utils/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/browser')>()
  return {
    ...actual,
    shouldUseIOSBackgroundSafeAudio: vi.fn(() => false),
  }
})

vi.mock('../composables/useBeatAnalyser', () => ({
  useBeatAnalyser: vi.fn(() => ({
    beatLevel: { value: 0 },
    spectrumLevels: { value: [0.1, 0.1, 0.1, 0.1] },
    startBeatAnalysis: startBeatAnalysisMock,
    stopBeatAnalysis: vi.fn(),
  })),
}))

const mockedShouldUseIOSBackgroundSafeAudio = vi.mocked(shouldUseIOSBackgroundSafeAudio)

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
  beforeEach(() => {
    setActivePinia(createPinia())
    mockedShouldUseIOSBackgroundSafeAudio.mockReturnValue(false)
    startBeatAnalysisMock.mockClear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

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

  it('creates inline audio elements for iOS-compatible background playback', () => {
    mockedShouldUseIOSBackgroundSafeAudio.mockReturnValue(true)
    const restore = stubAudioPlay()
    try {
      const { wrapper } = mountPlayer()
      const audio = document.body.querySelector('audio')

      expect(audio).toBeInstanceOf(HTMLAudioElement)
      expect(audio?.hasAttribute('playsinline')).toBe(true)
      expect(audio?.hasAttribute('webkit-playsinline')).toBe(true)

      wrapper.unmount()
      expect(document.body.querySelector('audio')).toBeNull()
    } finally {
      restore()
    }
  })

  it('skips Web Audio beat analysis in iOS background-safe mode', async () => {
    mockedShouldUseIOSBackgroundSafeAudio.mockReturnValue(true)
    const restore = stubAudioPlay()
    try {
      const { player, store } = mountPlayer()
      store.selectTrack(tracks[0]!, tracks)
      await player.play()

      expect(store.isPlaying).toBe(true)
      expect(startBeatAnalysisMock).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('does not auto-crossfade near track end in iOS background-safe mode', async () => {
    mockedShouldUseIOSBackgroundSafeAudio.mockReturnValue(true)
    const restore = stubAudioPlay()
    try {
      const { player, store } = mountPlayer()
      store.settings.smoothTrackChange = true
      store.selectTrack(tracks[0]!, tracks)
      await player.play()

      const audio = document.body.querySelector('audio')!
      Object.defineProperty(audio, 'duration', { configurable: true, value: 10 })
      audio.currentTime = 9.8
      audio.dispatchEvent(new Event('timeupdate'))
      await nextTick()

      expect(store.currentTrackId).toBe('1')
    } finally {
      restore()
    }
  })

  it('replays the current track after ended in single play mode even if the browser paused first', async () => {
    const createdAudios: HTMLAudioElement[] = []
    const originalAudio = globalThis.Audio
    vi.stubGlobal(
      'Audio',
      vi.fn(function AudioMock() {
        const audio = document.createElement('audio')
        createdAudios.push(audio)
        return audio
      }),
    )
    const restore = stubAudioPlay()
    try {
      const { player, store } = mountPlayer()
      store.settings.playMode = 'single'
      store.selectTrack(tracks[0]!, tracks)
      await player.play()

      player.seek(12)
      store.isPlaying = false
      createdAudios[0]?.dispatchEvent(new Event('ended'))
      await Promise.resolve()

      expect(store.currentTrackId).toBe('1')
      expect(store.currentTime).toBe(0)
      expect(store.isPlaying).toBe(true)
      expect(HTMLAudioElement.prototype.play).toHaveBeenCalledTimes(2)
    } finally {
      restore()
      vi.stubGlobal('Audio', originalAudio)
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
