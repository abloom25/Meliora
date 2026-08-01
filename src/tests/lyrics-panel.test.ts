import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import LyricsPanel from '../components/LyricsPanel.vue'
import { hasCachedTrackLyrics, hasTrackLyricsSource, loadTrackLyrics } from '../services/lyrics'
import { usePlayerStore } from '../stores/player'
import { supportsWebAnimations } from '../utils/browser'
import type { LyricLine, LyricsSnapshot, Track } from '../types/music'

vi.mock('../services/lyrics', () => ({
  hasCachedTrackLyrics: vi.fn(() => false),
  hasTrackLyricsSource: vi.fn(() => true),
  loadTrackLyrics: vi.fn(),
  transferTrackLyricsProvider: vi.fn(),
}))

vi.mock('../utils/browser', () => ({
  supportsWebAnimations: vi.fn(() => false),
}))

const mockedLoadTrackLyrics = vi.mocked(loadTrackLyrics)
const mockedHasCachedTrackLyrics = vi.mocked(hasCachedTrackLyrics)
const mockedHasTrackLyricsSource = vi.mocked(hasTrackLyricsSource)
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

const secondTrack: Track = {
  id: 'track-2',
  title: 'Second Track',
  artist: 'Meliora',
  audioUrl: '/music/second.mp3',
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
    // rect 随 scrollTop 变化,贴近真实浏览器行为(scrollToIndex 会二次测量视觉位移)
    line.element.getBoundingClientRect = vi.fn(() => {
      const top = (offsets[index] ?? index * 90) - scroller.scrollTop
      return {
        x: 0,
        y: top,
        top,
        left: 0,
        right: 320,
        bottom: top + 40,
        width: 320,
        height: 40,
        toJSON: () => ({}),
      }
    })
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
    mockedHasCachedTrackLyrics.mockReset()
    mockedHasCachedTrackLyrics.mockReturnValue(false)
    mockedHasTrackLyricsSource.mockReset()
    mockedHasTrackLyricsSource.mockReturnValue(true)
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

  it('keeps lyrics available while an uncached provider is still loading', async () => {
    const deferred = makeDeferred<LyricLine[]>()
    mockedLoadTrackLyrics.mockReturnValueOnce(deferred.promise)
    const { wrapper } = await mountLyricsPanel({ currentTime: 12 })
    await flushVueUpdates()

    const availabilityEvents = wrapper.emitted('availability')?.map((event) => event[0])
    expect(availabilityEvents).toContain('loading')
    expect(availabilityEvents).not.toContain('unavailable')
    const loadingSnapshot = wrapper.emitted('snapshot')?.at(-1)?.[0] as LyricsSnapshot | undefined
    expect(loadingSnapshot?.status).toBe('loading')

    await resolveDeferredLyrics(wrapper, deferred)
    const readySnapshot = wrapper.emitted('snapshot')?.at(-1)?.[0] as LyricsSnapshot | undefined
    expect(readySnapshot?.status).toBe('ready')
  })

  it('renders untimed plain lyrics without forcing an active line', async () => {
    const plainLines: LyricLine[] = [
      { time: null, text: 'Plain line one' },
      { time: null, text: 'Plain line two' },
    ]
    mockedLoadTrackLyrics.mockResolvedValueOnce(plainLines)
    const { wrapper } = await mountLyricsPanel({ currentTime: 30 })
    await flushVueUpdates()

    expect(wrapper.findAll('.lyric-line')).toHaveLength(2)
    expect(wrapper.findAll('.lyric-line.active')).toHaveLength(0)
    expect(wrapper.findAll<HTMLButtonElement>('.lyric-line')[0]?.element.disabled).toBe(true)
    const snapshot = wrapper.emitted('snapshot')?.at(-1)?.[0] as LyricsSnapshot | undefined
    expect(snapshot).toMatchObject({
      status: 'ready',
      activeIndex: -1,
      lines: plainLines,
    })
  })

  it('marks lyrics as error instead of silently stuck on loading when loading times out', async () => {
    const timeoutError = new Error('Lyrics request timed out after 8000ms')
    timeoutError.name = 'LyricsTimeoutError'
    mockedLoadTrackLyrics.mockRejectedValueOnce(timeoutError)
    const { wrapper } = await mountLyricsPanel()
    await flushVueUpdates()

    const snapshot = wrapper.emitted('snapshot')?.at(-1)?.[0] as LyricsSnapshot | undefined
    expect(snapshot?.status).toBe('error')
    expect(wrapper.emitted('availability')?.at(-1)?.[0]).toBe('unavailable')
  })

  it('silently ignores abort errors caused by user-driven cancellation', async () => {
    mockedLoadTrackLyrics.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    const { wrapper } = await mountLyricsPanel()
    await flushVueUpdates()

    const statuses = wrapper
      .emitted('snapshot')
      ?.map((event) => (event[0] as LyricsSnapshot).status)
    expect(statuses).not.toContain('error')
  })

  it('marks lyrics unavailable without requesting when the track has no provider', async () => {
    mockedHasTrackLyricsSource.mockReturnValueOnce(false)
    const { wrapper } = await mountLyricsPanel()
    await flushVueUpdates()

    expect(mockedLoadTrackLyrics).not.toHaveBeenCalled()
    expect(wrapper.emitted('availability')?.at(-1)?.[0]).toBe('unavailable')
    const snapshot = wrapper.emitted('snapshot')?.at(-1)?.[0] as LyricsSnapshot | undefined
    expect(snapshot?.status).toBe('empty')
  })

  it('scrolls when currentTime moves to another lyric line', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 16)

    expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
    expect(wrapper.get<HTMLElement>('.lyrics-scroll').element.scrollTop).toBe(190)
  })

  it('does not schedule another realign while playback stays on the same lyric line', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)
    await moveTo(store, wrapper, 10)
    const scroller = wrapper.get<HTMLElement>('.lyrics-scroll').element
    expect(scroller.scrollTop).toBe(100)
    clearAnimationFrames()

    store.currentTime = 11
    await flushVueUpdates()

    expect(rafCallbacks).toHaveLength(0)
    expect(scroller.scrollTop).toBe(100)
  })

  it('uses the previous active line when animating a large seek jump', async () => {
    mockedSupportsWebAnimations.mockReturnValue(true)
    const animateSpy = installElementAnimateMock()
    const manyLines: LyricLine[] = Array.from({ length: 12 }, (_, index) => ({
      time: index * 5,
      text: `Line ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 10)
    clearAnimationFrames()
    animateSpy.mockClear()
    await moveTo(store, wrapper, 40)

    expect(wrapper.findAll('.lyric-line')[8]?.classes()).toContain('active')
    expect(animateSpy).toHaveBeenCalledTimes(12)
  })

  it('retargets the in-flight lyric animation when the next line arrives early', async () => {
    mockedSupportsWebAnimations.mockReturnValue(true)
    const animateSpy = installElementAnimateMock()
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 10)
    clearAnimationFrames()
    const inFlight = animateSpy.mock.results[0]?.value as Animation | undefined
    const cancelSpy = inFlight?.cancel ? vi.mocked(inFlight.cancel) : null
    animateSpy.mockClear()

    // 上一段动画(mock 中永不结束)仍在进行时切换到下一行:
    // 旧动画应立即被取消,新动画立即从当前视觉位置重定向,不再挂起等待
    store.currentTime = 16
    await flushVueUpdates()
    setPanelLayout(wrapper)
    await flushRealignFrame()

    expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
    expect(cancelSpy).toHaveBeenCalled()
    expect(animateSpy).toHaveBeenCalled()
  })

  it('keeps the lyric clock event-driven while lyrics are sparse', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)
    clearAnimationFrames()

    // 默认歌词行间隔 5s,远大于阈值:播放中也不应启动 rAF 外推
    store.isPlaying = true
    await flushVueUpdates()

    expect(rafCallbacks).toHaveLength(0)
  })

  it('compresses the realign animation when lyric lines arrive faster than the base duration', async () => {
    mockedSupportsWebAnimations.mockReturnValue(true)
    const animateSpy = installElementAnimateMock()
    const fastLines: LyricLine[] = Array.from({ length: 10 }, (_, index) => ({
      time: index * 0.8,
      text: `Fast ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(fastLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)
    clearAnimationFrames()
    animateSpy.mockClear()

    await moveTo(store, wrapper, 0.5)

    expect(wrapper.findAll('.lyric-line')[1]?.classes()).toContain('active')
    expect(animateSpy).toHaveBeenCalled()
    const firstCall = animateSpy.mock.calls[0] as unknown as [unknown, KeyframeAnimationOptions]
    expect(firstCall[1].duration).toBeLessThan(980)
    const style = wrapper.get('.lyrics-panel').attributes('style') ?? ''
    const tempo = Number(/--lyric-tempo:\s*([\d.]+)/.exec(style)?.[1])
    expect(tempo).toBeGreaterThan(0)
    expect(tempo).toBeLessThan(1)
  })

  it('snaps instantly instead of animating when the next lyric line is imminent', async () => {
    mockedSupportsWebAnimations.mockReturnValue(true)
    const animateSpy = installElementAnimateMock()
    const rapidLines: LyricLine[] = Array.from({ length: 10 }, (_, index) => ({
      time: index * 0.3,
      text: `Rapid ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(rapidLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    const scroller = setPanelLayout(wrapper)
    clearAnimationFrames()
    animateSpy.mockClear()

    await moveTo(store, wrapper, 0.35)

    expect(wrapper.findAll('.lyric-line')[2]?.classes()).toContain('active')
    expect(animateSpy).not.toHaveBeenCalled()
    expect(scroller.scrollTop).toBe(100)
    expect(wrapper.get('.lyrics-panel').attributes('style')).toContain('--lyric-tempo: 0')
  })

  it('extrapolates the lyric clock between timeupdate events while playing', async () => {
    const rapidLines: LyricLine[] = Array.from({ length: 20 }, (_, index) => ({
      time: index * 0.3,
      text: `Rapid ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(rapidLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    store.isPlaying = true
    await flushVueUpdates()
    expect(rafCallbacks.length).toBeGreaterThan(0)

    // timeupdate 事件间隔内(锚点仍停在 currentTime=0)推进 900ms 真实时间:
    // 外推时钟 0.9s + 0.42s 提前量 ≈ 1.32s,应落在第 4 行(1.2s)
    vi.advanceTimersByTime(900)
    flushAnimationFrames()
    await flushVueUpdates()

    expect(wrapper.findAll('.lyric-line')[4]?.classes()).toContain('active')
  })

  it('re-anchors the lyric clock when resuming after a long pause', async () => {
    const rapidLines: LyricLine[] = Array.from({ length: 400 }, (_, index) => ({
      time: index * 0.3,
      text: `Rapid ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(rapidLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    store.isPlaying = true
    await flushVueUpdates()
    store.isPlaying = false
    await flushVueUpdates()

    // 暂停 60s 后恢复:若锚点未重置,首个外推帧会把时钟推到 60s 之后(第 200 行)
    vi.advanceTimersByTime(60000)
    store.isPlaying = true
    await flushVueUpdates()
    flushAnimationFrames()
    await flushVueUpdates()

    // currentTime 仍为 0,高亮应停在开头附近而非跳到未来
    const activeIndex = wrapper
      .findAll('.lyric-line')
      .findIndex((line) => line.classes().includes('active'))
    expect(activeIndex).toBeGreaterThanOrEqual(0)
    expect(activeIndex).toBeLessThan(10)
  })

  it('clears transient lyric visuals and cancels row animations when the track changes', async () => {
    mockedSupportsWebAnimations.mockReturnValue(true)
    const animateSpy = installElementAnimateMock()
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    const scroller = setPanelLayout(wrapper)

    await moveTo(store, wrapper, 16)

    expect(wrapper.findAll('.lyric-line')).toHaveLength(lyricsLines.length)
    expect(animateSpy).toHaveBeenCalled()

    const animation = animateSpy.mock.results[0]?.value as Animation | undefined
    const cancelSpy = animation?.cancel ? vi.mocked(animation.cancel) : null

    const nextLyrics = makeDeferred<LyricLine[]>()
    mockedLoadTrackLyrics.mockReturnValueOnce(nextLyrics.promise)
    store.setTracks([track, secondTrack])
    store.selectTrack(secondTrack, store.tracks)
    await flushVueUpdates()

    expect(wrapper.findAll('.lyric-line')).toHaveLength(0)
    expect(scroller.scrollTop).toBe(0)
    expect(cancelSpy).toHaveBeenCalled()
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

    vi.advanceTimersByTime(3199)
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
