import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import { preloadCover, usePreloadPool } from '../composables/usePreloadPool'
import { usePlayerStore } from '../stores/player'
import type { PlayerSettings, Track } from '../types/music'

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
  backgroundBlur: 90,
  backgroundSaturation: 1.15,
  beatBrightness: 0.28,
  lyricFontSize: 20,
  lyricAnimation: true,
  lyricTranslation: true,
  progressLyricPreview: false,
  skipOnError: true,
  autoHideChrome: true,
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

function createAudioMock(): HTMLAudioElement {
  return new Audio()
}

function resolveDeferred(callback: (() => void) | null) {
  expect(callback).toBeTypeOf('function')
  callback?.()
}

function mountPool(settings: Ref<PlayerSettings>) {
  const store = usePlayerStore()
  store.setTracks(tracks)
  const players = [createAudioMock(), createAudioMock(), createAudioMock()]

  const Harness = defineComponent({
    setup() {
      const pool = usePreloadPool({
        players,
        store,
        settings,
        getActiveAudio: () => players[0]!,
        transitionInProgress: () => false,
      })
      return { pool }
    },
    render() {
      return h('div', { id: 'harness' })
    },
  })

  const wrapper = mount(Harness)
  const pool = wrapper.vm.pool as ReturnType<typeof usePreloadPool>
  return { wrapper, pool, store, players }
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
    const { pool, store } = mountPool(settings)
    store.selectTrack(tracks[0]!, tracks)

    const ready = pool.loadSlot('next', tracks[1]!)
    pool.preloadSlots.next.audio.dispatchEvent(new Event('error'))

    await expect(ready).resolves.toBe(false)
    expect(pool.failedTrackIds.has('2')).toBe(true)
    expect(pool.preloadMessage.value).toBe('预加载歌曲暂时无法播放，当前播放不受影响')
    expect(pool.preloadMessage.value).not.toContain('已跳过')
    expect(store.currentTrackId).toBe('1')
  })

  it('skips a failed preloaded next track when predicting a manual next action', async () => {
    const settings = ref({ ...defaultSettings })
    const { pool, store } = mountPool(settings)
    store.settings.playMode = 'loop'
    store.selectTrack(tracks[0]!, tracks)

    const ready = pool.loadSlot('next', tracks[1]!)
    pool.preloadSlots.next.audio.dispatchEvent(new Event('error'))
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
})
