import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick, ref, watch } from 'vue'
import { mount } from '@vue/test-utils'
import { useAudioPlayer, type UseAudioPlayerOptions } from '../composables/useAudioPlayer'
import { usePlayerStore } from '../stores/player'
import { shouldUseIOSBackgroundSafeAudio } from '../platform/web/browser'
import type { Track } from '../core/types'
import { useBeatAnalyser } from '../platform/web/useBeatAnalyser'
import { PLAYBACK_SESSION_KEY } from '../core/playback/session'
import { createPlaybackCoordinator } from '../platform/web/playback-coordinator'

const startBeatAnalysisMock = vi.fn()

vi.mock('../platform/web/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform/web/browser')>()
  return {
    ...actual,
    shouldUseIOSBackgroundSafeAudio: vi.fn(() => false),
  }
})

vi.mock('../platform/web/useBeatAnalyser', () => ({
  useBeatAnalyser: vi.fn(() => ({
    beatLevel: { value: 0 },
    spectrumLevels: { value: [0.1, 0.1, 0.1, 0.1, 0.1] },
    startBeatAnalysis: startBeatAnalysisMock,
    stopBeatAnalysis: vi.fn(),
    resetBeatTracking: vi.fn(),
    preanalysis: {
      status: { value: { phase: 'idle', progress: 0, error: null } },
      timeline: { value: null },
      start: vi.fn(),
      reset: vi.fn(),
      retry: vi.fn(),
    },
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

function mountPlayer(options: UseAudioPlayerOptions = {}) {
  const store = usePlayerStore()
  store.setTracks(tracks.map((track) => ({ ...track })))

  const Harness = defineComponent({
    setup() {
      const player = useAudioPlayer(options)
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
  it.each(['disable', 'close'] as const)(
    'shares one audio clock and resumes locally after %s',
    async (leaveMode) => {
      vi.useFakeTimers()
      class Bus {
        static all = new Set<Bus>()
        onmessage: ((event: { data: unknown }) => void) | null = null
        readonly name: string
        constructor(name: string) {
          this.name = name
          Bus.all.add(this)
        }
        postMessage(data: unknown): void {
          for (const peer of Bus.all)
            if (peer !== this && peer.name === this.name) peer.onmessage?.({ data })
        }
        close(): void {
          Bus.all.delete(this)
        }
      }
      vi.stubGlobal('BroadcastChannel', Bus)
      const paused = new WeakMap<HTMLMediaElement, boolean>()
      vi.spyOn(HTMLMediaElement.prototype, 'paused', 'get').mockImplementation(function (
        this: HTMLMediaElement,
      ) {
        return paused.get(this) ?? true
      })
      vi.spyOn(HTMLMediaElement.prototype, 'duration', 'get').mockReturnValue(120)
      vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4)
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
        this: HTMLMediaElement,
      ) {
        paused.set(this, false)
        this.dispatchEvent(new Event('play'))
        this.dispatchEvent(new Event('playing'))
        return Promise.resolve()
      })
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
        this: HTMLMediaElement,
      ) {
        if (paused.get(this) === false) {
          paused.set(this, true)
          this.dispatchEvent(new Event('pause'))
        }
      })
      const owner = mountPlayer()
      owner.store.settings.syncTabPlayback = true
      owner.store.settings.smoothTrackChange = false
      owner.store.settings.preloadNextTrack = false
      await nextTick()
      await owner.player.play()
      owner.player.seek(40)
      const ownerAudio = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0].getActiveAudio()
      setActivePinia(createPinia())
      const follower = mountPlayer()
      follower.store.settings.syncTabPlayback = true
      await nextTick()
      const followerAnalysis = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0]
      const followerAudio = followerAnalysis.getActiveAudio()
      try {
        expect(follower.store.currentTrackId).toBe(owner.store.currentTrackId)
        expect(follower.store.currentTime).toBe(40)
        expect(follower.store.isPlaying).toBe(true)
        expect(follower.player.getLyricsPlaybackState().playing).toBe(true)
        expect(followerAudio.paused).toBe(true)
        expect(followerAudio.getAttribute('src')).toBeNull()
        expect(followerAnalysis.enabled?.value).toBe(false)
        expect(followerAnalysis.isPlaying.value).toBe(false)
        expect(play).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(250)
        expect(follower.store.currentTime).toBeCloseTo(40.25)
        // Old native events in a silent follower cannot overwrite the shared clock.
        followerAudio.dispatchEvent(new Event('pause'))
        followerAudio.dispatchEvent(new Event('timeupdate'))
        followerAudio.dispatchEvent(new Event('durationchange'))
        expect(follower.store.isPlaying).toBe(true)
        expect(follower.store.currentTime).toBeCloseTo(40.25)
        follower.player.seek(73)
        await vi.advanceTimersByTimeAsync(0)
        expect(ownerAudio.currentTime).toBe(73)
        expect(follower.store.currentTime).toBe(73)
        follower.player.pause()
        await vi.advanceTimersByTimeAsync(0)
        expect(owner.store.isPlaying).toBe(false)
        expect(follower.store.isPlaying).toBe(false)
        await follower.player.play()
        await vi.advanceTimersByTimeAsync(0)
        expect(owner.store.isPlaying).toBe(true)
        expect(followerAudio.paused).toBe(true)
        expect(play.mock.instances.every((audio) => audio === ownerAudio)).toBe(true)
        await follower.player.next()
        await vi.advanceTimersByTimeAsync(0)
        expect(owner.store.currentTrackId).toBe('2')
        expect(follower.store.currentTrackId).toBe('2')
        // Metadata remains visible even before this page's library is available.
        follower.store.setTracks([])
        expect(follower.store.currentTrack?.title).toBe('Two')
        follower.player.seek(35)
        await vi.advanceTimersByTimeAsync(0)
        if (leaveMode === 'disable') follower.store.settings.tabCoordination = false
        else owner.wrapper.unmount()
        await nextTick()
        expect(follower.store.isPlaying).toBe(false)
        expect(follower.store.currentTime).toBe(35)
        expect(follower.player.getLyricsPlaybackState()).toMatchObject({
          timeSeconds: 35,
          playing: false,
        })
        expect(followerAudio.getAttribute('src')).toBeNull()
        await follower.player.play()
        expect(followerAudio.paused).toBe(false)
        expect(followerAudio.currentTime).toBe(35)
        if (leaveMode === 'disable') expect(owner.store.isPlaying).toBe(true)
      } finally {
        follower.wrapper.unmount()
        owner.wrapper.unmount()
        vi.unstubAllGlobals()
        vi.useRealTimers()
      }
    },
  )
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mockedShouldUseIOSBackgroundSafeAudio.mockReturnValue(false)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    document.body.innerHTML = ''
  })

  function saveResume(position = 42): void {
    localStorage.setItem(
      PLAYBACK_SESSION_KEY,
      JSON.stringify({
        version: 1,
        queueIds: ['1', '2', '3'],
        customQueue: true,
        currentTrackId: '1',
        audioUrl: '/1.mp3',
        position,
        journey: { history: ['1'], historyIndex: 0, remaining: [], played: ['1'], priority: [] },
      }),
    )
  }

  it.each([false, true])(
    'holds the current song offline and respects pause before reconnection (pause: %s)',
    async (cancel) => {
      vi.useFakeTimers()
      const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
      vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
      const { player, wrapper, store } = mountPlayer()
      try {
        store.settings.preloadNextTrack = false
        await player.play()
        const audio = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0].getActiveAudio()
        let error: { code: number } | null = { code: 2 }
        Object.defineProperties(audio, {
          error: { configurable: true, get: () => error },
          duration: { configurable: true, value: 120 },
        })
        audio.currentTime = 42
        audio.dispatchEvent(new Event('timeupdate'))
        audio.dispatchEvent(new Event('error'))
        expect(store.errorMessage).toContain('网络已断开')
        expect(store.currentTrackId).toBe('1')
        await vi.advanceTimersByTimeAsync(30000)
        expect(play).toHaveBeenCalledTimes(1)
        expect(store.currentTime).toBe(42)
        player.seek(55)
        if (cancel) player.pause()
        error = null
        online.mockReturnValue(true)
        window.dispatchEvent(new Event('online'))
        await vi.advanceTimersByTimeAsync(1000)
        expect(play).toHaveBeenCalledTimes(cancel ? 1 : 2)
        expect(store.isPlaying).toBe(!cancel)
        expect(store.currentTime).toBe(55)
        expect(store.currentTrackId).toBe('1')
      } finally {
        wrapper.unmount()
        vi.useRealTimers()
      }
    },
  )

  it('does not skip or blacklist a selected song when autoplay permission is blocked', async () => {
    vi.useFakeTimers()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const { player, wrapper, store } = mountPlayer()
    try {
      store.settings.preloadNextTrack = false
      store.settings.skipOnError = true
      await player.play()
      play.mockRejectedValueOnce(new DOMException('blocked', 'NotAllowedError'))
      await player.selectAndPlay(tracks[1]!, tracks)
      await vi.advanceTimersByTimeAsync(1000)
      expect(store.currentTrackId).toBe('2')
      expect(store.isPlaying).toBe(false)
      expect(store.errorMessage).toContain('再次点击播放')
      await player.play()
      expect(store.currentTrackId).toBe('2')
      expect(store.isPlaying).toBe(true)
      expect(store.errorMessage).toBe('')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('recovers a waiting stream with no error event and does not retry a brief buffering pause', async () => {
    vi.useFakeTimers()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const { player, wrapper, store } = mountPlayer()
    try {
      store.settings.preloadNextTrack = false
      await player.play()
      const audio = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0].getActiveAudio()
      Object.defineProperty(audio, 'duration', { configurable: true, value: 120 })
      audio.currentTime = 40
      audio.dispatchEvent(new Event('waiting'))
      await vi.advanceTimersByTimeAsync(1000)
      audio.dispatchEvent(new Event('playing'))
      await vi.advanceTimersByTimeAsync(12000)
      expect(play).toHaveBeenCalledTimes(1)
      audio.dispatchEvent(new Event('waiting'))
      await vi.advanceTimersByTimeAsync(12800)
      expect(play).toHaveBeenCalledTimes(2)
      expect(store.currentTrackId).toBe('1')
      expect(store.currentTime).toBe(40)
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('ignores late native play completion after the network retry budget is exhausted', async () => {
    vi.useFakeTimers()
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    const { player, wrapper, store } = mountPlayer()
    try {
      store.settings.preloadNextTrack = false
      await player.play()
      const audio = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0].getActiveAudio()
      const finishes: Array<() => void> = []
      play.mockImplementation(() => new Promise<void>((resolve) => finishes.push(resolve)))
      Object.defineProperty(audio, 'error', { configurable: true, value: { code: 2 } })
      audio.currentTime = 42
      audio.dispatchEvent(new Event('error'))
      await vi.advanceTimersByTimeAsync(30000)
      expect(play).toHaveBeenCalledTimes(3)
      expect(store.isPlaying).toBe(false)
      expect(store.errorMessage).toContain('已保留进度')
      finishes.forEach((finish) => finish())
      await Promise.resolve()
      audio.dispatchEvent(new Event('play'))
      audio.dispatchEvent(new Event('playing'))
      expect(store.isPlaying).toBe(false)
      expect(store.currentTime).toBe(42)
      expect(pause).toHaveBeenCalled()
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('pauses on another page claim and cannot overwrite its session or restart on late media events', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    const { player, wrapper, store } = mountPlayer()
    const other = createPlaybackCoordinator({ onLost: vi.fn() })
    try {
      store.settings.preloadNextTrack = false
      await player.play()
      const audio = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0].getActiveAudio()
      other.claim()
      const remoteSession = JSON.stringify({ remote: 'do not overwrite' })
      localStorage.setItem(PLAYBACK_SESSION_KEY, remoteSession)
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'meliora:playback-owner:v1',
          newValue: localStorage.getItem('meliora:playback-owner:v1'),
        }),
      )
      expect(store.isPlaying).toBe(false)
      expect(pause).toHaveBeenCalled()
      store.currentTime = 99
      store.persistPlaybackSession()
      window.dispatchEvent(new Event('pagehide'))
      expect(localStorage.getItem(PLAYBACK_SESSION_KEY)).toBe(remoteSession)
      audio.dispatchEvent(new Event('play'))
      audio.dispatchEvent(new Event('playing'))
      expect(store.isPlaying).toBe(false)
      audio.dispatchEvent(new Event('ended'))
      expect(store.isPlaying).toBe(false)
      expect(other.owns()).toBe(true)
      wrapper.unmount()
      expect(localStorage.getItem(PLAYBACK_SESSION_KEY)).toBe(remoteSession)
    } finally {
      wrapper.unmount()
      other.dispose()
    }
  })

  it.each([false, true])(
    'seeking ends the outgoing fade while preserving incoming startup (pending: %s)',
    async (pendingStart) => {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
      vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
      vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
      vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
      const { player, wrapper, store } = mountPlayer()
      try {
        store.settings.preloadNextTrack = false
        store.settings.smoothTrackChange = true
        await player.play()
        const getAudio = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0].getActiveAudio
        const outgoing = getAudio()
        const oldPause = vi.spyOn(outgoing, 'pause')
        let finishStart: (() => void) | undefined
        if (pendingStart)
          play.mockImplementationOnce(
            () =>
              new Promise<void>((resolve) => {
                finishStart = resolve
              }),
          )
        await player.selectAndPlay(tracks[1]!, tracks)
        await Promise.resolve()
        const incoming = getAudio()
        Object.defineProperty(incoming, 'duration', { configurable: true, value: 120 })
        expect(incoming).not.toBe(outgoing)
        expect(incoming.volume).toBe(0)
        oldPause.mockClear()
        const starts = startBeatAnalysisMock.mock.calls.length
        player.seek(45)
        expect(incoming.currentTime).toBe(45)
        expect(incoming.volume).toBeCloseTo(store.settings.volume)
        expect(oldPause).toHaveBeenCalledOnce()
        expect(outgoing.volume).toBe(0)
        if (pendingStart) {
          finishStart!()
          await Promise.resolve()
          await Promise.resolve()
          expect(startBeatAnalysisMock.mock.calls.length).toBeGreaterThan(starts)
        }
        expect(incoming.volume).toBeCloseTo(store.settings.volume)
        expect(store.isPlaying).toBe(true)
        expect(store.currentTime).toBe(45)
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('restores the position after metadata without autoplay and keeps the prompt until play succeeds', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    saveResume()
    const { wrapper, player, store } = mountPlayer()
    try {
      const audio = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0].getActiveAudio()
      expect(play).not.toHaveBeenCalled()
      expect(store.isPlaying).toBe(false)
      expect(store.currentTime).toBe(42)
      audio.dispatchEvent(new Event('timeupdate'))
      expect(store.currentTime).toBe(42)
      Object.defineProperty(audio, 'duration', { configurable: true, value: 180 })
      audio.dispatchEvent(new Event('loadedmetadata'))
      expect(audio.currentTime).toBe(42)
      expect(store.hasResumePosition).toBe(true)
      window.dispatchEvent(new Event('pagehide'))
      expect(JSON.parse(localStorage.getItem(PLAYBACK_SESSION_KEY)!).position).toBe(42)
      await player.play()
      expect(store.hasResumePosition).toBe(false)
      expect(audio.currentTime).toBe(42)
      expect(store.isPlaying).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it('cancels a delayed resume seek when the current source is replaced', () => {
    saveResume()
    const { wrapper, store } = mountPlayer()
    try {
      const audio = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0].getActiveAudio()
      store.setTracks([{ ...tracks[0]!, audioUrl: '/replacement.mp3' }, tracks[1]!, tracks[2]!])
      Object.defineProperty(audio, 'duration', { configurable: true, value: 180 })
      audio.dispatchEvent(new Event('loadedmetadata'))
      expect(audio.currentTime).toBe(0)
      expect(store.hasResumePosition).toBe(false)
      expect(store.isPlaying).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('cancels a delayed resume seek after selecting another queued track and keeps queue edits', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    saveResume()
    const { wrapper, player, store } = mountPlayer()
    try {
      const analyser = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0]
      const previous = analyser.getActiveAudio()
      store.removeQueuedTrack('3')
      await player.selectQueuedAndPlay(tracks[1]!)
      Object.defineProperty(previous, 'duration', { configurable: true, value: 180 })
      previous.dispatchEvent(new Event('loadedmetadata'))
      expect(store.currentTrackId).toBe('2')
      expect(store.currentTime).toBe(0)
      expect(analyser.getActiveAudio().currentTime).toBe(0)
      expect(store.queue.map((track) => track.id)).toEqual(['1', '2'])
      expect(store.hasResumePosition).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('lets an explicit queue selection interrupt an automatic switch awaiting preload', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    const { wrapper, player, store } = mountPlayer()
    try {
      store.settings.preloadNextTrack = false
      store.settings.smoothTrackChange = false
      store.selectTrack(tracks[0]!, tracks)
      await player.play()
      const automatic = player.next(false)
      await player.selectQueuedAndPlay(tracks[2]!)
      await automatic
      expect(store.currentTrackId).toBe('3')
      expect(store.isPlaying).toBe(true)
      expect(store.queue.map((track) => track.id)).toEqual(['1', '2', '3'])
    } finally {
      wrapper.unmount()
    }
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

  it('exposes the real lyric clock and notifies media state changes without treating stalled as waiting', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    const { player, wrapper, store } = mountPlayer()
    try {
      const analyser = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0]
      const audio = analyser.getActiveAudio()
      Object.defineProperties(audio, {
        paused: { configurable: true, value: false },
        ended: { configurable: true, value: false },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_FUTURE_DATA },
        seeking: { configurable: true, value: false },
      })
      audio.currentTime = 12
      audio.playbackRate = 1.5
      store.isPlaying = true
      await nextTick()
      const listener = vi.fn()
      const stop = player.subscribeLyricsPlayback(listener)
      expect(player.getLyricsPlaybackState()).toEqual({
        timeSeconds: 12,
        playing: true,
        playbackRate: 1.5,
        seeking: false,
      })
      audio.dispatchEvent(new Event('stalled'))
      expect(player.getLyricsPlaybackState().playing).toBe(true)
      audio.dispatchEvent(new Event('waiting'))
      expect(player.getLyricsPlaybackState().playing).toBe(false)
      expect(listener).toHaveBeenCalledTimes(1)
      audio.dispatchEvent(new Event('playing'))
      expect(player.getLyricsPlaybackState().playing).toBe(true)
      Object.defineProperty(audio, 'seeking', { configurable: true, value: true })
      audio.dispatchEvent(new Event('seeking'))
      expect(player.getLyricsPlaybackState().seeking).toBe(true)
      stop()
      const count = listener.mock.calls.length
      audio.dispatchEvent(new Event('ratechange'))
      expect(listener).toHaveBeenCalledTimes(count)
    } finally {
      wrapper.unmount()
    }
  })

  it('follows the promoted channel and ignores lyric clock events from the outgoing channel', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    const { player, wrapper, store } = mountPlayer()
    try {
      store.settings.preloadNextTrack = false
      store.settings.smoothTrackChange = false
      store.selectTrack(tracks[0]!, tracks)
      const analyser = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0]
      const outgoing = analyser.getActiveAudio()
      for (const audio of analyser.players) {
        Object.defineProperties(audio, {
          paused: { configurable: true, value: false },
          ended: { configurable: true, value: false },
          readyState: { configurable: true, value: HTMLMediaElement.HAVE_FUTURE_DATA },
          duration: { configurable: true, value: 120 },
        })
      }
      const listener = vi.fn()
      player.subscribeLyricsPlayback(listener)
      await player.selectAndPlay(tracks[1]!, tracks)
      await nextTick()
      const incoming = analyser.getActiveAudio()
      expect(incoming).not.toBe(outgoing)
      listener.mockClear()
      outgoing.currentTime = 54
      for (const event of ['timeupdate', 'waiting', 'playing', 'seeked', 'ratechange'])
        outgoing.dispatchEvent(new Event(event))
      expect(listener).not.toHaveBeenCalled()
      expect(store.currentTime).toBe(0)

      incoming.currentTime = 7
      incoming.dispatchEvent(new Event('timeupdate'))
      expect(listener).toHaveBeenCalledTimes(1)
      expect(player.getLyricsPlaybackState()).toMatchObject({ timeSeconds: 7, playing: true })
      expect(store.currentTime).toBe(7)
      incoming.dispatchEvent(new Event('waiting'))
      expect(player.getLyricsPlaybackState().playing).toBe(false)
      outgoing.dispatchEvent(new Event('playing'))
      expect(listener).toHaveBeenCalledTimes(2)
      expect(player.getLyricsPlaybackState().playing).toBe(false)
      incoming.dispatchEvent(new Event('canplay'))
      expect(listener).toHaveBeenCalledTimes(3)
      expect(player.getLyricsPlaybackState().playing).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })

  it('moves the lyric clock and subscriptions to a CORS replacement and releases them on unmount', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { player, wrapper, store } = mountPlayer()
    const listener = vi.fn()
    let replacement: HTMLAudioElement | undefined
    try {
      store.settings.preloadNextTrack = false
      store.selectTrack(tracks[0]!, tracks)
      store.isPlaying = true
      await nextTick()
      const analyser = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0]
      const previous = analyser.getActiveAudio()
      Object.defineProperties(previous, {
        paused: { configurable: true, value: false },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_FUTURE_DATA },
      })
      previous.currentTime = 18
      player.subscribeLyricsPlayback(listener)
      analyser.onTainted?.(previous)
      replacement = analyser.getActiveAudio()
      expect(replacement).not.toBe(previous)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(player.getLyricsPlaybackState().playing).toBe(false)
      listener.mockClear()
      for (const event of ['timeupdate', 'waiting', 'playing', 'seeking', 'ratechange'])
        previous.dispatchEvent(new Event(event))
      expect(listener).not.toHaveBeenCalled()

      Object.defineProperties(replacement, {
        paused: { configurable: true, value: false },
        ended: { configurable: true, value: false },
        readyState: { configurable: true, value: HTMLMediaElement.HAVE_FUTURE_DATA },
        duration: { configurable: true, value: 120 },
      })
      replacement.dispatchEvent(new Event('loadedmetadata'))
      expect(player.getLyricsPlaybackState()).toMatchObject({ timeSeconds: 18, playing: true })
      replacement.currentTime = 19
      replacement.dispatchEvent(new Event('timeupdate'))
      expect(store.currentTime).toBe(19)
      replacement.dispatchEvent(new Event('waiting'))
      expect(player.getLyricsPlaybackState().playing).toBe(false)
      previous.dispatchEvent(new Event('playing'))
      expect(player.getLyricsPlaybackState().playing).toBe(false)
      replacement.dispatchEvent(new Event('playing'))
      expect(player.getLyricsPlaybackState().playing).toBe(true)
    } finally {
      wrapper.unmount()
    }
    const count = listener.mock.calls.length
    replacement?.dispatchEvent(new Event('timeupdate'))
    replacement?.dispatchEvent(new Event('playing'))
    expect(listener).toHaveBeenCalledTimes(count)
    expect(player.getLyricsPlaybackState().playing).toBe(false)
  })

  it('enables faster real-output diagnostics only on the visible comparison tab', () => {
    const debugEnabled = ref(false)
    const beatComparisonEnabled = ref(false)
    const { wrapper, store } = mountPlayer({ debugEnabled, beatComparisonEnabled })
    try {
      const options = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0]
      beatComparisonEnabled.value = true
      expect(options.debugEnabled?.value).toBe(false)
      expect(options.debugSampleIntervalMs?.value).toBe(100)
      debugEnabled.value = true
      expect(options.debugSampleIntervalMs?.value).toBeCloseTo(1000 / 30)
      expect(store.settings.beatAnalysisMode).toBe('basic')
      beatComparisonEnabled.value = false
      expect(options.debugSampleIntervalMs?.value).toBe(100)
      debugEnabled.value = false
      expect(options.debugEnabled?.value).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps diagnostics and comparison disabled in production even when callers request them', async () => {
    vi.stubEnv('DEV', false)
    const { wrapper, player } = mountPlayer({
      debugEnabled: ref(true),
      beatComparisonEnabled: ref(true),
    })
    try {
      const options = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0]
      expect(options.debugEnabled?.value).toBe(false)
      expect(options.debugSampleIntervalMs?.value).toBe(100)
      expect(player.canCompareBeats.value).toBe(false)
      await player.startBeatComparison()
      expect(player.beatComparison.value.phase).toBe('idle')
      expect(player.beatComparisonRecording.value.sampleCount).toBe(0)
    } finally {
      wrapper.unmount()
    }
  })

  it('passes real preload targets to beat analysis and rotates previous/next with playback', async () => {
    vi.useFakeTimers()
    const restore = stubAudioPlay()
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
    const { player, store, wrapper } = mountPlayer()
    try {
      const options = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0]
      store.settings.smoothTrackChange = false
      store.selectTrack(tracks[0]!, tracks)
      await vi.advanceTimersByTimeAsync(0)
      expect(options.adjacent?.value).toEqual([
        { direction: 'next', source: '/2.mp3', title: 'Two' },
        { direction: 'previous', source: '/3.mp3', title: 'Three' },
      ])
      const nextAudio = options.players.find((audio) => audio.src.endsWith('/2.mp3'))!
      Object.defineProperty(nextAudio, 'duration', { configurable: true, value: 90 })
      nextAudio.dispatchEvent(new Event('loadedmetadata'))
      nextAudio.dispatchEvent(new Event('canplay'))
      expect(options.adjacent?.value[0]?.durationSeconds).toBe(90)

      let candidatesAtPromotion: readonly string[] = []
      const stopPromotionWatch = watch(
        options.source!,
        (source) => {
          if (source === '/2.mp3')
            candidatesAtPromotion = options.adjacent!.value.map((target) => target.source)
        },
        { flush: 'sync' },
      )

      // A paused switch still promotes the exact prepared source and puts the
      // outgoing song in the opposite slot without a fresh shuffle prediction.
      await player.next(true)
      stopPromotionWatch()
      expect(options.source?.value).toBe('/2.mp3')
      expect(candidatesAtPromotion).toContain('/2.mp3')
      expect(options.adjacent?.value.some((target) => target.source === '/2.mp3')).toBe(false)
      expect(options.adjacent?.value).toContainEqual({
        direction: 'previous',
        source: '/1.mp3',
        title: 'One',
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(options.adjacent?.value[0]?.source).toBe('/3.mp3')

      store.settings.preloadNextTrack = false
      expect(options.preloadEnabled?.value).toBe(false)
      expect(options.adjacent?.value).toEqual([])
      store.settings.preloadNextTrack = true
      await vi.advanceTimersByTimeAsync(0)
      expect(options.adjacent?.value).toHaveLength(2)
      store.setTracks([])
      expect(options.adjacent?.value).toEqual([])
    } finally {
      wrapper.unmount()
      restore()
      vi.useRealTimers()
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

  it.each([
    [45.125, 45.125],
    [80.125, 65],
  ])(
    'opens a shared position %s after resume without autoplay and clamps on metadata',
    async (time, expected) => {
      const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
      saveResume()
      const { wrapper, player, store } = mountPlayer()
      try {
        player.pause()
        store.selectTrack(tracks[1]!, store.tracks)
        player.seek(time)
        const audio = vi.mocked(useBeatAnalyser).mock.calls.at(-1)![0].getActiveAudio()
        expect(store.currentTrackId).toBe('2')
        expect(store.currentTime).toBe(time)
        expect(store.hasResumePosition).toBe(false)
        expect(store.isPlaying).toBe(false)
        expect(play).not.toHaveBeenCalled()
        Object.defineProperty(audio, 'duration', { configurable: true, value: 65 })
        audio.dispatchEvent(new Event('loadedmetadata'))
        expect(audio.currentTime).toBe(expected)
        expect(store.currentTime).toBe(expected)
        expect(play).not.toHaveBeenCalled()
        await player.play()
        expect(store.isPlaying).toBe(true)
      } finally {
        wrapper.unmount()
      }
    },
  )

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

  it.each(['beatnet', 'madmom-onset'])(
    'migrates the removed %s preference to basic preanalysis',
    (legacy) => {
      const store = usePlayerStore()
      Object.assign(store.settings, { beatAnalysisMode: legacy })
      const { wrapper, player } = mountPlayer()
      expect(store.settings.beatAnalysisMode).toBe('basic')
      expect(player.beatBuildStatus.value.phase).toBe('idle')
      expect(typeof player.retryBeatBuild).toBe('function')
      wrapper.unmount()
    },
  )

  it('waits for fulfilled play before starting preanalysis, not the earlier play event', async () => {
    let finishPlay!: () => void
    const playMock = vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (
      this: HTMLMediaElement,
    ) {
      this.dispatchEvent(new Event('play'))
      return new Promise<void>((resolve) => {
        finishPlay = resolve
      })
    })
    const { wrapper, player, store } = mountPlayer()
    store.settings.preloadNextTrack = false
    store.selectTrack(tracks[0]!, tracks)
    const pending = player.play()
    await nextTick()
    expect(playMock).toHaveBeenCalledTimes(1)
    expect(startBeatAnalysisMock).not.toHaveBeenCalled()
    finishPlay()
    await pending
    expect(startBeatAnalysisMock).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('starts analysis on active playing events but ignores a preload channel playing', async () => {
    const createdAudios: HTMLAudioElement[] = []
    const originalAudio = globalThis.Audio
    vi.stubGlobal(
      'Audio',
      vi.fn(function () {
        const audio = document.createElement('audio')
        createdAudios.push(audio)
        return audio
      }),
    )
    try {
      const { wrapper, store } = mountPlayer()
      store.selectTrack(tracks[0]!, tracks)
      store.isPlaying = true
      createdAudios[0]!.dispatchEvent(new Event('play'))
      expect(startBeatAnalysisMock).not.toHaveBeenCalled()
      createdAudios[1]!.dispatchEvent(new Event('playing'))
      expect(startBeatAnalysisMock).not.toHaveBeenCalled()
      createdAudios[0]!.dispatchEvent(new Event('playing'))
      expect(startBeatAnalysisMock).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    } finally {
      vi.stubGlobal('Audio', originalAudio)
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
      Object.defineProperty(createdAudios[0]!, 'ended', { configurable: true, value: true })
      createdAudios[0]?.dispatchEvent(new Event('pause'))
      expect(store.isPlaying).toBe(true)
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

  it('keeps playing through auto-advance when the browser fires pause before ended', async () => {
    vi.useFakeTimers()
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
      store.settings.playMode = 'loop'
      store.settings.preloadNextTrack = false
      store.settings.smoothTrackChange = false
      store.selectTrack(tracks[0]!, tracks)
      await player.play()

      // 浏览器自然播完的事件序:先 pause(此时 audio.ended 已为 true)再 ended。
      // 该 pause 不得改变播放状态,否则 ended 里的 next(false) 会以 shouldPlay=false
      // 切歌但不播放(审核外实测确认的 Chrome 行为)。
      const audio = createdAudios[0]!
      Object.defineProperty(audio, 'ended', { configurable: true, value: true })
      audio.dispatchEvent(new Event('pause'))
      expect(store.isPlaying).toBe(true)
      audio.dispatchEvent(new Event('ended'))
      createdAudios.forEach((element) => element.dispatchEvent(new Event('canplay')))
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)

      expect(store.currentTrackId).toBe('2')
      expect(store.isPlaying).toBe(true)
    } finally {
      restore()
      vi.stubGlobal('Audio', originalAudio)
      vi.useRealTimers()
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

  it('treats a pause during startup as a cancellation, not a failed track', async () => {
    vi.useFakeTimers()
    const originalPlay = HTMLAudioElement.prototype.play
    const originalPause = HTMLAudioElement.prototype.pause
    // 启动还没完成就被暂停:浏览器会把悬着的 play() 打断成 AbortError
    let rejectPendingPlay: ((error: unknown) => void) | null = null
    HTMLAudioElement.prototype.play = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPendingPlay = reject
        }),
    )
    HTMLAudioElement.prototype.pause = vi.fn(() => {
      rejectPendingPlay?.(new DOMException('interrupted by pause', 'AbortError'))
      rejectPendingPlay = null
    })
    try {
      const { player, store } = mountPlayer()
      store.settings.playMode = 'loop'
      store.settings.skipOnError = true

      await player.selectAndPlay(tracks[0]!, tracks)
      player.pause()
      await vi.runOnlyPendingTimersAsync()
      await Promise.resolve()

      // 取消不是失败:不能跳到下一首,也不该弹任何提示
      expect(store.currentTrackId).toBe('1')
      expect(store.isPlaying).toBe(false)
      expect(store.errorMessage).toBe('')
      expect(player.preloadMessage.value).toBe('')
    } finally {
      HTMLAudioElement.prototype.play = originalPlay
      HTMLAudioElement.prototype.pause = originalPause
      vi.useRealTimers()
    }
  })

  it('keeps the audible channel to itself after the library reloads empty', async () => {
    vi.useFakeTimers()
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
      store.settings.playMode = 'loop'
      store.settings.smoothTrackChange = false
      store.settings.preloadNextTrack = true

      // 切过一次歌之后三路会轮转:第一路(出声通道的初始位置)落到了某个预加载槽手里
      await player.selectAndPlay(tracks[0]!, tracks)
      await player.next(true)
      await vi.runOnlyPendingTimersAsync()

      // 曲库重载成空(音源全挂/离线):播放停下,出声通道被拨回第一路
      store.setTracks([])
      expect(store.currentTrackId).toBeNull()

      // 曲库回来了,继续放一首
      store.setTracks(tracks)
      store.selectTrack(tracks[0]!, tracks)
      await vi.runOnlyPendingTimersAsync()

      // 预加载不能把正在出声的这一路 release 掉再塞进别的歌
      expect(createdAudios[0]?.src).toContain('/1.mp3')
    } finally {
      restore()
      vi.stubGlobal('Audio', originalAudio)
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

  it('pauses the audio left sounding by an aborted switch when switching again mid-flight', async () => {
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
    const originalPlay = HTMLAudioElement.prototype.play
    // 第一次切歌(目标元素 players[2])的 play() 永远 pending,
    // 模拟新歌尚未 settle 就被下一次切歌 abort 的场景。
    HTMLAudioElement.prototype.play = vi.fn(function playMock(this: HTMLAudioElement) {
      if (createdAudios.length > 2 && this === createdAudios[2]) {
        return new Promise<void>(() => {})
      }
      return Promise.resolve()
    })
    try {
      const { player, store } = mountPlayer()
      // 关闭预加载与淡入淡出,隔离出"被 abort 的切换遗留出声元素"这一条路径
      store.settings.preloadNextTrack = false
      store.settings.smoothTrackChange = false
      store.selectTrack(tracks[0]!, tracks)
      await player.play()
      expect(store.isPlaying).toBe(true)

      const staleAudio = createdAudios[0]!
      const stalePauseSpy = vi.spyOn(staleAudio, 'pause')

      // 切到 track2(play 挂起)→ 其 settle 前再切 track3,第一次切换被 abort
      await player.selectAndPlay(tracks[1]!, tracks)
      await player.selectAndPlay(tracks[2]!, tracks)
      await nextTick()

      expect(store.currentTrackId).toBe('3')
      // 被 abort 的切换遗留的旧元素必须被 pause + 静音,否则会一直出声(双重播放)
      expect(stalePauseSpy).toHaveBeenCalled()
      expect(staleAudio.volume).toBe(0)
    } finally {
      HTMLAudioElement.prototype.play = originalPlay
      vi.stubGlobal('Audio', originalAudio)
    }
  })

  it('retries a previously failed track after the failure TTL expires', async () => {
    vi.useFakeTimers()
    const originalPlay = HTMLAudioElement.prototype.play
    const playMock = vi.fn().mockResolvedValue(undefined)
    HTMLAudioElement.prototype.play = playMock
    try {
      const { player, store } = mountPlayer()
      store.settings.playMode = 'loop'
      store.settings.skipOnError = false

      await player.selectAndPlay(tracks[0]!, tracks)
      await Promise.resolve()

      // track2 播放失败一次 → 被标记失败（next 路径不 bump queueVersion，标记保留）
      playMock.mockRejectedValueOnce(new DOMException('boom', 'NotSupportedError'))
      await player.next(true)
      await Promise.resolve()
      expect(store.currentTrackId).toBe('2')

      // 回到 track1；TTL 内手动下一首会跳过 track2 落到 track3
      await player.previous()
      await Promise.resolve()
      expect(store.currentTrackId).toBe('1')
      await player.next(true)
      await Promise.resolve()
      expect(store.currentTrackId).toBe('3')

      // 上一首按真实历史返回 track1，失败的 track2 不应混入播放历史。
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000)
      await player.play()
      await Promise.resolve()
      await player.previous()
      expect(store.currentTrackId).toBe('1')
      // 前进先恢复历史中的 track3，再进入下一轮时 track2 可以正常重试。
      await player.next(true)
      await player.next(true)
      await player.next(true)
      await Promise.resolve()
      await Promise.resolve()
      expect(store.currentTrackId).toBe('2')
      expect(store.isPlaying).toBe(true)
    } finally {
      HTMLAudioElement.prototype.play = originalPlay
      vi.useRealTimers()
    }
  })

  it('keeps the current track when an early automatic crossfade cannot preload its target', async () => {
    vi.useFakeTimers()
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
      store.settings.playMode = 'loop'
      store.settings.skipOnError = true
      store.settings.preloadNextTrack = false
      store.settings.smoothTrackChange = false
      store.selectTrack(tracks[0]!, tracks)
      await player.play()

      // 自动切歌(waitForReady 路径):目标 track2 的预加载失败
      createdAudios[0]!.dispatchEvent(new Event('ended'))
      await vi.advanceTimersByTimeAsync(0)
      createdAudios[2]!.dispatchEvent(new Event('error'))
      await vi.advanceTimersByTimeAsync(0)

      // Preparation failure must not skip a song while the current audio can still play.
      expect(player.preloadMessage.value).not.toContain('已跳过')
      await vi.advanceTimersByTimeAsync(100)

      // track3 预加载就绪 → 完成切换
      createdAudios[2]!.dispatchEvent(new Event('canplay'))
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()

      expect(store.currentTrackId).toBe('1')
      expect(store.isPlaying).toBe(true)
    } finally {
      restore()
      vi.stubGlobal('Audio', originalAudio)
      vi.useRealTimers()
    }
  })

  it('commits the intended next song after the previous one ended even if speculative preload failed', async () => {
    vi.useFakeTimers()
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
      store.settings.playMode = 'sequence'
      store.settings.skipOnError = true
      store.settings.preloadNextTrack = false
      store.settings.smoothTrackChange = false
      store.selectTrack(tracks[1]!, tracks)
      await player.play()

      // sequence 模式下自动切到队尾 track3,其预加载失败 → 之后无实际后继
      Object.defineProperty(createdAudios[0]!, 'ended', { configurable: true, value: true })
      createdAudios[0]!.dispatchEvent(new Event('ended'))
      await vi.advanceTimersByTimeAsync(0)
      createdAudios[2]!.dispatchEvent(new Event('error'))
      await vi.advanceTimersByTimeAsync(200)

      // A speculative failure is not a permanent song failure; normal startup can succeed.
      expect(player.preloadMessage.value).not.toContain('继续播放')
      expect(store.currentTrackId).toBe('3')
      expect(store.isPlaying).toBe(true)
      expect(store.errorMessage).toBe('')
    } finally {
      restore()
      vi.stubGlobal('Audio', originalAudio)
      vi.useRealTimers()
    }
  })

  it('keeps the restored track playing without a false continue message when play fails and no successor exists', async () => {
    const originalPlay = HTMLAudioElement.prototype.play
    const playMock = vi.fn().mockResolvedValue(undefined)
    HTMLAudioElement.prototype.play = playMock
    try {
      const { player, store } = mountPlayer()
      store.settings.playMode = 'sequence'
      store.settings.skipOnError = true
      store.settings.preloadNextTrack = false
      store.settings.smoothTrackChange = false
      store.selectTrack(tracks[1]!, tracks)
      await player.play()
      expect(store.isPlaying).toBe(true)

      // 手动切到队尾 track3 时 play 失败:回退到 track2 后,sequence 下无实际后继
      playMock.mockRejectedValueOnce(new DOMException('boom', 'NotSupportedError'))
      await player.selectAndPlay(tracks[2]!, tracks)
      await Promise.resolve()
      await Promise.resolve()

      // store/audio 回退到 track2 并继续播放;不提示"继续播放",
      // 真实错误通过 preloadMessage 提示给用户
      expect(store.currentTrackId).toBe('2')
      expect(store.isPlaying).toBe(true)
      expect(player.preloadMessage.value).not.toContain('继续播放')
      expect(player.preloadMessage.value).toContain('音频')
    } finally {
      HTMLAudioElement.prototype.play = originalPlay
    }
  })
})
