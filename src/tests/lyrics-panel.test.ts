import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import LyricsPanel from '../components/LyricsPanel.vue'
import { loadTrackLyrics } from '../services/lyrics'
import { usePlayerStore } from '../stores/player'
import { supportsWebAnimations } from '../utils/browser'
import type { LyricLine, LyricsSnapshot, Track } from '../types/music'

vi.mock('../services/lyrics', () => ({
  hasCachedTrackLyrics: vi.fn(() => false),
  loadTrackLyrics: vi.fn(),
  transferTrackLyricsProvider: vi.fn(),
}))

vi.mock('../utils/browser', () => ({
  supportsWebAnimations: vi.fn(() => false),
}))

const mockedLoadTrackLyrics = vi.mocked(loadTrackLyrics)
const mockedSupportsWebAnimations = vi.mocked(supportsWebAnimations)

const lyricsLines: LyricLine[] = [
  { time: 0, text: 'Line zero' },
  { time: 5, text: 'Line one' },
  { time: 10, text: 'Line two', translation: 'Translation two' },
  { time: 15, text: 'Line three' },
  { time: 20, text: 'Line four' },
]

const track: Track = {
  id: 'track-1',
  title: 'Test Track',
  artist: 'Meliora',
  audioUrl: '/music/test.mp3',
  kind: 'local',
}

type ResizeObserverCallback = ConstructorParameters<typeof ResizeObserver>[0]

class MockResizeObserver {
  static instances: MockResizeObserver[] = []

  readonly callback: ResizeObserverCallback
  readonly observed: Element[] = []

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    MockResizeObserver.instances.push(this)
  }

  observe(target: Element) {
    this.observed.push(target)
  }

  unobserve(target: Element) {
    const index = this.observed.indexOf(target)
    if (index >= 0) this.observed.splice(index, 1)
  }

  disconnect() {
    this.observed.length = 0
  }

  emit(target = this.observed[0] ?? document.body) {
    this.callback(
      [
        {
          target,
          contentRect: target.getBoundingClientRect(),
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    )
  }
}

let rafCallbacks: FrameRequestCallback[] = []
const mountedWrappers: VueWrapper[] = []

function installAnimationFrameMock() {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    rafCallbacks.push(callback)
    return rafCallbacks.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
    rafCallbacks[handle - 1] = () => {}
  })
}

function flushAnimationFrames() {
  for (let frame = 0; frame < 5 && rafCallbacks.length > 0; frame += 1) {
    const callbacks = rafCallbacks
    rafCallbacks = []
    callbacks.forEach((callback) => callback(performance.now()))
  }
}

function clearAnimationFrames() {
  rafCallbacks = []
}

function installElementAnimateMock() {
  const animation = {
    cancel: vi.fn(),
    oncancel: null,
    onfinish: null,
  } as unknown as Animation

  const animate = vi.fn(() => animation)
  Object.defineProperty(HTMLElement.prototype, 'animate', {
    configurable: true,
    value: animate,
  })
  return animate
}

async function flushRealignFrame() {
  await nextTick()
  await Promise.resolve()
  flushAnimationFrames()
  await nextTick()
}

async function flushVueUpdates() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function makeDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function defineReadonlyNumber(target: object, key: string, value: number) {
  Object.defineProperty(target, key, {
    configurable: true,
    get: () => value,
  })
}

function setPanelLayout(wrapper: VueWrapper, offsets: number[] = [0, 90, 180, 270, 360]) {
  const scroller = wrapper.get<HTMLElement>('.lyrics-scroll').element
  defineReadonlyNumber(scroller, 'clientHeight', 200)
  defineReadonlyNumber(scroller, 'scrollHeight', 620)

  wrapper.findAll<HTMLButtonElement>('.lyric-line').forEach((line, index) => {
    defineReadonlyNumber(line.element, 'offsetTop', offsets[index] ?? index * 90)
    defineReadonlyNumber(line.element, 'clientHeight', 40)
    line.element.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: offsets[index] ?? index * 90,
      top: offsets[index] ?? index * 90,
      left: 0,
      right: 320,
      bottom: (offsets[index] ?? index * 90) + 40,
      width: 320,
      height: 40,
      toJSON: () => ({}),
    }))
  })

  return scroller
}

async function mountLyricsPanel(options: { currentTime?: number; active?: boolean } = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = usePlayerStore()
  store.setTracks([track])
  store.currentTrackId = track.id
  store.currentTime = options.currentTime ?? 0
  store.settings.lyricAnimation = true
  store.settings.lyricFontSize = 20

  const wrapper = mount(LyricsPanel, {
    attachTo: document.body,
    props: {
      active: options.active ?? true,
    },
    global: {
      plugins: [pinia],
      stubs: {
        Transition: true,
      },
    },
  })
  mountedWrappers.push(wrapper)

  return { wrapper, store }
}

async function resolveDeferredLyrics(
  wrapper: VueWrapper,
  deferred: ReturnType<typeof makeDeferred<LyricLine[]>>,
) {
  deferred.resolve(lyricsLines)
  await flushVueUpdates()
  setPanelLayout(wrapper)
  await nextTick()
}

async function moveTo(store: ReturnType<typeof usePlayerStore>, wrapper: VueWrapper, time: number) {
  setPanelLayout(wrapper)
  store.currentTime = time
  await flushVueUpdates()
  setPanelLayout(wrapper)
  await flushRealignFrame()
}

describe('LyricsPanel scrolling alignment', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockedLoadTrackLyrics.mockReset()
    mockedLoadTrackLyrics.mockResolvedValue(lyricsLines)
    rafCallbacks = []
    installAnimationFrameMock()
    MockResizeObserver.instances = []
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    mountedWrappers.splice(0).forEach((wrapper) => wrapper.unmount())
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('selects and scrolls to currentTime immediately after lyrics finish loading', async () => {
    const deferred = makeDeferred<LyricLine[]>()
    mockedLoadTrackLyrics.mockReturnValueOnce(deferred.promise)
    const { wrapper } = await mountLyricsPanel({ currentTime: 12 })

    await resolveDeferredLyrics(wrapper, deferred)
    flushAnimationFrames()
    await nextTick()

    expect(wrapper.findAll('.lyric-line')[2]?.classes()).toContain('active')
    expect(wrapper.get<HTMLElement>('.lyrics-scroll').element.scrollTop).toBe(100)
  })

  it('scrolls when currentTime moves to another lyric line', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 16)

    expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
    expect(wrapper.get<HTMLElement>('.lyrics-scroll').element.scrollTop).toBe(190)
  })

  it('realigns the same active line when lyricFontSize changes', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)
    await moveTo(store, wrapper, 10)
    const scroller = wrapper.get<HTMLElement>('.lyrics-scroll').element
    expect(scroller.scrollTop).toBe(100)
    clearAnimationFrames()

    store.settings.lyricFontSize = 28
    await flushVueUpdates()
    setPanelLayout(wrapper, [0, 120, 260, 390, 520])
    await flushRealignFrame()

    expect(wrapper.findAll('.lyric-line')[2]?.classes()).toContain('active')
    expect(scroller.scrollTop).toBe(180)
  })

  it('hides lyric translations from the panel and snapshot when disabled', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)
    await moveTo(store, wrapper, 10)

    expect(wrapper.find('.lyric-translation').text()).toBe('Translation two')
    const snapshotWithTranslation = wrapper.emitted('snapshot')?.at(-1)?.[0] as
      | LyricsSnapshot
      | undefined
    expect(snapshotWithTranslation?.lines.find((line) => line.text === 'Line two')).toMatchObject({
      translation: 'Translation two',
    })

    store.settings.lyricTranslation = false
    await flushVueUpdates()

    expect(wrapper.find('.lyric-translation').exists()).toBe(false)
    const snapshotWithoutTranslation = wrapper.emitted('snapshot')?.at(-1)?.[0] as
      | LyricsSnapshot
      | undefined
    expect(
      snapshotWithoutTranslation?.lines.find((line) => line.text === 'Line two'),
    ).not.toHaveProperty('translation')
  })

  it('reloads lyrics when the active track object is preserved but its store version changes', async () => {
    const { store } = await mountLyricsPanel()
    await flushVueUpdates()
    expect(mockedLoadTrackLyrics).toHaveBeenCalledTimes(1)

    mockedLoadTrackLyrics.mockResolvedValueOnce([{ time: 0, text: 'Reloaded line' }])
    store.setTracks([{ ...track, title: 'Test Track Reloaded' }])
    await flushVueUpdates()

    expect(mockedLoadTrackLyrics).toHaveBeenCalledTimes(2)
  })

  it('realigns the same active line after ResizeObserver and window resize notifications', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)
    await moveTo(store, wrapper, 10)
    const scroller = wrapper.get<HTMLElement>('.lyrics-scroll').element
    expect(scroller.scrollTop).toBe(100)
    clearAnimationFrames()

    setPanelLayout(wrapper, [0, 110, 240, 370, 500])
    expect(MockResizeObserver.instances.length).toBeGreaterThan(0)
    MockResizeObserver.instances[0]?.emit(scroller)
    await flushRealignFrame()
    expect(scroller.scrollTop).toBe(160)

    setPanelLayout(wrapper, [0, 130, 280, 430, 580])
    window.dispatchEvent(new Event('resize'))
    await flushRealignFrame()
    expect(scroller.scrollTop).toBe(200)
  })

  it('does not take over scrolling while the user is browsing and restores the latest target after 3200ms', async () => {
    mockedSupportsWebAnimations.mockReturnValueOnce(true)
    const animateSpy = installElementAnimateMock()
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    const scroller = setPanelLayout(wrapper)

    await wrapper.get('.lyrics-scroll').trigger('wheel')
    scroller.scrollTop = 45
    await wrapper.get('.lyrics-scroll').trigger('scroll')
    vi.advanceTimersByTime(1200)
    await wrapper.get('.lyrics-scroll').trigger('scroll')
    await moveTo(store, wrapper, 16)

    expect(wrapper.classes()).toContain('browsing')
    expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
    expect(scroller.scrollTop).toBe(45)

    vi.advanceTimersByTime(1999)
    expect(scroller.scrollTop).toBe(45)

    vi.advanceTimersByTime(1)
    await flushRealignFrame()
    expect(wrapper.classes()).not.toContain('browsing')
    expect(scroller.scrollTop).toBe(190)
    expect(animateSpy).toHaveBeenCalled()
  })

  it('restores the latest target when active changes from false to true', async () => {
    const { wrapper, store } = await mountLyricsPanel({ active: false })
    await flushVueUpdates()
    const scroller = setPanelLayout(wrapper)

    await moveTo(store, wrapper, 16)
    clearAnimationFrames()
    expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
    expect(scroller.scrollTop).toBe(0)

    await wrapper.setProps({ active: true })
    await flushRealignFrame()

    expect(scroller.scrollTop).toBe(190)
  })
})
