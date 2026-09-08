import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import LyricsPanel from '../components/LyricsPanel.vue'
import { hasCachedTrackLyrics, hasTrackLyricsSource, loadTrackLyrics } from '../services/lyrics'
import { usePlayerStore } from '../stores/player'
import type { LyricLine, LyricsSnapshot, Track } from '../types/music'

vi.mock('../services/lyrics', () => ({
  hasCachedTrackLyrics: vi.fn(() => false),
  hasTrackLyricsSource: vi.fn(() => true),
  loadTrackLyrics: vi.fn(),
  transferTrackLyricsProvider: vi.fn(),
}))

const mockedLoadTrackLyrics = vi.mocked(loadTrackLyrics)
const mockedHasCachedTrackLyrics = vi.mocked(hasCachedTrackLyrics)
const mockedHasTrackLyricsSource = vi.mocked(hasTrackLyricsSource)

const lyricsLines: LyricLine[] = [
  { time: 0, text: 'Line zero' },
  { time: 5, text: 'Line one' },
  { time: 10, text: 'Line two', translation: 'Translation two' },
  { time: 15, text: 'Line three' },
  { time: 20, text: 'Line four' },
]

const karaokeLines: LyricLine[] = [
  {
    time: 0,
    endTime: 2,
    text: 'ze ro',
    wordSource: 'native',
    words: [
      { time: 0, duration: 1, text: 'ze', trailingSpace: true },
      { time: 1, duration: 1, text: 'ro' },
    ],
  },
  {
    time: 5,
    endTime: 7,
    text: 'one',
    wordSource: 'native',
    words: [
      { time: 5, duration: 1, text: 'o' },
      { time: 6, duration: 1, text: 'ne' },
    ],
  },
  {
    time: 10,
    endTime: 12,
    text: 'two',
    wordSource: 'native',
    words: [
      { time: 10, duration: 1, text: 't' },
      { time: 11, duration: 1, text: 'wo' },
    ],
  },
  { time: 15, text: 'three' },
  { time: 20, text: 'four' },
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

// 弹簧位移每帧靠 performance.now() 的增量推进,必须真实推进时间才会收敛
function runSpringFrames(count: number, stepMs = 16) {
  for (let frame = 0; frame < count; frame += 1) {
    vi.advanceTimersByTime(stepMs)
    const callbacks = rafCallbacks
    rafCallbacks = []
    callbacks.forEach((callback) => callback(performance.now()))
  }
}

function lineTranslate(wrapper: VueWrapper, index: number): number {
  const value = wrapper.findAll<HTMLElement>('.lyric-line')[index]?.element.style.translate ?? ''
  return Number.parseFloat(value.replace(/^0\s+/, '')) || 0
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
      // 真实浏览器的 rect 包含 transform/translate 的影响,弹簧的"打断重定向"
      // 正是靠这一点测量到当前视觉位置,mock 必须一并还原
      const offset = Number.parseFloat(line.element.style.translate.split(' ')[1] ?? '0') || 0
      const top = (offsets[index] ?? index * 90) - scroller.scrollTop + offset
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

  it('moves scrollTop to the target immediately and settles the visual offset with a spring', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    const scroller = setPanelLayout(wrapper)

    await moveTo(store, wrapper, 10)

    // 滚动位置一次到位:动画只发生在"视觉补偿位移"上,滚动本身早已完成
    expect(scroller.scrollTop).toBe(100)
    expect(Math.abs(lineTranslate(wrapper, 2))).toBeGreaterThan(1)

    // 弹簧收敛后内联 translate 必须被清掉,让合成层可以回收
    runSpringFrames(60)
    expect(wrapper.findAll<HTMLElement>('.lyric-line')[2]?.element.style.translate).toBe('')
  })

  it('redirects an in-flight settle by adding the new delta instead of restarting', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    const scroller = setPanelLayout(wrapper)

    await moveTo(store, wrapper, 10)
    const initial = lineTranslate(wrapper, 2)
    runSpringFrames(4)
    const midway = lineTranslate(wrapper, 2)
    // 位移已经走掉一部分
    expect(Math.abs(midway)).toBeLessThan(Math.abs(initial))

    const before = scroller.scrollTop
    await moveTo(store, wrapper, 15)
    const delta = scroller.scrollTop - before

    // 打断重定向:新的偏移量 = 剩余偏移量 + 本次滚动增量。
    // 关键帧动画在这里会丢掉当前速度并从完整的新位移重新起步,弹簧不会
    expect(lineTranslate(wrapper, 2)).toBeCloseTo(midway + delta, 0)
  })

  it('runs a render loop while playing and stops it once paused', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)
    clearAnimationFrames()

    // 逐字扫光需要每帧的播放位置,播放期间必须有 rAF 循环
    store.isPlaying = true
    await flushVueUpdates()
    expect(rafCallbacks.length).toBeGreaterThan(0)

    store.isPlaying = false
    await flushVueUpdates()
    clearAnimationFrames()
    runSpringFrames(3)
    expect(rafCallbacks).toHaveLength(0)
  })

  it('compresses the highlight transition when lyric lines arrive faster than the base duration', async () => {
    const fastLines: LyricLine[] = Array.from({ length: 10 }, (_, index) => ({
      time: index * 0.4,
      text: `Fast ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(fastLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)
    clearAnimationFrames()

    await moveTo(store, wrapper, 0.45)

    expect(wrapper.findAll('.lyric-line')[1]?.classes()).toContain('active')
    // 位移不再需要压缩(弹簧可打断),但高亮/模糊的 CSS 过渡仍按行间隔压缩
    const style = wrapper.get('.lyrics-panel').attributes('style') ?? ''
    const tempo = Number(/--lyric-tempo:\s*([\d.]+)/.exec(style)?.[1])
    expect(tempo).toBeGreaterThan(0)
    expect(tempo).toBeLessThan(1)
  })

  it('keeps scrollTop exactly on the lead target through rapid line changes', async () => {
    const rapidLines: LyricLine[] = Array.from({ length: 10 }, (_, index) => ({
      time: index * 0.3,
      text: `Rapid ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(rapidLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    const scroller = setPanelLayout(wrapper)
    clearAnimationFrames()

    await moveTo(store, wrapper, 0.35)

    // 高亮严格对齐音频(0.35s → 第 1 行),滚动带 0.32s 提前量(→ 第 2 行)
    expect(wrapper.findAll('.lyric-line')[1]?.classes()).toContain('active')
    expect(wrapper.findAll('.lyric-line')[2]?.classes()).toContain('targeted')
    expect(scroller.scrollTop).toBe(100)
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
    // 外推时钟到 0.9s,高亮落在第 3 行(0.9s),滚动目标带提前量落在第 4 行(1.2s)
    vi.advanceTimersByTime(900)
    flushAnimationFrames()
    await flushVueUpdates()

    expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
    expect(wrapper.findAll('.lyric-line')[4]?.classes()).toContain('targeted')
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

  it('caps lyric clock extrapolation during playback stalls', async () => {
    const rapidLines: LyricLine[] = Array.from({ length: 100 }, (_, index) => ({
      time: index * 0.3,
      text: `Rapid ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(rapidLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    store.isPlaying = true
    await flushVueUpdates()

    // timeupdate 停发(缓冲 stall)推进 5s:外推封顶 1s,
    // 高亮最多走到 1.42s(第 4 行),不会一直超前于实际音频
    vi.advanceTimersByTime(5000)
    flushAnimationFrames()
    await flushVueUpdates()

    const activeIndex = wrapper
      .findAll('.lyric-line')
      .findIndex((line) => line.classes().includes('active'))
    expect(activeIndex).toBeGreaterThanOrEqual(0)
    expect(activeIndex).toBeLessThan(10)
  })

  it('clears transient lyric visuals and releases row offsets when the track changes', async () => {
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    const scroller = setPanelLayout(wrapper)

    await moveTo(store, wrapper, 16)

    expect(wrapper.findAll('.lyric-line')).toHaveLength(lyricsLines.length)
    const settling = wrapper.findAll<HTMLElement>('.lyric-line')[3]?.element
    expect(settling?.style.translate).not.toBe('')

    const nextLyrics = makeDeferred<LyricLine[]>()
    mockedLoadTrackLyrics.mockReturnValueOnce(nextLyrics.promise)
    store.setTracks([track, secondTrack])
    store.selectTrack(secondTrack, store.tracks)
    await flushVueUpdates()

    expect(wrapper.findAll('.lyric-line')).toHaveLength(0)
    expect(scroller.scrollTop).toBe(0)
    // 行节点被回收前必须先把内联 translate 清掉,不留残余位移
    expect(settling?.style.translate).toBe('')
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
    expect(Math.abs(lineTranslate(wrapper, 3))).toBeGreaterThan(1)
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

  it('renders one span per syllable and keeps a wrappable gap between words', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
    const { wrapper } = await mountLyricsPanel()
    await flushVueUpdates()

    const first = wrapper.findAll('.lyric-line')[0]!
    expect(first.classes()).toContain('karaoke')
    expect(first.findAll('.lyric-word').map((word) => word.text())).toEqual(['ze', 'ro'])
    // 行内块之间必须留一个真实的空白文本节点,否则英文长句无法换行
    expect(first.findAll('.lyric-gap')).toHaveLength(1)

    // 没有音节的行仍按整行渲染
    expect(wrapper.findAll('.lyric-line')[3]?.findAll('.lyric-word')).toHaveLength(0)
  })

  it('writes the syllable fill of the active line only', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 0.5)

    const active = wrapper.findAll<HTMLElement>('.lyric-line')[0]!
    const words = active.findAll<HTMLElement>('.lyric-word')
    expect(words[0]!.element.style.getPropertyValue('--lyric-word-fill')).toBe('0.500')
    expect(words[1]!.element.style.getPropertyValue('--lyric-word-fill')).toBe('0.000')

    // 其余行不写内联值,由 CSS 的初始值兜底为"已唱完"
    const idle = wrapper.findAll<HTMLElement>('.lyric-line')[1]!
    expect(
      idle
        .findAll<HTMLElement>('.lyric-word')[0]!
        .element.style.getPropertyValue('--lyric-word-fill'),
    ).toBe('')
  })

  it('stops the syllable scan when lyric animation is off and hands it back when re-enabled', async () => {
    // 扫光本身就是动画:每帧写入的是内联自定义属性,优先级高于任何 CSS 规则,
    // 关掉「歌词动画」必须在 JS 侧拦住,否则关了开关字还在一个个亮
    mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 0.5)
    const word = wrapper
      .findAll<HTMLElement>('.lyric-line')[0]!
      .findAll<HTMLElement>('.lyric-word')[0]!
    expect(word.element.style.getPropertyValue('--lyric-word-fill')).toBe('0.500')

    store.settings.lyricAnimation = false
    await flushVueUpdates()

    // 内联值被释放,整行回落到 CSS 的 --lyric-word-fill: 1,表现为整行高亮
    expect(word.element.style.getPropertyValue('--lyric-word-fill')).toBe('')
    expect(word.element.style.getPropertyValue('--lyric-word-edge')).toBe('')

    store.isPlaying = true
    await flushVueUpdates()
    vi.advanceTimersByTime(400)
    flushAnimationFrames()
    await flushVueUpdates()
    expect(word.element.style.getPropertyValue('--lyric-word-fill')).toBe('')

    store.settings.lyricAnimation = true
    await flushVueUpdates()
    expect(word.element.style.getPropertyValue('--lyric-word-fill')).not.toBe('')
  })

  it('keeps the syllable scan off for a line that becomes active while animation is disabled', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    store.settings.lyricAnimation = false
    await flushVueUpdates()
    await moveTo(store, wrapper, 5.5)

    const active = wrapper.findAll<HTMLElement>('.lyric-line')[1]!
    expect(active.classes()).toContain('active')
    for (const word of active.findAll<HTMLElement>('.lyric-word')) {
      expect(word.element.style.getPropertyValue('--lyric-word-fill')).toBe('')
    }
  })

  it('advances the syllable fill from the extrapolated clock between timeupdates', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    store.isPlaying = true
    await flushVueUpdates()
    const word = wrapper
      .findAll<HTMLElement>('.lyric-line')[0]!
      .findAll<HTMLElement>('.lyric-word')[0]!
    const before = Number(word.element.style.getPropertyValue('--lyric-word-fill'))

    // timeupdate 只有约 4Hz,扫光必须靠外推时钟推进而不是等下一个事件
    vi.advanceTimersByTime(400)
    flushAnimationFrames()
    await flushVueUpdates()

    expect(Number(word.element.style.getPropertyValue('--lyric-word-fill'))).toBeGreaterThan(before)
  })

  it('releases the syllable fill of the line that stops being active', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 0.5)
    const previous = wrapper
      .findAll<HTMLElement>('.lyric-line')[0]!
      .findAll<HTMLElement>('.lyric-word')[0]!
    expect(previous.element.style.getPropertyValue('--lyric-word-fill')).not.toBe('')

    await moveTo(store, wrapper, 5.5)

    expect(previous.element.style.getPropertyValue('--lyric-word-fill')).toBe('')
    const current = wrapper
      .findAll<HTMLElement>('.lyric-line')[1]!
      .findAll<HTMLElement>('.lyric-word')[0]!
    expect(current.element.style.getPropertyValue('--lyric-word-fill')).toBe('0.500')
  })

  it('lifts a word by its sing progress and never springs it back', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 1.5)

    const words = wrapper
      .findAll<HTMLElement>('.lyric-line')[0]!
      .findAll<HTMLElement>('.lyric-word')
    // 上浮完全由演唱进度推导(CSS 从 --lyric-word-fill 算),唱完保持抬起。
    // 之前用的是起音脉冲包络,每个词都会"上去再掉回来",那不是 Apple Music 的做法
    expect(words[0]!.element.style.getPropertyValue('--lyric-word-fill')).toBe('1.000')
    expect(words[0]!.element.style.getPropertyValue('--lyric-word-pop')).toBe('')
    expect(words[1]!.element.style.getPropertyValue('--lyric-word-pop')).toBe('')
  })

  it('lets lines behind the travel direction trail the ones in front', async () => {
    const manyLines: LyricLine[] = Array.from({ length: 12 }, (_, index) => ({
      time: index * 5,
      text: `Line ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    // 向下滚:索引更大的行在后方被拖着走,应当比前方等距的行更晚到位
    await moveTo(store, wrapper, 25)
    runSpringFrames(8)

    const leading = Math.abs(lineTranslate(wrapper, 0))
    const trailing = Math.abs(lineTranslate(wrapper, 10))

    expect(trailing).toBeGreaterThan(leading)
    // 差距要肉眼可见,否则整片歌词只是匀速平移,没有牵引感
    expect(trailing - leading).toBeGreaterThan(3)
  })

  it('keeps a background harmony line attached to the line it belongs to', async () => {
    // TTML 的 x-bg 有自己的时间轴,但它不是"另一行歌词":
    // 让它独立成为当前行会使高亮与滚动在主行和和声之间来回跳
    mockedLoadTrackLyrics.mockResolvedValueOnce([
      { time: 0, endTime: 4, text: 'main line' },
      { time: 2, endTime: 4, text: 'ooh', background: true },
      { time: 8, endTime: 12, text: 'next line' },
    ])
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 2.5)

    const rows = wrapper.findAll('.lyric-line')
    expect(rows[0]?.classes()).toContain('active')
    expect(rows[1]?.classes()).toContain('active')
    expect(rows[1]?.classes()).toContain('background')
    expect(rows[2]?.classes()).not.toContain('active')
  })

  it('starts each line one after another instead of moving them all at once', async () => {
    const manyLines: LyricLine[] = Array.from({ length: 12 }, (_, index) => ({
      time: index * 5,
      text: `Line ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 25)
    const initial = Math.abs(lineTranslate(wrapper, 11))

    // 起步后 48ms:靠前的行已经在走,靠后的行还被按在原地。
    // 所有行同时起步只是整片匀速平移,"被拽上去"的观感就来自这个时间差
    runSpringFrames(3)

    expect(Math.abs(lineTranslate(wrapper, 0))).toBeLessThan(initial * 0.9)
    expect(Math.abs(lineTranslate(wrapper, 11))).toBeCloseTo(initial, 1)
  })

  it('never re-holds a line that has already started moving', async () => {
    const manyLines: LyricLine[] = Array.from({ length: 12 }, (_, index) => ({
      time: index * 5,
      text: `Line ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 25)
    runSpringFrames(6)
    const moving = Math.abs(lineTranslate(wrapper, 0))
    expect(moving).toBeGreaterThan(0)

    // 下一行到来时,已经在动的行不能被重新排延迟按住,否则会卡在半空
    await moveTo(store, wrapper, 30)
    const beforeStep = Math.abs(lineTranslate(wrapper, 0))
    runSpringFrames(2)

    expect(Math.abs(lineTranslate(wrapper, 0))).not.toBe(beforeStep)
  })

  it('keeps unsung words a flat colour with no bright leading edge', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 0.5)

    const words = wrapper
      .findAll<HTMLElement>('.lyric-line')[0]!
      .findAll<HTMLElement>('.lyric-word')
    // 前沿柔化宽度必须随进度收敛到 0,否则渐变的头两个色标都落在 0%,
    // 未唱词的左边缘会被画出一段"亮→暗",看起来左边比右边亮
    expect(words[1]!.element.style.getPropertyValue('--lyric-word-fill')).toBe('0.000')
    expect(words[1]!.element.style.getPropertyValue('--lyric-word-edge')).toBe('0.000')
    // 正在推进的词才有柔化前沿
    expect(Number(words[0]!.element.style.getPropertyValue('--lyric-word-edge'))).toBeGreaterThan(0)
  })

  it('renders plain lyrics as whole lines with no karaoke spans', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce(lyricsLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 10)

    const active = wrapper.findAll('.lyric-line')[2]!
    expect(active.classes()).toContain('active')
    expect(active.classes()).not.toContain('karaoke')
    expect(active.findAll('.lyric-word')).toHaveLength(0)
    expect(active.text()).toContain('Line two')
  })

  it('collapses the stagger when the next line is already due', async () => {
    // 快段落(说唱、密集副歌):逐行延迟会让相邻行在起步瞬间拉开数十像素,
    // 而行距只有 20–40px,不按剩余时间压缩延迟就会叠在一起
    const fastLines: LyricLine[] = Array.from({ length: 12 }, (_, index) => ({
      time: index * 0.35,
      text: `Fast ${index}`,
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(fastLines)
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 1.4)
    const initial = Math.abs(lineTranslate(wrapper, 8))
    runSpringFrames(3)

    // 慢歌里这一行此刻还被按在原地,快段落里必须已经跟着走
    expect(Math.abs(lineTranslate(wrapper, 8))).toBeLessThan(initial * 0.95)
  })

  it('measures the line interval from the next sung line, not its harmony line', async () => {
    // 背景和声在数组里是独立一行,但它属于当前这一句。
    // 把它当成"下一句"会让行间隔被算成 0.2s,高亮过渡被压到最小值,
    // 表现就是有和声的句子唱完后突然变暗而不是自然淡出
    mockedLoadTrackLyrics.mockResolvedValueOnce([
      { time: 0, endTime: 4, text: 'main line' },
      { time: 0.2, endTime: 4, text: 'ooh', background: true },
      { time: 6, endTime: 10, text: 'next line' },
    ])
    const { wrapper, store } = await mountLyricsPanel()
    await flushVueUpdates()
    setPanelLayout(wrapper)

    await moveTo(store, wrapper, 0.5)

    const style = wrapper.get('.lyrics-panel').attributes('style') ?? ''
    const tempo = Number(/--lyric-tempo:\s*([\d.]+)/.exec(style)?.[1])
    // 到下一句还有 6s,远大于过渡基准时长,应当走完整节奏
    expect(tempo).toBe(1)
  })
})
