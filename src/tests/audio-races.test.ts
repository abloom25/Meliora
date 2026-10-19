import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useAudioPlayer } from '../composables/useAudioPlayer'
import { usePlayerStore } from '../stores/player'
import { createWebAudioBackend } from '../platform/web/audio-backend'
import { createAudioGain } from '../platform/web/audio-gain'
import type { Track } from '../core/types'

const startBeatAnalysisMock = vi.hoisted(() => vi.fn())

vi.mock('../platform/web/useBeatAnalyser', () => ({
  useBeatAnalyser: () => ({
    beatLevel: { value: 0 },
    spectrumLevels: { value: [] },
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
  }),
}))

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

const tracks: Track[] = ['a', 'b', 'c', 'd'].map((id) => ({
  id,
  title: id,
  artist: 'Test',
  audioUrl: `/${id}.mp3`,
  kind: 'local',
}))
let audios: HTMLAudioElement[]
let cleanup: () => void

function setup() {
  const store = usePlayerStore()
  store.setTracks(tracks)
  store.settings.preloadNextTrack = false
  store.settings.smoothTrackChange = false
  store.settings.playMode = 'loop'
  store.selectTrack(tracks[0]!, tracks)
  let player!: ReturnType<typeof useAudioPlayer>
  const wrapper = mount(
    defineComponent({
      setup() {
        player = useAudioPlayer()
        return () => h('div')
      },
    }),
  )
  cleanup = () => {
    wrapper.unmount()
    store.$dispose()
  }
  return { store, player, wrapper }
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
  audios = []
  cleanup = () => {}
  startBeatAnalysisMock.mockClear()
  vi.stubGlobal(
    'Audio',
    vi.fn(function () {
      const element = document.createElement('audio')
      audios.push(element)
      return element
    }),
  )
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('playback races', () => {
  it('does not restore playing when a pending play resolves after pause', async () => {
    const { player, store } = setup()
    const pending = deferred()
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(pending.promise)
    const playing = player.play()
    player.pause()
    pending.resolve()
    await playing
    expect(store.isPlaying).toBe(false)
    expect(startBeatAnalysisMock).not.toHaveBeenCalled()
  })

  it('does not analyse a selected track until its play promise actually succeeds', async () => {
    const { player, store } = setup()
    const pending = deferred()
    vi.mocked(HTMLMediaElement.prototype.play).mockImplementationOnce(function (
      this: HTMLMediaElement,
    ) {
      this.dispatchEvent(new Event('play'))
      return pending.promise
    })
    await player.selectAndPlay(tracks[1]!, tracks)
    await nextTick()
    expect(store.currentTrackId).toBe('b')
    expect(startBeatAnalysisMock).not.toHaveBeenCalled()
    pending.resolve()
    await Promise.resolve()
    await nextTick()
    expect(startBeatAnalysisMock).toHaveBeenCalledTimes(1)
  })

  it('ignores an old play rejection after selecting a different track', async () => {
    const { player, store } = setup()
    const pending = deferred()
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(pending.promise)
    const old = player.play()
    await player.selectAndPlay(tracks[1]!, tracks)
    pending.reject(new DOMException('old source failed', 'NotSupportedError'))
    await old
    expect(store.currentTrackId).toBe('b')
    expect(store.isPlaying).toBe(true)
    expect(store.errorMessage).toBe('')
  })

  it('allows manual selection to supersede an automatic switch waiting for data', async () => {
    const { player, store } = setup()
    await player.play()
    const automatic = player.next(false)
    await player.selectAndPlay(tracks[2]!, tracks)
    audios.forEach((audio) => audio.dispatchEvent(new Event('canplay')))
    await automatic
    expect(store.currentTrackId).toBe('c')
    expect(store.isPlaying).toBe(true)
  })

  it('does not advance when pause interrupts an automatic switch waiting for data', async () => {
    const { player, store } = setup()
    await player.play()
    const automatic = player.next(false)
    player.pause()
    audios.forEach((audio) => audio.dispatchEvent(new Event('canplay')))
    await automatic
    expect(store.currentTrackId).toBe('a')
    expect(store.isPlaying).toBe(false)
  })

  it('does not let an old skip timer advance a newly selected track', async () => {
    const { player, store } = setup()
    await player.play()
    Object.defineProperty(audios[0]!, 'error', { configurable: true, value: { code: 2 } })
    audios[0]!.dispatchEvent(new Event('error'))
    await player.selectAndPlay(tracks[2]!, tracks)
    await vi.advanceTimersByTimeAsync(100)
    expect(store.currentTrackId).toBe('c')
  })

  it('keeps a promoted preload channel free from its old timeout', async () => {
    const { player, store } = setup()
    store.settings.preloadNextTrack = true
    await player.play()
    await vi.advanceTimersByTimeAsync(0)
    await player.next(true)
    await vi.advanceTimersByTimeAsync(10000)
    expect(store.currentTrackId).toBe('b')
    expect(audios.some((audio) => audio.getAttribute('src') === '/b.mp3')).toBe(true)
  })

  it('keeps all three channels distinct when selecting the previous preload via next direction', async () => {
    const { player, store } = setup()
    store.settings.preloadNextTrack = true
    await player.play()
    await vi.advanceTimersByTimeAsync(0)
    // d occupies the previous slot, but a list selection uses direction=next.
    await player.selectAndPlay(tracks[3]!, tracks)
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.currentTrackId).toBe('d')
    expect(audios.filter((audio) => audio.getAttribute('src') === '/d.mp3')).toHaveLength(1)
  })
  it('settles auto-advance when preloading is disabled while waiting', async () => {
    const { player, store } = setup()
    store.settings.preloadNextTrack = true
    await player.play()
    const settled = vi.fn()
    void player.next(false).then(settled)
    store.settings.preloadNextTrack = false
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toHaveBeenCalledOnce()
    expect(store.currentTrackId).toBe('a')
    await player.selectAndPlay(tracks[2]!, tracks)
    expect(store.currentTrackId).toBe('c')
  })

  it('does not apply an old automatic target after the queue changes', async () => {
    const { player, store } = setup()
    await player.play()
    const settled = vi.fn()
    void player.next(false).then(settled)
    store.selectTrack(tracks[2]!, [tracks[2]!, tracks[3]!])
    await nextTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toHaveBeenCalledOnce()
    expect(store.currentTrackId).toBe('c')
    expect(audios[0]!.getAttribute('src')).toBe('/c.mp3')
  })

  it('keeps outgoing source protected until a pending switch has finished', async () => {
    const { player, store } = setup()
    store.settings.preloadNextTrack = true
    await player.play()
    const pending = deferred()
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(pending.promise)
    await player.selectAndPlay(tracks[1]!, [tracks[1]!, tracks[2]!])
    await vi.advanceTimersByTimeAsync(0)
    expect(audios[0]!.getAttribute('src')).toBe('/a.mp3')
    pending.reject(new DOMException('unsupported', 'NotSupportedError'))
    await vi.advanceTimersByTimeAsync(100)
    expect(store.currentTrackId).toBe('c')
    const playing = vi
      .mocked(HTMLMediaElement.prototype.play)
      .mock.contexts.at(-1) as HTMLAudioElement
    expect(playing.getAttribute('src')).toBe('/c.mp3')
    expect(store.isPlaying).toBe(true)
  })

  it('ignores a switch play resolution after pause or unmount', async () => {
    const { player, store, wrapper } = setup()
    const pending = deferred()
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(pending.promise)
    await player.selectAndPlay(tracks[1]!, tracks)
    player.pause()
    wrapper.unmount()
    pending.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(store.isPlaying).toBe(false)
    expect(store.errorMessage).toBe('')
  })
  it('discards a cached outgoing track excluded by the new queue', async () => {
    const { player, store } = setup()
    store.settings.preloadNextTrack = true
    await player.play()
    await vi.advanceTimersByTimeAsync(0)
    await player.selectAndPlay(tracks[3]!, [tracks[3]!, tracks[2]!])
    await vi.advanceTimersByTimeAsync(0)
    await player.next(true)
    expect(store.currentTrackId).toBe('c')
    const playing = vi
      .mocked(HTMLMediaElement.prototype.play)
      .mock.contexts.at(-1) as HTMLAudioElement
    expect(playing.getAttribute('src')).toBe('/c.mp3')
  })

  it('processes a media error and its play rejection only once', async () => {
    const { player, store } = setup()
    await player.play()
    const pending = deferred()
    vi.mocked(HTMLMediaElement.prototype.play).mockReturnValueOnce(pending.promise)
    await player.selectAndPlay(tracks[1]!, tracks)
    const incoming = audios.find((audio) => audio.getAttribute('src') === '/b.mp3')!
    Object.defineProperty(incoming, 'error', { configurable: true, value: { code: 4 } })
    incoming.dispatchEvent(new Event('error'))
    pending.reject(new DOMException('unsupported', 'NotSupportedError'))
    await vi.advanceTimersByTimeAsync(100)
    audios.forEach((audio) => audio.dispatchEvent(new Event('canplay')))
    await vi.advanceTimersByTimeAsync(100)
    expect(store.currentTrackId).toBe('c')
    expect(store.isPlaying).toBe(true)
  })
  it('leaves a CORS-rebuilt channel audible after startup aborts its original fade', async () => {
    const { player, store } = setup()
    store.settings.smoothTrackChange = true
    await player.play()
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
      new DOMException('replaced element', 'AbortError'),
    )
    await player.selectAndPlay(tracks[1]!, tracks)
    await nextTick()
    const incoming = audios.find((audio) => audio.getAttribute('src') === '/b.mp3')!
    incoming.dispatchEvent(new Event('play'))
    expect(incoming.volume).toBe(store.settings.volume)
    expect(store.isPlaying).toBe(true)
    expect(store.errorMessage).toBe('')
  })

  it('cancels automatic advancement when seeking during preload', async () => {
    const { player, store } = setup()
    await player.play()
    const automatic = player.next(false)
    player.seek(12)
    await automatic
    expect(store.currentTrackId).toBe('a')
    expect(store.currentTime).toBe(12)
  })
})

describe('gain animation ownership', () => {
  it('never applies the final gain of a cancelled fade', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const backend = createWebAudioBackend({ backgroundSafe: false })
    const channel = backend.active()
    const gain = createAudioGain()
    const old = gain.fadePlayer(channel, 1, 0, 500)
    gain.cancelGainAnimation(channel)
    channel.setGain(0.7)
    await vi.advanceTimersByTimeAsync(600)
    await old
    expect(channel.gain()).toBe(0.7)
    gain.clearGainAnimationFrames()
    backend.dispose()
  })

  it('settles cancelled animation promises when disposing frames', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const backend = createWebAudioBackend({ backgroundSafe: false })
    const gain = createAudioGain()
    const settled = vi.fn()
    void gain.fadePlayer(backend.active(), 1, 0, 500).then(settled)
    gain.clearGainAnimationFrames()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toHaveBeenCalledOnce()
    backend.dispose()
  })
})
