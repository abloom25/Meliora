import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import {
  preloadCover,
  usePreloadPool,
  type PreloadPoolOptions,
} from '../composables/usePreloadPool'
import { usePlayerStore } from '../stores/player'
import type { PlayerSettings, Track } from '../core/types'
import { createWebAudioBackend } from '../platform/web/audio-backend'
import type { AudioChannel } from '../core/audio/backend'
import { loadTrackLyrics, registerTrackLyrics } from '../services/lyrics'

const tracks: Track[] = [
  { id: '1', title: 'One', artist: 'A', audioUrl: '/1.mp3', kind: 'local' },
  { id: '2', title: 'Two', artist: 'B', audioUrl: '/2.mp3', kind: 'local' },
  { id: '3', title: 'Three', artist: 'C', audioUrl: '/3.mp3', kind: 'local' },
  { id: '4', title: 'Four', artist: 'D', audioUrl: '/4.mp3', kind: 'local' },
]

const defaultSettings: PlayerSettings = {
  volume: 0.7,
  playMode: 'loop',
  smoothTrackChange: true,
  preloadNextTrack: true,
  dynamicBackground: true,
  beatFlash: true,
  beatAnalysisMode: 'basic',
  backgroundBlur: 90,
  backgroundSaturation: 1.15,
  beatBrightness: 0.28,
  beatFlashRate: 1,
  beatVisualDelay: 0,
  lyricScale: 1,
  lyricAnimation: true,
  lyricSpring: 1,
  lyricTranslation: true,
  progressLyricPreview: false,
  skipOnError: true,
  autoHideChrome: true,
  debugPanelEnabled: false,
  equalizer: { enabled: false, preset: 'flat', bands: [0, 0, 0, 0, 0] },
  settingsVersion: 1,
}

class MockImage {
  static instances: MockImage[] = []
  static decodeHandlers = new Map<string, () => Promise<void>>()

  src = ''

  constructor() {
    MockImage.instances.push(this)
  }

  decode() {
    return MockImage.decodeHandlers.get(this.src)?.() ?? Promise.resolve()
  }
}

class MockImageWithoutDecode {
  static instances: MockImageWithoutDecode[] = []

  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  private currentSrc = ''

  constructor() {
    MockImageWithoutDecode.instances.push(this)
  }

  get src() {
    return this.currentSrc
  }

  set src(value: string) {
    this.currentSrc = value
    queueMicrotask(() => this.onload?.())
  }
}

// 预加载池现在只认播放通道句柄。这里用真实的 Web 后端,
// 触发"就绪/失败"时直接在通道背后的元素上派事件
function createBackend() {
  return createWebAudioBackend({ backgroundSafe: false, initialVolume: 1 })
}

function resolveDeferred(callback: (() => void) | null) {
  expect(callback).toBeTypeOf('function')
  callback?.()
}

function mountPool(
  settings: Ref<PlayerSettings>,
  options: Pick<PreloadPoolOptions, 'onTargetsChanged' | 'isChannelProtected'> = {},
) {
  const store = usePlayerStore()
  store.setTracks(tracks)
  const backend = createBackend()

  const Harness = defineComponent({
    setup() {
      const pool = usePreloadPool({
        backend,
        store,
        settings,
        transitionInProgress: () => false,
        ...options,
      })
      return { pool }
    },
    render() {
      return h('div', { id: 'harness' })
    },
  })

  const wrapper = mount(Harness)
  const pool = wrapper.vm.pool as ReturnType<typeof usePreloadPool>
  return { wrapper, pool, store, backend }
}

/** 让"下一首"那一路预加载失败:在通道背后的真实元素上派 error */
function failNextSlot(
  pool: ReturnType<typeof usePreloadPool>,
  backend: ReturnType<typeof createBackend>,
) {
  backend.elementOf(pool.preloadSlots.next.channel).dispatchEvent(new Event('error'))
}

describe('usePreloadPool', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    MockImage.instances = []
    MockImage.decodeHandlers.clear()
    vi.stubGlobal('Image', MockImage)
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('cancels obsolete neighbor lyrics after audio readiness without cancelling a foreground subscriber', async () => {
    const { pool, backend, wrapper } = mountPool(ref({ ...defaultSettings }))
    let signal: AbortSignal | undefined
    let finish!: () => void
    registerTrackLyrics(tracks[1]!, {
      cacheKey: 'preload-ready-lyrics-cancel',
      load: (requestSignal) =>
        new Promise((resolve, reject) => {
          signal = requestSignal
          finish = () => resolve([{ time: 0, text: 'Kept for current song' }])
          requestSignal?.addEventListener('abort', () => reject(requestSignal.reason), {
            once: true,
          })
        }),
    })
    const ready = pool.loadSlot('next', tracks[1]!)
    backend.elementOf(pool.preloadSlots.next.channel).dispatchEvent(new Event('canplay'))
    await ready
    const foreground = loadTrackLyrics(tracks[1]!)
    pool.clearSlot(pool.preloadSlots.next)
    expect(signal?.aborted).toBe(false)
    finish()
    await expect(foreground).resolves.toEqual([{ time: 0, text: 'Kept for current song' }])
    wrapper.unmount()
  })

  it('aborts the only lyric subscriber when a neighbor changes or the pool unmounts', async () => {
    const { pool, wrapper } = mountPool(ref({ ...defaultSettings }))
    const signals: AbortSignal[] = []
    for (const track of tracks.slice(1, 3))
      registerTrackLyrics(track, {
        cacheKey: `preload-orphan-${track.id}`,
        load: (signal) =>
          new Promise((_resolve, reject) => {
            signals.push(signal!)
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      })
    void pool.loadSlot('next', tracks[1]!)
    void pool.loadSlot('next', tracks[2]!)
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)
    wrapper.unmount()
    expect(signals[1]?.aborted).toBe(true)
  })

  it('transfers lyrics with rotated audio slots, cancels the obsolete reverse track and hands off the incoming request', async () => {
    const { pool, wrapper } = mountPool(ref({ ...defaultSettings }))
    const signals = new Map<string, AbortSignal>()
    const loads = vi.fn()
    for (const track of tracks.slice(0, 3))
      registerTrackLyrics(track, {
        cacheKey: `lyric-slot-rotation-${track.id}`,
        load: (signal) =>
          new Promise((_resolve, reject) => {
            loads(track.id)
            signals.set(track.id, signal!)
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          }),
      })
    void pool.loadSlot('previous', tracks[0]!)
    void pool.loadSlot('next', tracks[2]!)
    const oldForeground = new AbortController()
    const old = loadTrackLyrics(tracks[1]!, oldForeground.signal).catch(() => [])
    const incomingSlot = pool.preloadSlots.next
    const reverseSlot = pool.preloadSlots.previous
    // Same ownership change as replaceActiveWithSlot: C becomes current and B becomes previous.
    incomingSlot.track = null
    reverseSlot.track = tracks[1]!
    reverseSlot.ready = Promise.resolve(true)
    const releaseIncoming = pool.transferLyricsForPromotion(incomingSlot, reverseSlot)
    expect(signals.get('1')?.aborted).toBe(true)
    expect(signals.get('2')?.aborted).toBe(false)
    expect(signals.get('3')?.aborted).toBe(false)
    pool.clearSlot(incomingSlot)
    const foreground = new AbortController()
    const current = loadTrackLyrics(tracks[2]!, foreground.signal).catch(() => [])
    oldForeground.abort()
    releaseIncoming()
    expect(signals.get('2')?.aborted).toBe(false)
    expect(signals.get('3')?.aborted).toBe(false)
    expect(loads.mock.calls.filter(([id]) => id === '2')).toHaveLength(1)
    expect(loads.mock.calls.filter(([id]) => id === '3')).toHaveLength(1)
    foreground.abort()
    await Promise.all([old, current])
    expect(signals.get('3')?.aborted).toBe(true)
    wrapper.unmount()
    expect(signals.get('2')?.aborted).toBe(true)
  })

  it('publishes the actual loaded sources and refreshes their duration after readiness', async () => {
    const changed = vi.fn()
    const { pool, store, backend, wrapper } = mountPool(ref({ ...defaultSettings }), {
      onTargetsChanged: changed,
    })
    store.selectTrack(tracks[1]!, tracks)
    pool.preloadAdjacentTracks()
    expect(changed.mock.lastCall?.[0]).toEqual([
      { direction: 'next', source: '/3.mp3', title: 'Three' },
      { direction: 'previous', source: '/1.mp3', title: 'One' },
    ])
    const nextAudio = backend.elementOf(pool.preloadSlots.next.channel)
    Object.defineProperty(nextAudio, 'duration', { configurable: true, value: 180 })
    nextAudio.dispatchEvent(new Event('loadedmetadata'))
    expect(changed.mock.lastCall?.[0][0].durationSeconds).toBe(180)
    nextAudio.dispatchEvent(new Event('canplay'))
    await expect(pool.preloadSlots.next.ready).resolves.toBe(true)
    Object.defineProperty(nextAudio, 'duration', { configurable: true, value: 181.5 })
    nextAudio.dispatchEvent(new Event('durationchange'))
    expect(changed.mock.lastCall?.[0][0].durationSeconds).toBe(181.5)
    Object.defineProperty(nextAudio, 'duration', { configurable: true, value: Infinity })
    nextAudio.dispatchEvent(new Event('durationchange'))
    expect(changed.mock.lastCall?.[0][0]).not.toHaveProperty('durationSeconds')
    wrapper.unmount()
    expect(changed.mock.lastCall?.[0]).toEqual([])
  })

  it('keeps the already chosen shuffle target without drawing a second successor', () => {
    const changed = vi.fn()
    const { pool, store, wrapper } = mountPool(ref({ ...defaultSettings }), {
      onTargetsChanged: changed,
    })
    store.selectTrack(tracks[0]!, tracks)
    store.settings.playMode = 'shuffle'
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.45)
    pool.preloadAdjacentTracks()
    const selected = pool.preloadSlots.next.track!
    random.mockClear()
    random.mockReturnValue(0.99)
    pool.refreshTargets()
    expect(random).not.toHaveBeenCalled()
    expect(changed.mock.lastCall?.[0][0].source).toBe(selected.audioUrl)
    expect(pool.predictNextTrack(true)?.id).toBe(selected.id)
    wrapper.unmount()
  })

  it('publishes no separate next target during automatic single-song repeat', () => {
    const changed = vi.fn()
    const { pool, store, wrapper } = mountPool(ref({ ...defaultSettings }), {
      onTargetsChanged: changed,
    })
    store.selectTrack(tracks[1]!, tracks)
    store.settings.playMode = 'single'
    pool.preloadAdjacentTracks()
    expect(changed.mock.lastCall?.[0]).toEqual([
      { direction: 'previous', source: '/1.mp3', title: 'One' },
    ])
    expect(pool.preloadSlots.next.track).toBeNull()
    wrapper.unmount()
  })

  it('keeps a shared previous/next song loaded during repeated two-song queue refreshes', async () => {
    const changed = vi.fn()
    const { pool, store, backend, wrapper } = mountPool(ref({ ...defaultSettings }), {
      onTargetsChanged: changed,
    })
    store.selectTrack(tracks[0]!, tracks.slice(0, 2))
    pool.preloadAdjacentTracks()
    const nextAudio = backend.elementOf(pool.preloadSlots.next.channel)
    Object.defineProperty(nextAudio, 'duration', { configurable: true, value: 180 })
    nextAudio.dispatchEvent(new Event('canplay'))
    await expect(pool.preloadSlots.next.ready).resolves.toBe(true)
    changed.mockClear()
    const load = vi.spyOn(nextAudio, 'load')
    load.mockClear()
    pool.preloadAdjacentTracks()
    pool.preloadAdjacentTracks()
    expect(load.mock.contexts).not.toContain(nextAudio)
    expect(changed).not.toHaveBeenCalled()
    expect(pool.preloadSlots.next.track?.id).toBe('2')
    expect(pool.preloadSlots.previous.track).toBeNull()
    wrapper.unmount()
  })

  it('clears analysis targets synchronously when disabled and ignores stale metadata after clearing', () => {
    const settings = ref({ ...defaultSettings })
    const changed = vi.fn()
    const { pool, store, backend, wrapper } = mountPool(settings, { onTargetsChanged: changed })
    store.selectTrack(tracks[0]!, tracks)
    void pool.loadSlot('next', tracks[1]!)
    const audio = backend.elementOf(pool.preloadSlots.next.channel)
    settings.value.preloadNextTrack = false
    expect(changed.mock.lastCall?.[0]).toEqual([])
    pool.clearPreloads()
    settings.value.preloadNextTrack = true
    audio.dispatchEvent(new Event('loadedmetadata'))
    expect(changed.mock.lastCall?.[0]).toEqual([])
    wrapper.unmount()
  })

  it('removes a neighbor whose audio fails after canplay without affecting current playback', async () => {
    const changed = vi.fn()
    const { pool, store, backend, wrapper } = mountPool(ref({ ...defaultSettings }), {
      onTargetsChanged: changed,
    })
    store.selectTrack(tracks[0]!, tracks)
    const ready = pool.loadSlot('next', tracks[1]!)
    const audio = backend.elementOf(pool.preloadSlots.next.channel)
    audio.dispatchEvent(new Event('canplay'))
    await expect(ready).resolves.toBe(true)
    audio.dispatchEvent(new Event('error'))
    expect(changed.mock.lastCall?.[0]).toEqual([])
    expect(pool.isTrackFailed('2')).toBe(true)
    expect(store.currentTrackId).toBe('1')
    wrapper.unmount()
  })

  it('excludes the active and retiring channels and publishes the actual previous song after rotation', () => {
    const changed = vi.fn()
    let protectedChannel: AudioChannel | null = null
    const { pool, store, backend, wrapper } = mountPool(ref({ ...defaultSettings }), {
      onTargetsChanged: changed,
      isChannelProtected: (channel) => channel === protectedChannel,
    })
    store.selectTrack(tracks[0]!, tracks)
    const outgoing = backend.active()
    outgoing.load(tracks[0]!.audioUrl)
    void pool.loadSlot('next', tracks[1]!)
    const incoming = pool.preloadSlots.next.channel
    backend.setActive(incoming)
    pool.preloadSlots.previous.channel = outgoing
    pool.preloadSlots.previous.track = tracks[0]!
    protectedChannel = outgoing
    store.selectTrack(tracks[1]!, tracks)
    pool.refreshTargets()
    expect(changed.mock.lastCall?.[0]).toEqual([])
    protectedChannel = null
    pool.refreshTargets()
    expect(changed.mock.lastCall?.[0]).toEqual([
      { direction: 'previous', source: '/1.mp3', title: 'One' },
    ])
    wrapper.unmount()
  })

  it('reloads a changed source even when its track id has not changed', async () => {
    const changed = vi.fn()
    const { pool, store, backend, wrapper } = mountPool(ref({ ...defaultSettings }), {
      onTargetsChanged: changed,
    })
    store.selectTrack(tracks[0]!, tracks)
    const first = pool.loadSlot('next', tracks[1]!)
    const replaced = { ...tracks[1]!, audioUrl: '/2-new.mp3' }
    store.queue = [tracks[0]!, replaced]
    const second = pool.loadSlot('next', replaced)
    await expect(first).resolves.toBe(false)
    expect(second).not.toBe(first)
    expect(backend.elementOf(pool.preloadSlots.next.channel).src).toContain('/2-new.mp3')
    expect(changed.mock.lastCall?.[0]).toEqual([
      { direction: 'next', source: '/2-new.mp3', title: 'Two' },
    ])
    wrapper.unmount()
  })

  it('predictNextTrack matches store.peekNext in loop mode', () => {
    const settings = ref({ ...defaultSettings })
    const { pool, store } = mountPool(settings)
    store.selectTrack(tracks[1]!, tracks)

    expect(pool.predictNextTrack(false)?.id).toBe(store.peekNext(false)?.id)
    expect(pool.predictNextTrack(false)?.id).toBe('3')
  })

  it('predictNextTrack matches store.peekNext in sequence mode at end', () => {
    const settings = ref({ ...defaultSettings, playMode: 'sequence' as const })
    const { pool, store } = mountPool(settings)
    store.settings.playMode = 'sequence'
    store.selectTrack(tracks[3]!, tracks)

    expect(pool.predictNextTrack(false)).toBeNull()
    expect(store.peekNext(false)).toBeNull()
  })

  it('predictNextTrack matches store.peekNext in single mode (auto)', () => {
    const settings = ref({ ...defaultSettings, playMode: 'single' as const })
    const { pool, store } = mountPool(settings)
    store.settings.playMode = 'single'
    store.selectTrack(tracks[1]!, tracks)

    expect(pool.predictNextTrack(false)?.id).toBe('2')
    expect(store.peekNext(false)?.id).toBe('2')
  })

  it('predictNextTrack matches store.peekNext in shuffle mode', () => {
    const settings = ref({ ...defaultSettings, playMode: 'shuffle' as const })
    const { pool, store } = mountPool(settings)
    store.settings.playMode = 'shuffle'
    store.selectTrack(tracks[0]!, tracks)

    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const storeNext = store.peekNext(false)
    const poolNext = pool.predictNextTrack(false)
    expect(poolNext?.id).toBe(storeNext?.id)
  })

  it('predictPreviousTrack matches store.peekPrevious', () => {
    const settings = ref({ ...defaultSettings })
    const { pool, store } = mountPool(settings)
    store.selectTrack(tracks[0]!, tracks)

    expect(pool.predictPreviousTrack()?.id).toBe(store.peekPrevious()?.id)
    expect(pool.predictPreviousTrack()?.id).toBe('4')
  })

  it('returns null when queue is empty', () => {
    const settings = ref({ ...defaultSettings })
    const { pool, store } = mountPool(settings)
    store.queue = []
    store.currentTrackId = null

    expect(pool.predictNextTrack(false)).toBeNull()
    expect(pool.predictPreviousTrack()).toBeNull()
  })

  it('uses a neutral message when a preload fails without skipping the current track', async () => {
    const settings = ref({ ...defaultSettings })
    const { pool, store, backend } = mountPool(settings)
    store.selectTrack(tracks[0]!, tracks)

    const ready = pool.loadSlot('next', tracks[1]!)
    failNextSlot(pool, backend)

    await expect(ready).resolves.toBe(false)
    expect(pool.failureLog.isFailed('2')).toBe(true)
    expect(pool.preloadMessage.value).toBe('预加载歌曲暂时无法播放，当前播放不受影响')
    expect(pool.preloadMessage.value).not.toContain('已跳过')
    expect(store.currentTrackId).toBe('1')
  })

  it('skips a failed preloaded next track when predicting a manual next action', async () => {
    const settings = ref({ ...defaultSettings })
    const { pool, store, backend } = mountPool(settings)
    store.settings.playMode = 'loop'
    store.selectTrack(tracks[0]!, tracks)

    const ready = pool.loadSlot('next', tracks[1]!)
    failNextSlot(pool, backend)
    await expect(ready).resolves.toBe(false)

    expect(pool.predictNextTrack(true)?.id).toBe('3')
  })

  it('deduplicates concurrent cover preload requests for the same url', async () => {
    const coverUrl = '/covers/inflight-dedupe.jpg'
    let resolveDecode: (() => void) | null = null
    MockImage.decodeHandlers.set(
      coverUrl,
      () =>
        new Promise<void>((resolve) => {
          resolveDecode = resolve
        }),
    )

    const first = preloadCover(coverUrl)
    const second = preloadCover(coverUrl)

    expect(second).toBe(first)
    expect(MockImage.instances).toHaveLength(1)

    resolveDeferred(resolveDecode)
    await expect(first).resolves.toBeUndefined()
  })

  it('allows a failed cover preload to be retried later', async () => {
    const coverUrl = '/covers/retry-after-failure.jpg'
    const outcomes = [Promise.reject(new Error('decode failed')), Promise.resolve()]
    MockImage.decodeHandlers.set(coverUrl, () => outcomes.shift() ?? Promise.resolve())

    await expect(preloadCover(coverUrl)).resolves.toBeUndefined()
    await expect(preloadCover(coverUrl)).resolves.toBeUndefined()

    expect(MockImage.instances.map((image) => image.src)).toEqual([coverUrl, coverUrl])
  })

  it('falls back to image load events when decode is unavailable', async () => {
    const coverUrl = '/covers/load-event-fallback.jpg'
    MockImageWithoutDecode.instances = []
    vi.stubGlobal('Image', MockImageWithoutDecode)

    await expect(preloadCover(coverUrl)).resolves.toBeUndefined()

    expect(MockImageWithoutDecode.instances.map((image) => image.src)).toEqual([coverUrl])
  })

  it('keeps the successful cover preload cache bounded by evicting old entries', async () => {
    const coverUrls = Array.from({ length: 70 }, (_, index) => `/covers/bounded-${index}.jpg`)

    await Promise.all(coverUrls.map((url) => preloadCover(url)))
    await preloadCover(coverUrls[0]!)

    expect(MockImage.instances).toHaveLength(71)
    expect(MockImage.instances.at(-1)?.src).toBe(coverUrls[0])
  })

  it('clearFailedTrack removes the failure mark so the track can be predicted again', async () => {
    const settings = ref({ ...defaultSettings })
    const { pool, store, backend } = mountPool(settings)
    store.settings.playMode = 'loop'
    store.selectTrack(tracks[0]!, tracks)

    const ready = pool.loadSlot('next', tracks[1]!)
    failNextSlot(pool, backend)
    await expect(ready).resolves.toBe(false)
    expect(pool.predictNextTrack(true)?.id).toBe('3')

    pool.clearFailedTrack('2')
    expect(pool.predictNextTrack(true)?.id).toBe('2')
  })

  it('resetSlotChannels puts the two preload slots back on the spare channels', () => {
    const settings = ref({ ...defaultSettings })
    const { pool, backend } = mountPool(settings)
    const [main, spareA, spareB] = backend.channels()

    // 切过歌之后三路会轮转,出声的 channels[0] 可能落到某个槽手里
    pool.preloadSlots.previous.channel = main!
    pool.preloadSlots.previous.track = tracks[0]!
    pool.preloadSlots.next.channel = spareA!
    pool.preloadSlots.next.track = tracks[1]!

    pool.resetSlotChannels()

    // 还原成装配时的划分:出声的那一路重新只属于播放器
    expect(pool.preloadSlots.previous.channel).toBe(spareA)
    expect(pool.preloadSlots.next.channel).toBe(spareB)
    expect(pool.preloadSlots.previous.track).toBeNull()
    expect(pool.preloadSlots.next.track).toBeNull()
  })

  it('allows a failed track to be retried after the failure TTL expires', async () => {
    vi.useFakeTimers()
    try {
      const settings = ref({ ...defaultSettings })
      const { pool, store, backend } = mountPool(settings)
      store.settings.playMode = 'loop'
      store.selectTrack(tracks[0]!, tracks)

      const ready = pool.loadSlot('next', tracks[1]!)
      failNextSlot(pool, backend)
      await expect(ready).resolves.toBe(false)

      // 失败标记有效期内跳过该曲目
      expect(pool.predictNextTrack(true)?.id).toBe('3')

      // 超过 TTL（5 分钟）后放行重试一次
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000)
      expect(pool.predictNextTrack(true)?.id).toBe('2')
    } finally {
      vi.useRealTimers()
    }
  })
  it('settles a cancelled preload without blacklisting the track', async () => {
    const { pool, wrapper } = mountPool(ref({ ...defaultSettings }))
    const settled = vi.fn()
    void pool.loadSlot('next', tracks[1]!).then(settled)
    pool.clearPreloads()
    await Promise.resolve()
    expect(settled).toHaveBeenCalledWith(false)
    expect(pool.isTrackFailed(tracks[1]!.id)).toBe(false)
    wrapper.unmount()
  })

  it('settles waiters when the pool unmounts', async () => {
    const { pool, wrapper } = mountPool(ref({ ...defaultSettings }))
    const settled = vi.fn()
    void pool.loadSlot('next', tracks[1]!).then(settled)
    wrapper.unmount()
    await Promise.resolve()
    expect(settled).toHaveBeenCalledWith(false)
  })
})
