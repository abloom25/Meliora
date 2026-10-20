import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import LyricsPanel from '../components/LyricsPanel.vue'
import {
  getLyricsSource,
  hasCachedTrackLyrics,
  hasTrackLyricsSource,
  loadTrackLyrics,
} from '../services/lyrics'
import { usePlayerStore } from '../stores/player'
import type { LyricLine, LyricsSnapshot, Track } from '../core/types'
import type { LyricsDebugSnapshot } from '../core/diagnostics/lyrics-debug'
import type { LyricPlaybackState } from '../core/lyrics/render-schedule'

vi.mock('../services/lyrics', () => ({
  getLyricsSource: vi.fn(() => null),
  hasCachedTrackLyrics: vi.fn(() => false),
  hasTrackLyricsSource: vi.fn(() => true),
  loadTrackLyrics: vi.fn(),
  transferTrackLyricsProvider: vi.fn(),
}))

const mockedLoadTrackLyrics = vi.mocked(loadTrackLyrics)
const mockedGetLyricsSource = vi.mocked(getLyricsSource)
const mockedHasCachedTrackLyrics = vi.mocked(hasCachedTrackLyrics)
const mockedHasTrackLyricsSource = vi.mocked(hasTrackLyricsSource)

// 测试环境没有样式:行距落到面板的兜底值 28,行高由这里 mock 成 40,视口 600。
// 锚点在视口 42% 处 → 当前行的 translate 应当是 252 − 20 = 232
const VIEWPORT = 600
const LINE = 40
const GAP = 28
const PITCH = LINE + GAP
const ANCHOR_Y = VIEWPORT * 0.42 - LINE / 2

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

// Apple Music 规格 TTML 的两个特性:两个声部同时开唱(各自 <p ttm:agent>),
// 以及背景和声(x-bg)有自己的 begin/end,与父句重叠但不同时开始
const appleMusicLines: LyricLine[] = [
  {
    time: 0,
    endTime: 6,
    text: 'main voice',
    agent: 'primary',
    wordSource: 'native',
    words: [{ time: 0, duration: 6, text: 'main voice' }],
  },
  {
    time: 0,
    endTime: 6,
    text: 'other voice',
    agent: 'secondary',
    wordSource: 'native',
    words: [{ time: 0, duration: 6, text: 'other voice' }],
  },
  {
    time: 3,
    endTime: 5,
    text: 'ooh',
    background: true,
    wordSource: 'native',
    words: [{ time: 3, duration: 2, text: 'ooh' }],
  },
  { time: 8, endTime: 10, text: 'next line' },
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

function lineY(wrapper: VueWrapper, index: number): number {
  const row = wrapper.find<HTMLElement>(`[data-lyric-index="${index}"]`)
  const value = row.exists() ? row.element.style.translate : ''
  return Number.parseFloat(value.replace(/^0\s+/, '')) || 0
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

/** 给视口与各行 mock 尺寸,然后让面板重新测量(走 resize 路径,与真实浏览器一致) */
async function layoutPanel(
  wrapper: VueWrapper,
  options: { lineHeight?: number; viewportHeight?: number } = {},
) {
  const viewport = wrapper.get<HTMLElement>('.lyrics-viewport').element
  defineReadonlyNumber(viewport, 'clientHeight', options.viewportHeight ?? VIEWPORT)
  wrapper.findAll<HTMLButtonElement>('.lyric-line').forEach((line) => {
    defineReadonlyNumber(line.element, 'offsetHeight', options.lineHeight ?? LINE)
  })
  window.dispatchEvent(new Event('resize'))
  flushAnimationFrames()
  await nextTick()
  return viewport
}

interface PanelOptions {
  currentTime?: number
  active?: boolean
  getLyricsPlaybackState?: () => LyricPlaybackState
  subscribeLyricsPlayback?: (listener: () => void) => () => void
}

async function mountLyricsPanel(options: PanelOptions = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const store = usePlayerStore()
  store.setTracks([track])
  store.currentTrackId = track.id
  store.currentTime = options.currentTime ?? 0
  store.settings.lyricAnimation = true
  store.settings.lyricScale = 1

  const wrapper = mount(LyricsPanel, {
    attachTo: document.body,
    props: {
      active: options.active ?? true,
      getLyricsPlaybackState: options.getLyricsPlaybackState,
      subscribeLyricsPlayback: options.subscribeLyricsPlayback,
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

/** 挂载并等歌词就绪、尺寸就位 */
async function mountReadyPanel(options: PanelOptions = {}) {
  const mounted = await mountLyricsPanel(options)
  await flushVueUpdates()
  await layoutPanel(mounted.wrapper)
  runSpringFrames(120)
  await flushVueUpdates()
  return mounted
}

async function moveTo(store: ReturnType<typeof usePlayerStore>, time: number) {
  store.currentTime = time
  await flushVueUpdates()
}

describe('LyricsPanel', () => {
  it('shows timed waiting dots in the intro and interlude, freezes on pause and clears at singing/end', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce([
      { time: 12, endTime: 14, text: 'First' },
      { time: 30, endTime: 32, text: 'Second' },
    ])
    const state: LyricPlaybackState = {
      timeSeconds: 4,
      playing: false,
      playbackRate: 1,
      seeking: false,
    }
    const listeners = new Set<() => void>()
    const { wrapper } = await mountReadyPanel({
      getLyricsPlaybackState: () => state,
      subscribeLyricsPlayback: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })
    const notify = async (time: number) => {
      state.timeSeconds = time
      listeners.forEach((listener) => listener())
      await flushVueUpdates()
    }
    expect(wrapper.get('.lyric-waiting').attributes('aria-label')).toBe('前奏')
    expect(wrapper.findAll('.waiting-dot')).toHaveLength(3)
    expect(wrapper.get<HTMLElement>('.lyric-waiting').element.style.visibility).toBe('visible')
    expect(wrapper.classes()).toContain('paused')
    const before = wrapper.get('.lyrics-waiting-indicator').html()
    vi.advanceTimersByTime(1000)
    expect(wrapper.get('.lyrics-waiting-indicator').html()).toBe(before)
    await notify(12.5)
    expect(wrapper.find('.lyric-waiting').exists()).toBe(false)
    expect(wrapper.get('.lyric-line.active').text()).toBe('First')
    await notify(20)
    expect(wrapper.get('.lyric-waiting').attributes('aria-label')).toBe('间奏')
    expect(wrapper.find('.lyric-line.active').exists()).toBe(false)
    await notify(30.5)
    expect(wrapper.find('.lyric-waiting').exists()).toBe(false)
    await notify(33)
    expect(wrapper.find('.lyric-waiting').exists()).toBe(false)
    await notify(3)
    expect(wrapper.get('.lyric-waiting').attributes('aria-label')).toBe('前奏')
  })

  it('moves waiting dots with the next lyric when seeking while paused, including another interval', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce([
      { time: 12, endTime: 14, text: 'First' },
      { time: 30, endTime: 32, text: 'Second' },
    ])
    const { wrapper, store } = await mountReadyPanel({ currentTime: 30.5 })
    const halfGap = Math.min(100, Math.max(52, VIEWPORT * 0.16, GAP * 2)) / 2
    const assertAttached = (index: number) => {
      const dots = wrapper.get<HTMLElement>('.lyric-waiting').element
      expect(dots.dataset.waitingAnchor).toBe(String(index))
      expect(dots.style.visibility).toBe('visible')
      expect(Number.parseFloat(dots.style.top)).toBeCloseTo(lineY(wrapper, index) - halfGap, 1)
    }
    await moveTo(store, 20)
    assertAttached(1)
    const initial = Number.parseFloat(wrapper.get<HTMLElement>('.lyric-waiting').element.style.top)
    expect(initial).not.toBeCloseTo(VIEWPORT * 0.42, 0)
    runSpringFrames(8)
    assertAttached(1)
    expect(
      Number.parseFloat(wrapper.get<HTMLElement>('.lyric-waiting').element.style.top),
    ).not.toBeCloseTo(initial, 0)
    await moveTo(store, 4)
    assertAttached(0)
    const intro = wrapper.get('.lyric-waiting').element
    await moveTo(store, 8)
    expect(wrapper.get('.lyric-waiting').element).toBe(intro)
    assertAttached(0)
    runSpringFrames(120)
    assertAttached(0)
    expect(Number.parseFloat((intro as HTMLElement).style.top)).toBeCloseTo(VIEWPORT * 0.42, 0)
  })

  it('uses static waiting dots and boundary timers with lyric animation disabled', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce([{ time: 12, endTime: 14, text: 'First' }])
    const state: LyricPlaybackState = {
      timeSeconds: 4,
      playing: true,
      playbackRate: 1,
      seeking: false,
    }
    const { wrapper, store } = await mountReadyPanel({ getLyricsPlaybackState: () => state })
    store.settings.lyricAnimation = false
    store.isPlaying = true
    await flushVueUpdates()
    clearAnimationFrames()
    vi.advanceTimersByTime(1000)
    await flushVueUpdates()
    expect(
      wrapper.findAll('.waiting-dot').map((dot) => (dot.element as HTMLElement).style.opacity),
    ).toEqual(['0.65', '0.65', '0.65'])
    expect(rafCallbacks).toHaveLength(0)
    expect(wrapper.classes()).not.toContain('paused')
    expect(wrapper.get<HTMLElement>('.lyric-waiting').element.style.visibility).toBe('visible')
  })

  it('hides waiting dots during browsing and restores them after automatic follow resumes', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce([{ time: 12, endTime: 14, text: 'First' }])
    const { wrapper } = await mountReadyPanel({ currentTime: 4 })
    expect(wrapper.find('.lyric-waiting').exists()).toBe(true)
    await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 60, deltaMode: 0 })
    expect(wrapper.find('.lyric-waiting').exists()).toBe(false)
    expect(wrapper.find('.browse-return').exists()).toBe(false)
    vi.advanceTimersByTime(3200)
    await flushVueUpdates()
    expect(wrapper.find('.lyric-waiting').exists()).toBe(true)
  })

  it('uses real media boundaries at double speed, freezes while buffering and stops all hidden rendering', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce([
      { time: 0, text: 'First' },
      { time: 0.5, text: 'Second' },
      { time: 1, text: 'Third' },
    ])
    const state: LyricPlaybackState = {
      timeSeconds: 0.2,
      playing: true,
      playbackRate: 2,
      seeking: false,
    }
    const listeners = new Set<() => void>()
    const { wrapper, store } = await mountReadyPanel({
      getLyricsPlaybackState: () => state,
      subscribeLyricsPlayback: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    })
    const notify = () => listeners.forEach((listener) => listener())
    store.settings.lyricAnimation = false
    store.isPlaying = true
    await flushVueUpdates()
    clearAnimationFrames()
    const timers = vi.spyOn(window, 'setTimeout')
    notify()
    expect(timers.mock.calls.some(([, delay]) => delay === 150)).toBe(true)
    expect(rafCallbacks).toHaveLength(0)
    state.timeSeconds = 0.51
    vi.advanceTimersByTime(150)
    await flushVueUpdates()
    expect(wrapper.get('.lyric-line.active').text()).toContain('Second')
    state.playing = false
    notify()
    const beforeBuffer = wrapper.emitted('snapshot')?.length
    vi.advanceTimersByTime(5000)
    expect(wrapper.emitted('snapshot')?.length).toBe(beforeBuffer)
    state.timeSeconds = 1.1
    state.playing = true
    notify()
    await flushVueUpdates()
    expect(wrapper.get('.lyric-line.active').text()).toContain('Third')
    state.timeSeconds = 0.1
    state.playing = false
    notify()
    await flushVueUpdates()
    expect(wrapper.get('.lyric-line.active').text()).toContain('First')
    await wrapper.setProps({ active: false })
    const beforeInactive = wrapper.emitted('snapshot')?.length
    state.timeSeconds = 1.1
    notify()
    store.currentTime = 1.1
    await flushVueUpdates()
    expect(wrapper.emitted('snapshot')?.length).toBe(beforeInactive)
    await wrapper.setProps({ active: true })
    expect(wrapper.get('.lyric-line.active').text()).toContain('Third')
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      const beforeHidden = wrapper.emitted('snapshot')?.length
      state.timeSeconds = 0.1
      notify()
      store.currentTime = 0.1
      await flushVueUpdates()
      expect(wrapper.emitted('snapshot')?.length).toBe(beforeHidden)
    } finally {
      Reflect.deleteProperty(document, 'hidden')
    }
    document.dispatchEvent(new Event('visibilitychange'))
    await flushVueUpdates()
    expect(wrapper.get('.lyric-line.active').text()).toContain('First')
    wrapper.unmount()
    expect(listeners.size).toBe(0)
  })

  beforeEach(() => {
    vi.useFakeTimers()
    mockedHasCachedTrackLyrics.mockReset()
    mockedHasCachedTrackLyrics.mockReturnValue(false)
    mockedHasTrackLyricsSource.mockReset()
    mockedHasTrackLyricsSource.mockReturnValue(true)
    mockedLoadTrackLyrics.mockReset()
    mockedLoadTrackLyrics.mockResolvedValue(lyricsLines)
    mockedGetLyricsSource.mockReset()
    mockedGetLyricsSource.mockReturnValue(null)
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

  it('bounds mounted word nodes on long songs and binds distant karaoke by global index', async () => {
    const longLines: LyricLine[] = Array.from({ length: 2000 }, (_, index) => ({
      time: index * 5,
      endTime: index * 5 + 4,
      text: `Line ${index}`,
      words: Array.from({ length: 8 }, (_, word) => ({
        time: index * 5 + word * 0.5,
        duration: 0.5,
        text: String(word),
      })),
    }))
    mockedLoadTrackLyrics.mockResolvedValueOnce(longLines)
    const { wrapper, store } = await mountReadyPanel()
    expect(wrapper.findAll('.lyric-line').length).toBeLessThan(50)
    expect(wrapper.find('[data-lyric-index="1500"]').exists()).toBe(false)
    await moveTo(store, 7500.25)
    runSpringFrames(120)
    await flushVueUpdates()
    const active = wrapper.get<HTMLElement>('[data-lyric-index="1500"]')
    expect(active.classes()).toContain('active')
    expect(
      active.get<HTMLElement>('.lyric-word').element.style.getPropertyValue('--lyric-word-fill'),
    ).toBe('0.500')
    expect(lineY(wrapper, 1500)).toBeCloseTo(ANCHOR_Y, 0)
    expect(wrapper.findAll('.lyric-line').length).toBeLessThan(55)
    expect(wrapper.findAll('.lyric-word').length).toBeLessThan(440)
    expect(wrapper.find('[data-lyric-index="0"]').exists()).toBe(false)
  })

  it('measures newly mounted variable-height rows without losing the follow anchor', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.lyricIndex === '500' ? 80 : 40
    })
    mockedLoadTrackLyrics.mockResolvedValueOnce(
      Array.from({ length: 1000 }, (_, index) => ({
        time: index * 5,
        text: `Line ${index}`,
        translation: index === 500 ? 'A long translation' : undefined,
      })),
    )
    const { wrapper, store } = await mountReadyPanel()
    await moveTo(store, 2501)
    runSpringFrames(120)
    await flushVueUpdates()
    expect(lineY(wrapper, 500)).toBeCloseTo(VIEWPORT * 0.42 - 40, 0)
    expect(lineY(wrapper, 501) - lineY(wrapper, 500)).toBeCloseTo(80 + GAP, 0)
    store.settings.lyricTranslation = false
    await flushVueUpdates()
    expect(wrapper.get('[data-lyric-index="500"]').find('.lyric-translation').exists()).toBe(false)
    expect(lineY(wrapper, 500)).toBeCloseTo(VIEWPORT * 0.42 - 40, 0)
  })

  it('mounts and focuses distant rows through keyboard navigation without seeking playback', async () => {
    mockedLoadTrackLyrics.mockResolvedValueOnce(
      Array.from({ length: 1000 }, (_, index) => ({
        time: index * 5,
        text: `Line ${index}`,
      })),
    )
    const { wrapper } = await mountReadyPanel()
    const first = wrapper.get<HTMLElement>('[data-lyric-index="0"]')
    first.element.focus()
    await first.trigger('keydown', { key: 'End' })
    await flushVueUpdates()
    expect(document.activeElement).toBe(wrapper.get('[data-lyric-index="999"]').element)
    expect(wrapper.get('[data-lyric-index="999"]').attributes('tabindex')).toBe('0')
    expect(wrapper.emitted('seek')).toBeUndefined()
    await wrapper.get('[data-lyric-index="999"]').trigger('keydown', { key: 'ArrowUp' })
    await flushVueUpdates()
    expect(document.activeElement).toBe(wrapper.get('[data-lyric-index="998"]').element)
    expect(wrapper.findAll('.lyric-line').length).toBeLessThan(80)
  })

  it('publishes bounded real lyric diagnostics and releases them when disabled', async () => {
    mockedLoadTrackLyrics.mockResolvedValue(
      appleMusicLines.map((line, index) =>
        index === 0
          ? { ...line, text: 'a'.repeat(200), translation: '翻译', roman: 'roman' }
          : index === 3
            ? { ...line, time: 0, endTime: 6 }
            : line,
      ),
    )
    mockedGetLyricsSource.mockReturnValue('amll')
    const { wrapper, store } = await mountReadyPanel({ currentTime: 3.5 })
    expect(wrapper.emitted('debug')).toBeUndefined()
    await wrapper.setProps({ debugEnabled: true })
    await vi.advanceTimersByTimeAsync(0)
    const latest = () => wrapper.emitted('debug')?.at(-1)?.[0] as LyricsDebugSnapshot | null
    expect(latest()).toMatchObject({
      trackId: track.id,
      status: 'ready',
      source: 'amll',
      lineCount: 4,
      wordLineCount: 3,
      wordCount: 3,
      harmonyLineCount: 1,
      translationLineCount: 1,
      romanLineCount: 1,
      mediaSeconds: 3.5,
      panelActive: true,
      userBrowsing: false,
      engine: { mountedLineCount: 4, scrollMode: 'follow' },
    })
    expect(latest()?.activeLines).toHaveLength(3)
    expect(latest()?.activeIndices).toEqual([0, 1, 2, 3])
    expect(latest()?.activeLines[0]?.text).toHaveLength(120)
    const before = wrapper.emitted('debug')!.length
    store.isPlaying = true
    await nextTick()
    runSpringFrames(60)
    const updates = wrapper
      .emitted('debug')!
      .slice(before)
      .map(([value]) => value as LyricsDebugSnapshot)
    expect(updates.length).toBeLessThanOrEqual(5)
    for (let index = 1; index < updates.length; index += 1)
      expect(updates[index]!.sampledAtMs - updates[index - 1]!.sampledAtMs).toBeGreaterThanOrEqual(
        200,
      )
    await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 100 })
    await vi.advanceTimersByTimeAsync(200)
    expect(latest()).toMatchObject({ userBrowsing: true, engine: { scrollMode: 'browse' } })
    await wrapper.setProps({ debugEnabled: false })
    expect(latest()).toBeNull()
    const stoppedCount = wrapper.emitted('debug')!.length
    runSpringFrames(30)
    expect(wrapper.emitted('debug')).toHaveLength(stoppedCount)
  })

  it('clears old previews during track loading, reports failure, and cancels pending debug samples', async () => {
    const { wrapper, store } = await mountReadyPanel()
    await wrapper.setProps({ debugEnabled: true })
    await vi.advanceTimersByTimeAsync(0)
    const pending = makeDeferred<LyricLine[]>()
    mockedLoadTrackLyrics.mockReturnValueOnce(pending.promise)
    store.setTracks([track, secondTrack])
    store.selectTrack(secondTrack)
    await flushVueUpdates()
    expect(wrapper.emitted('debug')?.at(-1)?.[0]).toBeNull()
    await vi.advanceTimersByTimeAsync(200)
    expect(wrapper.emitted('debug')?.at(-1)?.[0]).toMatchObject({
      trackId: secondTrack.id,
      status: 'loading',
      source: null,
      lineCount: 0,
      activeLines: [],
      engine: { mountedLineCount: 0 },
    })
    pending.reject(new Error('unavailable'))
    await flushVueUpdates()
    await vi.advanceTimersByTimeAsync(200)
    expect(wrapper.emitted('debug')?.at(-1)?.[0]).toMatchObject({ status: 'error' })
    store.currentTime = 15
    await nextTick()
    wrapper.unmount()
    const count = wrapper.emitted('debug')!.length
    expect(wrapper.emitted('debug')?.at(-1)?.[0]).toBeNull()
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.emitted('debug')).toHaveLength(count)
  })

  it('reports reduced motion, inactive and hidden states without starting a diagnostic render loop', async () => {
    const originalMatchMedia = window.matchMedia
    vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
      ...originalMatchMedia(query),
      matches: query === '(prefers-reduced-motion: reduce)',
    }))
    const { wrapper, store } = await mountReadyPanel()
    try {
      await wrapper.setProps({ debugEnabled: true })
      await vi.advanceTimersByTimeAsync(0)
      expect(wrapper.emitted('debug')?.at(-1)?.[0]).toMatchObject({
        playing: false,
        reducedMotion: true,
        animationEnabled: false,
        renderLoopRunning: false,
      })
      store.isPlaying = true
      await nextTick()
      await wrapper.setProps({ active: false })
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(200)
      expect(wrapper.emitted('debug')?.at(-1)?.[0]).toMatchObject({
        playing: true,
        panelActive: false,
        documentHidden: true,
        renderLoopRunning: false,
        engine: { mountedLineCount: 5, stagedLineCount: 0, visibleLineCount: 0 },
      })
      store.settings.lyricTranslation = false
      await nextTick()
      await vi.advanceTimersByTimeAsync(200)
      expect(wrapper.emitted('debug')?.at(-1)?.[0]).toMatchObject({
        translationEnabled: false,
        translationLineCount: 1,
        renderLoopRunning: false,
      })
    } finally {
      Reflect.deleteProperty(document, 'hidden')
    }
  })

  describe('loading', () => {
    it('ignores queued provider updates and completion after unmount', async () => {
      const pending = makeDeferred<LyricLine[]>()
      let publish!: (lines: LyricLine[]) => void
      mockedLoadTrackLyrics.mockImplementationOnce((_track, _signal, progress) => {
        publish = progress!
        return pending.promise
      })
      const { wrapper } = await mountLyricsPanel()
      wrapper.unmount()
      const snapshots = wrapper.emitted('snapshot')?.length ?? 0
      const availability = wrapper.emitted('availability')?.length ?? 0

      publish(karaokeLines)
      pending.resolve(lyricsLines)
      await flushVueUpdates()

      expect(wrapper.emitted('snapshot')?.length ?? 0).toBe(snapshots)
      expect(wrapper.emitted('availability')?.length ?? 0).toBe(availability)
    })

    it('renders interim lyrics and upgrades them without waiting for the final source', async () => {
      const pending = makeDeferred<LyricLine[]>()
      let publish!: (lines: LyricLine[]) => void
      mockedLoadTrackLyrics.mockImplementationOnce((_track, _signal, progress) => {
        publish = progress!
        return pending.promise
      })
      const { wrapper } = await mountLyricsPanel()
      const plainLines: LyricLine[] = [{ time: 0, text: 'Plain first' }]
      mockedGetLyricsSource.mockImplementation((lines) =>
        lines === plainLines ? 'meting' : lines === karaokeLines ? 'netease' : null,
      )
      publish(plainLines)
      await flushVueUpdates()
      expect(wrapper.find('.lyric-line').text()).toContain('Plain first')
      expect(wrapper.emitted('snapshot')?.at(-1)?.[0]).toMatchObject({ source: 'meting' })
      publish(karaokeLines)
      await flushVueUpdates()
      expect(wrapper.findAll('.lyric-line').length).toBeGreaterThan(0)
      expect(wrapper.findAll('.lyric-word').length).toBeGreaterThan(0)
      expect(wrapper.emitted('snapshot')?.at(-1)?.[0]).toMatchObject({ source: 'netease' })
      const snapshotsBefore = wrapper.emitted('snapshot')?.length
      pending.resolve(karaokeLines)
      await flushVueUpdates()
      expect(wrapper.emitted('snapshot')?.length).toBe(snapshotsBefore)
    })
    it('clears the previous lyrics source while the next track is loading', async () => {
      mockedGetLyricsSource.mockImplementation((lines) => (lines === lyricsLines ? 'amll' : null))
      const { wrapper, store } = await mountReadyPanel()
      expect(wrapper.emitted('snapshot')?.at(-1)?.[0]).toMatchObject({ source: 'amll' })
      const pending = makeDeferred<LyricLine[]>()
      mockedLoadTrackLyrics.mockReturnValueOnce(pending.promise)
      store.setTracks([track, secondTrack])
      store.selectTrack(secondTrack, [track, secondTrack])
      await flushVueUpdates()
      expect(wrapper.emitted('snapshot')?.at(-1)?.[0]).toMatchObject({
        status: 'loading',
        source: undefined,
        lines: [],
      })
      pending.resolve([])
      await flushVueUpdates()
    })
    it.each([0, 0.05])(
      'keeps an in-flight line transition when the same lyrics gain word timing (offset: %s)',
      async (offset) => {
        const pending = makeDeferred<LyricLine[]>()
        let publish!: (lines: LyricLine[]) => void
        mockedLoadTrackLyrics.mockImplementationOnce((_track, _signal, progress) => {
          publish = progress!
          return pending.promise
        })
        const { wrapper, store } = await mountLyricsPanel()
        publish(lyricsLines)
        await flushVueUpdates()
        await layoutPanel(wrapper)
        await moveTo(store, 10.5)
        runSpringFrames(3)
        const before = lineY(wrapper, 2)
        const originalRow = wrapper.get('[data-lyric-index="2"]').element
        expect(before).not.toBeCloseTo(ANCHOR_Y, 0)
        const upgraded = lyricsLines.map((line) => ({
          ...line,
          time: line.time! + offset,
          words: [{ time: line.time! + offset, duration: 2, text: line.text }],
        }))

        publish(upgraded)
        await flushVueUpdates()

        expect(lineY(wrapper, 2)).toBeCloseTo(before, 2)
        expect(wrapper.get('[data-lyric-index="2"]').element).toBe(originalRow)
        expect(wrapper.get('[data-lyric-index="2"] .lyric-word').attributes('style')).toContain(
          `--lyric-word-fill: ${((0.5 - offset) / 2).toFixed(3)}`,
        )
        runSpringFrames(120)
        expect(lineY(wrapper, 2)).toBeCloseTo(ANCHOR_Y, 0)
        pending.resolve(upgraded)
        await flushVueUpdates()
      },
    )
    it('rebuilds its timeline when interim lyrics are replaced with new timestamps', async () => {
      const pending = makeDeferred<LyricLine[]>()
      let publish!: (lines: LyricLine[]) => void
      mockedLoadTrackLyrics.mockImplementationOnce((_track, _signal, progress) => {
        publish = progress!
        return pending.promise
      })
      const { wrapper, store } = await mountLyricsPanel({ currentTime: 1 })
      publish([
        { time: 0, text: 'First' },
        { time: 10, text: 'Second' },
      ])
      await flushVueUpdates()
      expect(wrapper.find('.lyric-line.active').text()).toBe('First')

      const replacement: LyricLine[] = [
        { time: 0, text: 'First' },
        { time: 0.5, text: 'Second' },
      ]
      publish(replacement)
      await flushVueUpdates()
      expect(wrapper.find('.lyric-line.active').text()).toBe('Second')
      await moveTo(store, 0.25)
      expect(wrapper.find('.lyric-line.active').text()).toBe('First')
      await moveTo(store, 0.75)
      expect(wrapper.find('.lyric-line.active').text()).toBe('Second')
      pending.resolve(replacement)
      await flushVueUpdates()
    })

    it('selects and positions the current line as soon as lyrics finish loading', async () => {
      const deferred = makeDeferred<LyricLine[]>()
      mockedLoadTrackLyrics.mockReturnValueOnce(deferred.promise)
      const { wrapper } = await mountLyricsPanel({ currentTime: 12 })

      deferred.resolve(lyricsLines)
      await flushVueUpdates()
      await layoutPanel(wrapper)

      expect(wrapper.findAll('.lyric-line')[2]?.classes()).toContain('active')
      expect(lineY(wrapper, 2)).toBeCloseTo(ANCHOR_Y, 5)
      expect(lineY(wrapper, 3)).toBeCloseTo(ANCHOR_Y + PITCH, 5)
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

      deferred.resolve(lyricsLines)
      await flushVueUpdates()
      const readySnapshot = wrapper.emitted('snapshot')?.at(-1)?.[0] as LyricsSnapshot | undefined
      expect(readySnapshot?.status).toBe('ready')
      expect(readySnapshot?.activeIndex).toBe(2)
    })

    it('renders untimed plain lyrics without forcing an active line', async () => {
      const plainLines: LyricLine[] = [
        { time: null, text: 'Plain line one' },
        { time: null, text: 'Plain line two' },
      ]
      mockedLoadTrackLyrics.mockResolvedValueOnce(plainLines)
      const { wrapper } = await mountReadyPanel({ currentTime: 30 })

      expect(wrapper.findAll('.lyric-line')).toHaveLength(2)
      expect(wrapper.findAll('.lyric-line.active')).toHaveLength(0)
      expect(wrapper.findAll<HTMLButtonElement>('.lyric-line')[0]?.element.disabled).toBe(true)
      // 没有当前行时第一行停在锚点位置,供用户从头阅读
      expect(lineY(wrapper, 0)).toBeCloseTo(ANCHOR_Y, 5)
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

    it('reloads lyrics when the active track object is preserved but its store version changes', async () => {
      const { store } = await mountLyricsPanel()
      await flushVueUpdates()
      expect(mockedLoadTrackLyrics).toHaveBeenCalledTimes(1)

      mockedLoadTrackLyrics.mockResolvedValueOnce([{ time: 0, text: 'Reloaded line' }])
      store.setTracks([{ ...track, title: 'Test Track Reloaded' }])
      await flushVueUpdates()

      expect(mockedLoadTrackLyrics).toHaveBeenCalledTimes(2)
    })

    it('clears transient lyrics but leaves the leaving rows in place when the track changes', async () => {
      const { wrapper, store } = await mountReadyPanel()
      await moveTo(store, 16)
      runSpringFrames(120)

      expect(wrapper.findAll('.lyric-line')).toHaveLength(lyricsLines.length)
      const leaving = wrapper.findAll<HTMLElement>('.lyric-line')[3]?.element
      const position = leaving?.style.translate
      expect(position).not.toBe('')

      const nextLyrics = makeDeferred<LyricLine[]>()
      mockedLoadTrackLyrics.mockReturnValueOnce(nextLyrics.promise)
      store.setTracks([track, secondTrack])
      store.selectTrack(secondTrack, store.tracks)
      await flushVueUpdates()

      expect(wrapper.findAll('.lyric-line')).toHaveLength(0)
      // 旧行在真实浏览器里会带着淡出过渡再卸载,期间必须留在原位,
      // 清掉 translate 会让整屏歌词堆到顶上叠成一团
      expect(leaving?.style.translate).toBe(position)
    })
  })

  describe('following playback', () => {
    it('releases a finished native line after a brief overlap and restores the handoff after seeking back', async () => {
      const lines: LyricLine[] = [
        {
          time: 0,
          endTime: 2.01,
          text: 'First',
          wordSource: 'native',
          words: [{ time: 0, duration: 2.01, text: 'First' }],
        },
        {
          time: 2,
          endTime: 4,
          text: 'Second',
          wordSource: 'native',
          words: [{ time: 2, duration: 2, text: 'Second' }],
        },
        {
          time: 6,
          endTime: 7,
          text: 'Third',
          wordSource: 'native',
          words: [{ time: 6, duration: 1, text: 'Third' }],
        },
      ]
      mockedLoadTrackLyrics.mockResolvedValueOnce(lines)
      const { wrapper, store } = await mountReadyPanel({ currentTime: 1.5 })
      const row = (index: number) => wrapper.get(`[data-lyric-index="${index}"]`)
      const firstWord = row(0).get<HTMLElement>('.lyric-word').element
      const assertHandoff = () => {
        expect(row(0).classes()).toContain('completed')
        expect(row(0).classes()).not.toContain('active')
        expect(row(1).classes()).toContain('active')
        expect(row(1).classes()).not.toContain('completed')
        expect(wrapper.findAll('.lyric-line.active')).toHaveLength(1)
        expect(row(1).attributes('tabindex')).toBe('0')
        expect(wrapper.emitted('snapshot')?.at(-1)?.[0]).toMatchObject({
          activeIndex: 1,
          activeIndices: [1],
        })
        for (const property of ['--lyric-word-fill', '--lyric-word-edge', '--lyric-word-rise'])
          expect(firstWord.style.getPropertyValue(property)).toBe('')
        for (const character of firstWord.querySelectorAll<HTMLElement>('.lyric-char'))
          expect(character.style.getPropertyValue('--lyric-char-emphasis')).toBe('')
        expect(
          row(1)
            .get<HTMLElement>('.lyric-word')
            .element.style.getPropertyValue('--lyric-word-fill'),
        ).not.toBe('')
      }

      await moveTo(store, 2)
      expect(
        wrapper.findAll('.lyric-line.active').map((line) => line.attributes('data-lyric-index')),
      ).toEqual(['0', '1'])
      expect(firstWord.style.getPropertyValue('--lyric-word-fill')).not.toBe('')

      await moveTo(store, 2.01)
      assertHandoff()
      await moveTo(store, 2.02)
      assertHandoff()

      await moveTo(store, 1.5)
      expect(row(0).classes()).toContain('active')
      expect(row(0).classes()).not.toContain('completed')
      expect(row(1).classes()).not.toContain('active')
      expect(firstWord.style.getPropertyValue('--lyric-word-fill')).not.toBe('')
      expect(wrapper.emitted('snapshot')?.at(-1)?.[0]).toMatchObject({
        activeIndex: 0,
        activeIndices: [0],
      })
      await moveTo(store, 2.02)
      assertHandoff()
    })

    it('distinguishes completed, singing and upcoming lines and restores them after seeking back', async () => {
      const { wrapper, store } = await mountReadyPanel({ currentTime: 11 })
      const classes = (index: number) => wrapper.get(`[data-lyric-index="${index}"]`).classes()

      expect(classes(1)).toContain('completed')
      expect(classes(2)).toContain('active')
      expect(classes(2)).not.toContain('completed')
      expect(classes(3)).not.toContain('completed')

      await moveTo(store, 1)
      expect(classes(0)).toContain('active')
      expect(classes(1)).not.toContain('completed')
      expect(classes(2)).not.toContain('completed')
    })

    it('updates completed rows at a boundary even when the singing group stays unchanged', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce([
        { time: 0, endTime: 10, text: 'Long voice' },
        { time: 2, endTime: 2, text: 'Instant annotation', background: true },
        { time: 12, endTime: 15, text: 'Last line' },
      ])
      const { wrapper, store } = await mountReadyPanel({ currentTime: 1 })
      const annotation = () => wrapper.get('[data-lyric-index="1"]')
      expect(annotation().classes()).not.toContain('completed')

      await moveTo(store, 3)
      expect(wrapper.get('[data-lyric-index="0"]').classes()).toContain('active')
      expect(annotation().classes()).toContain('completed')

      await moveTo(store, 15)
      expect(wrapper.get('[data-lyric-index="2"]').classes()).toContain('completed')
      expect(wrapper.findAll('.lyric-line.active')).toHaveLength(0)
    })

    it.each([140, 260])(
      'keeps the spring and syllable animation active after shrinking the lyric stage to %ipx',
      async (viewportHeight) => {
        mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
        const { wrapper, store } = await mountReadyPanel()
        await layoutPanel(wrapper, { viewportHeight, lineHeight: 28 })
        runSpringFrames(120)
        const anchor = viewportHeight * 0.42 - 14
        const before = lineY(wrapper, 1)

        await moveTo(store, 5.25)
        expect(lineY(wrapper, 1)).toBeCloseTo(before, 5)
        runSpringFrames(8)
        expect(lineY(wrapper, 1)).toBeLessThan(before - 1)
        expect(lineY(wrapper, 1)).toBeGreaterThan(anchor + 1)
        runSpringFrames(120)
        expect(lineY(wrapper, 1)).toBeCloseTo(anchor, 0)

        const word = wrapper.get<HTMLElement>('[data-lyric-index="1"] .lyric-word')
        expect(word.element.style.getPropertyValue('--lyric-word-fill')).toBe('0.250')
        await moveTo(store, 5.75)
        expect(word.element.style.getPropertyValue('--lyric-word-fill')).toBe('0.750')
        expect(wrapper.classes()).not.toContain('animation-disabled')
      },
    )

    it('brings the new line to the anchor with a spring when currentTime moves on', async () => {
      const { wrapper, store } = await mountReadyPanel()
      const before = lineY(wrapper, 3)

      await moveTo(store, 16)

      expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
      // 目标变了,位置还在原处:动画由弹簧逐帧推进
      expect(lineY(wrapper, 3)).toBeCloseTo(before, 5)
      runSpringFrames(120)
      expect(lineY(wrapper, 3)).toBeCloseTo(ANCHOR_Y, 0)
      expect(lineY(wrapper, 2)).toBeCloseTo(ANCHOR_Y - PITCH, 0)
    })

    it('does nothing while playback stays on the same lyric line', async () => {
      const { wrapper, store } = await mountReadyPanel()
      await moveTo(store, 10)
      runSpringFrames(120)
      clearAnimationFrames()

      store.currentTime = 11
      await flushVueUpdates()

      expect(rafCallbacks).toHaveLength(0)
      expect(lineY(wrapper, 2)).toBeCloseTo(ANCHOR_Y, 0)
    })

    it('redirects an in-flight settle without a jump instead of restarting', async () => {
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 10)
      runSpringFrames(4)
      const midway = lineY(wrapper, 0)
      expect(midway).toBeLessThan(ANCHOR_Y - 1)

      await moveTo(store, 15)

      // 打断重定向:弹簧只改目标不改当前位置,关键帧动画在这里会跳一下
      expect(lineY(wrapper, 0)).toBeCloseTo(midway, 5)
      runSpringFrames(120)
      expect(lineY(wrapper, 3)).toBeCloseTo(ANCHOR_Y, 0)
    })

    it('starts the lines one after another instead of moving them all at once', async () => {
      const manyLines: LyricLine[] = Array.from({ length: 12 }, (_, index) => ({
        time: index * 5,
        text: `Line ${index}`,
      }))
      mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 7)
      const topBefore = lineY(wrapper, 0)
      const lowerBefore = lineY(wrapper, 5)
      runSpringFrames(3)

      // 起步后 48ms:最上面的行已经在走,靠下的行还被按在原地。
      // 所有行同时起步只是整片匀速平移,"被拽上去"的观感就来自这个时间差
      expect(lineY(wrapper, 0)).toBeLessThan(topBefore - 1)
      expect(lineY(wrapper, 5)).toBeCloseTo(lowerBefore, 1)
    })

    it('never lets neighbouring lines cross while a pull settles', async () => {
      const manyLines: LyricLine[] = Array.from({ length: 12 }, (_, index) => ({
        time: index * 5,
        text: `Line ${index}`,
      }))
      mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 21)
      for (let step = 0; step < 90; step += 1) {
        // 只看舞台内的行:视口外的行不再写位置,translate 是过期值
        const ys = wrapper
          .findAll<HTMLElement>('.lyric-line')
          .filter((line) => line.element.style.visibility !== 'hidden')
          .map((line) => Number.parseFloat(line.element.style.translate.replace(/^0\s+/, '')))
        for (let index = 1; index < ys.length; index += 1) {
          expect(ys[index]! - ys[index - 1]!).toBeGreaterThanOrEqual(LINE - 0.01)
        }
        runSpringFrames(1)
      }
      expect(lineY(wrapper, 4)).toBeCloseTo(ANCHOR_Y, 0)
    })

    it('cascades a far seek in from just outside the viewport instead of flying through the song', async () => {
      const manyLines: LyricLine[] = Array.from({ length: 80 }, (_, index) => ({
        time: index * 5,
        text: `Line ${index}`,
      }))
      mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 60 * 5 + 1)

      expect(wrapper.get('[data-lyric-index="60"]').classes()).toContain('active')
      const start = lineY(wrapper, 60)
      expect(start - ANCHOR_Y).toBeGreaterThan(VIEWPORT * 0.5)
      expect(start - ANCHOR_Y).toBeLessThanOrEqual(VIEWPORT * 0.55 + 0.01)
      runSpringFrames(120)
      expect(lineY(wrapper, 60)).toBeCloseTo(ANCHOR_Y, 0)
    })

    it('starts pulling toward a clicked line right away and emits the seek', async () => {
      const { wrapper, store } = await mountReadyPanel()
      // 父级同步处理 seek:currentTime 立刻写入
      const seekHandler = (time: number) => {
        store.currentTime = time
      }
      wrapper.vm.$.vnode.props = { ...wrapper.vm.$.vnode.props, onSeek: seekHandler }
      await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 120, deltaMode: 0 })
      expect(wrapper.classes()).toContain('browsing')

      await wrapper.findAll('.lyric-line')[3]!.trigger('click')

      expect(wrapper.emitted('seek')?.at(-1)).toEqual([15])
      // 点击立刻退出浏览态并开始牵引,不等 3.2s 的浏览超时
      expect(wrapper.classes()).not.toContain('browsing')
      runSpringFrames(120)
      expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
      expect(lineY(wrapper, 3)).toBeCloseTo(ANCHOR_Y, 0)
    })

    it('runs a render loop while playing and stops it once paused', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
      const { store } = await mountReadyPanel()
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
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 0.45)

      expect(wrapper.findAll('.lyric-line')[1]?.classes()).toContain('active')
      const style = wrapper.get('.lyrics-panel').attributes('style') ?? ''
      const tempo = Number(/--lyric-tempo:\s*([\d.]+)/.exec(style)?.[1])
      expect(tempo).toBeGreaterThan(0)
      expect(tempo).toBeLessThan(1)
    })

    it('uses boundary timers for plain lines between timeupdate events without continuous RAF', async () => {
      const rapidLines: LyricLine[] = Array.from({ length: 20 }, (_, index) => ({
        time: index * 0.3,
        text: `Rapid ${index}`,
      }))
      mockedLoadTrackLyrics.mockResolvedValueOnce(rapidLines)
      const { wrapper, store } = await mountReadyPanel()

      store.isPlaying = true
      await flushVueUpdates()
      expect(rafCallbacks).toHaveLength(0)

      // timeupdate 事件间隔内(锚点仍停在 currentTime=0)推进 900ms 真实时间:
      // 外推时钟到 0.9s,高亮落在第 3 行(0.9s)
      vi.advanceTimersByTime(904)
      flushAnimationFrames()
      await flushVueUpdates()

      expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
    })

    it('re-anchors the lyric clock when resuming after a long pause', async () => {
      const rapidLines: LyricLine[] = Array.from({ length: 400 }, (_, index) => ({
        time: index * 0.3,
        text: `Rapid ${index}`,
      }))
      mockedLoadTrackLyrics.mockResolvedValueOnce(rapidLines)
      const { wrapper, store } = await mountReadyPanel()

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
      const { wrapper, store } = await mountReadyPanel()

      store.isPlaying = true
      await flushVueUpdates()

      // timeupdate 停发(缓冲 stall)推进 5s:外推封顶 1s,不会一直超前于实际音频
      vi.advanceTimersByTime(5000)
      flushAnimationFrames()
      await flushVueUpdates()

      const activeIndex = wrapper
        .findAll('.lyric-line')
        .findIndex((line) => line.classes().includes('active'))
      expect(activeIndex).toBeGreaterThanOrEqual(0)
      expect(activeIndex).toBeLessThan(10)
    })

    it('lets the spring coefficient decide how quickly the pull settles', async () => {
      async function remainingAfter(spring: number) {
        const { wrapper, store } = await mountReadyPanel()
        store.settings.lyricSpring = spring
        await flushVueUpdates()

        const start = lineY(wrapper, 0)
        await moveTo(store, 10)
        runSpringFrames(8)
        return Math.abs(lineY(wrapper, 0) - (start - 2 * PITCH))
      }

      const soft = await remainingAfter(0.5)
      const stiff = await remainingAfter(2)

      // 系数按刚度理解:越大越紧绷,同样帧数里剩下的位移更少
      expect(stiff).toBeLessThan(soft)
    })

    it('snaps instead of animating when lyric animation is off', async () => {
      const { wrapper, store } = await mountReadyPanel()
      store.settings.lyricAnimation = false
      await flushVueUpdates()
      clearAnimationFrames()

      await moveTo(store, 16)

      expect(wrapper.classes()).toContain('animation-disabled')
      expect(lineY(wrapper, 3)).toBeCloseTo(ANCHOR_Y, 5)
      expect(rafCallbacks).toHaveLength(0)
    })
  })

  describe('layout', () => {
    it.each(['observer', 'window'] as const)(
      'keeps an in-flight line transition after an unchanged %s resize',
      async (notification) => {
        async function trajectory(notify: boolean) {
          const { wrapper, store } = await mountReadyPanel()
          await moveTo(store, 10)
          runSpringFrames(3)
          if (notify) {
            if (notification === 'observer') MockResizeObserver.instances.at(-1)?.emit()
            else window.dispatchEvent(new Event('resize'))
          }
          const positions: number[] = []
          for (let frame = 0; frame < 20; frame += 1) {
            runSpringFrames(1)
            await flushVueUpdates()
            positions.push(lineY(wrapper, 2))
          }
          wrapper.unmount()
          return positions
        }

        expect(await trajectory(true)).toEqual(await trajectory(false))
      },
    )

    it('remeasures missed hidden resizes and finishes interrupted positioning on return', async () => {
      const { wrapper, store } = await mountReadyPanel()
      await moveTo(store, 10)
      runSpringFrames(3)
      expect(lineY(wrapper, 2)).not.toBeCloseTo(ANCHOR_Y, 0)

      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      try {
        document.dispatchEvent(new Event('visibilitychange'))
        await layoutPanel(wrapper, { viewportHeight: 300, lineHeight: 60 })
      } finally {
        Reflect.deleteProperty(document, 'hidden')
      }
      document.dispatchEvent(new Event('visibilitychange'))
      await flushVueUpdates()

      expect(lineY(wrapper, 2)).toBeCloseTo(300 * 0.42 - 30, 0)
      expect(lineY(wrapper, 3)).toBeCloseTo(300 * 0.42 - 30 + 60 + GAP, 0)
    })

    it('re-measures and keeps the active line anchored when the lyric scale changes', async () => {
      const { wrapper, store } = await mountReadyPanel()
      await moveTo(store, 10)
      runSpringFrames(120)
      expect(lineY(wrapper, 2)).toBeCloseTo(ANCHOR_Y, 0)

      // 模拟倍率变化后浏览器提供的换行高度；不额外发 resize，验证设置本身触发重测。
      wrapper.findAll<HTMLElement>('.lyric-line').forEach((line) => {
        defineReadonlyNumber(line.element, 'offsetHeight', 60)
      })
      store.settings.lyricScale = 1.5
      await flushVueUpdates()

      expect(wrapper.element.style.getPropertyValue('--lyric-scale')).toBe('1.5')
      expect(wrapper.findAll('.lyric-line')[2]?.classes()).toContain('active')
      // 改字号先保留屏幕位置，再追新排版目标。
      expect(lineY(wrapper, 2)).toBeCloseTo(ANCHOR_Y, 0)
      runSpringFrames(120)
      expect(lineY(wrapper, 2)).toBeCloseTo(VIEWPORT * 0.42 - 30, 0)
      expect(lineY(wrapper, 3)).toBeCloseTo(VIEWPORT * 0.42 - 30 + 60 + GAP, 0)
    })

    it('re-measures after ResizeObserver and window resize notifications', async () => {
      const { wrapper, store } = await mountReadyPanel()
      await moveTo(store, 10)
      runSpringFrames(120)
      clearAnimationFrames()

      const viewport = wrapper.get<HTMLElement>('.lyrics-viewport').element
      defineReadonlyNumber(viewport, 'clientHeight', 300)
      expect(MockResizeObserver.instances.length).toBeGreaterThan(0)
      MockResizeObserver.instances[0]?.emit(viewport)
      flushAnimationFrames()
      expect(lineY(wrapper, 2)).toBeCloseTo(ANCHOR_Y, 0)
      runSpringFrames(120)
      expect(lineY(wrapper, 2)).toBeCloseTo(300 * 0.42 - LINE / 2, 0)

      defineReadonlyNumber(viewport, 'clientHeight', 800)
      window.dispatchEvent(new Event('resize'))
      flushAnimationFrames()
      expect(lineY(wrapper, 2)).toBeCloseTo(300 * 0.42 - LINE / 2, 0)
      runSpringFrames(120)
      expect(lineY(wrapper, 2)).toBeCloseTo(800 * 0.42 - LINE / 2, 0)
    })

    it('hides lyric translations from the panel and snapshot when disabled', async () => {
      mockedGetLyricsSource.mockImplementation((lines) => (lines === lyricsLines ? 'qq' : null))
      const { wrapper, store } = await mountReadyPanel()
      await moveTo(store, 10)

      expect(wrapper.find('.lyric-translation').text()).toBe('Translation two')
      const snapshotWithTranslation = wrapper.emitted('snapshot')?.at(-1)?.[0] as
        | LyricsSnapshot
        | undefined
      expect(snapshotWithTranslation?.lines.find((line) => line.text === 'Line two')).toMatchObject(
        {
          translation: 'Translation two',
        },
      )

      store.settings.lyricTranslation = false
      await flushVueUpdates()

      expect(wrapper.find('.lyric-translation').exists()).toBe(false)
      const snapshotWithoutTranslation = wrapper.emitted('snapshot')?.at(-1)?.[0] as
        | LyricsSnapshot
        | undefined
      expect(
        snapshotWithoutTranslation?.lines.find((line) => line.text === 'Line two'),
      ).not.toHaveProperty('translation')
      expect(snapshotWithoutTranslation?.source).toBe('qq')
    })

    it('unmounts distant lines and mounts them as they approach', async () => {
      const manyLines: LyricLine[] = Array.from({ length: 40 }, (_, index) => ({
        time: index * 5,
        text: `Line ${index}`,
      }))
      mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
      const { wrapper, store } = await mountReadyPanel()

      expect(wrapper.find('[data-lyric-index="30"]').exists()).toBe(false)
      expect(wrapper.get<HTMLElement>('[data-lyric-index="2"]').element.style.visibility).toBe('')

      await moveTo(store, 30 * 5 + 1)
      runSpringFrames(120)
      await flushVueUpdates()
      expect(wrapper.get<HTMLElement>('[data-lyric-index="30"]').element.style.visibility).toBe('')
      expect(wrapper.find('[data-lyric-index="2"]').exists()).toBe(false)
    })
  })

  describe('browsing', () => {
    it('does not restart scrolling from a browsing timeout while the page is hidden', async () => {
      const { wrapper } = await mountReadyPanel()
      await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 100, deltaMode: 0 })
      runSpringFrames(30)
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      try {
        document.dispatchEvent(new Event('visibilitychange'))
        clearAnimationFrames()
        vi.advanceTimersByTime(4000)
        await flushVueUpdates()
        expect(rafCallbacks).toHaveLength(0)
      } finally {
        Reflect.deleteProperty(document, 'hidden')
      }
      document.dispatchEvent(new Event('visibilitychange'))
      await flushVueUpdates()
      expect(wrapper.classes()).not.toContain('browsing')
      expect(lineY(wrapper, 0)).toBeCloseTo(ANCHOR_Y, 0)
    })

    it('resumes smoothly after the last browsing gesture has been idle for 3.2 seconds', async () => {
      const { wrapper, store } = await mountReadyPanel()

      await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 100, deltaMode: 0 })
      vi.advanceTimersByTime(1200)
      await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 40, deltaMode: 0 })
      runSpringFrames(60)
      expect(wrapper.classes()).toContain('browsing')
      // 内容按滚轮量上移
      expect(lineY(wrapper, 0)).toBeCloseTo(ANCHOR_Y - 140, 0)

      await moveTo(store, 16)
      runSpringFrames(60)
      expect(wrapper.findAll('.lyric-line')[3]?.classes()).toContain('active')
      expect(wrapper.classes()).toContain('browsing')
      runSpringFrames(150)
      await flushVueUpdates()
      expect(wrapper.classes()).not.toContain('browsing')
      expect(lineY(wrapper, 3)).toBeCloseTo(ANCHOR_Y, 0)
    })

    it('returns from distant lyrics without rendering a return button', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(
        Array.from({ length: 80 }, (_, index) => ({ time: index * 5, text: `Line ${index}` })),
      )
      const { wrapper, store } = await mountReadyPanel()
      await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 1500, deltaMode: 0 })
      runSpringFrames(120)
      await flushVueUpdates()
      await moveTo(store, 5)
      expect(wrapper.classes()).toContain('browsing')
      expect(wrapper.find('.browse-return').exists()).toBe(false)
      vi.advanceTimersByTime(3200)
      runSpringFrames(120)
      await flushVueUpdates()
      expect(wrapper.classes()).not.toContain('browsing')
      expect(wrapper.find('.browse-return').exists()).toBe(false)
      expect(lineY(wrapper, 1)).toBeCloseTo(ANCHOR_Y, 0)
    })

    it('does not take over within the gesture grace period even when a sentence changes', async () => {
      const { wrapper, store } = await mountReadyPanel()
      await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 40, deltaMode: 0 })
      await moveTo(store, 5)
      await flushVueUpdates()
      expect(wrapper.classes()).toContain('browsing')
      runSpringFrames(40)
      await moveTo(store, 10)
      expect(wrapper.classes()).toContain('browsing')
      vi.advanceTimersByTime(3200)
      await flushVueUpdates()
      expect(wrapper.classes()).not.toContain('browsing')
    })

    it('scales wheel deltas given in lines and pages', async () => {
      const manyLines: LyricLine[] = Array.from({ length: 40 }, (_, index) => ({
        time: index * 5,
        text: `Line ${index}`,
      }))
      mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
      const { wrapper } = await mountReadyPanel()

      await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 1, deltaMode: 1 })
      runSpringFrames(60)
      expect(lineY(wrapper, 0)).toBeCloseTo(ANCHOR_Y - 40, 0)

      // 翻一整页后第 0 行已在舞台外(位置不再写),看仍在舞台内的第 10 行
      await wrapper.get('.lyrics-viewport').trigger('wheel', { deltaY: 1, deltaMode: 2 })
      runSpringFrames(60)
      expect(lineY(wrapper, 10)).toBeCloseTo(ANCHOR_Y + 10 * PITCH - 40 - VIEWPORT, 0)
    })

    it('follows the finger while dragging and coasts after release', async () => {
      const manyLines: LyricLine[] = Array.from({ length: 40 }, (_, index) => ({
        time: index * 5,
        text: `Line ${index}`,
      }))
      mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
      const { wrapper } = await mountReadyPanel()
      const viewport = wrapper.get('.lyrics-viewport')

      await viewport.trigger('touchstart', { touches: [{ clientY: 400 }] })
      vi.advanceTimersByTime(16)
      await viewport.trigger('touchmove', { touches: [{ clientY: 360 }] })
      // 拖动 1:1 跟随:没有弹簧,当帧到位
      expect(lineY(wrapper, 0)).toBeCloseTo(ANCHOR_Y - 40, 5)
      expect(wrapper.classes()).toContain('browsing')

      vi.advanceTimersByTime(16)
      await viewport.trigger('touchmove', { touches: [{ clientY: 320 }] })
      await viewport.trigger('touchend', { touches: [] })
      const released = lineY(wrapper, 0)
      runSpringFrames(20)
      // 松手后按惯性继续往同一方向滑
      expect(lineY(wrapper, 0)).toBeLessThan(released - 10)
    })

    it('restores follow after a second finger interrupts lyric dragging', async () => {
      const { wrapper } = await mountReadyPanel()
      const viewport = wrapper.get('.lyrics-viewport')
      await viewport.trigger('touchstart', { touches: [{ clientY: 400 }] })
      await viewport.trigger('touchmove', { touches: [{ clientY: 350 }] })
      await viewport.trigger('touchstart', {
        touches: [{ clientY: 350 }, { clientY: 450 }],
      })
      await viewport.trigger('touchend', { touches: [] })
      expect(wrapper.classes()).toContain('browsing')
      vi.advanceTimersByTime(3200)
      runSpringFrames(120)
      await flushVueUpdates()
      expect(wrapper.classes()).not.toContain('browsing')
      expect(lineY(wrapper, 0)).toBeCloseTo(ANCHOR_Y, 0)
      expect(wrapper.emitted('seek')).toBeUndefined()
    })

    it('stops a cancelled touch without starting momentum or seeking', async () => {
      const { wrapper } = await mountReadyPanel()
      const viewport = wrapper.get('.lyrics-viewport')

      await viewport.trigger('touchstart', { touches: [{ clientY: 400 }] })
      vi.advanceTimersByTime(16)
      await viewport.trigger('touchmove', { touches: [{ clientY: 360 }] })
      const position = lineY(wrapper, 0)
      await viewport.trigger('touchcancel', { touches: [] })
      runSpringFrames(20)

      expect(lineY(wrapper, 0)).toBeCloseTo(position, 2)
      expect(wrapper.emitted('seek')).toBeUndefined()
    })

    it('treats a touch without movement as a tap and does not enter browsing', async () => {
      const { wrapper } = await mountReadyPanel()
      const viewport = wrapper.get('.lyrics-viewport')

      await viewport.trigger('touchstart', { touches: [{ clientY: 400 }] })
      await viewport.trigger('touchmove', { touches: [{ clientY: 403 }] })
      await viewport.trigger('touchend', { touches: [] })

      expect(wrapper.classes()).not.toContain('browsing')
      expect(lineY(wrapper, 0)).toBeCloseTo(ANCHOR_Y, 5)
    })

    it('scrolls with the keyboard and brings a focused line into view', async () => {
      const manyLines: LyricLine[] = Array.from({ length: 40 }, (_, index) => ({
        time: index * 5,
        text: `Line ${index}`,
      }))
      mockedLoadTrackLyrics.mockResolvedValueOnce(manyLines)
      const { wrapper } = await mountReadyPanel()
      const viewport = wrapper.get('.lyrics-viewport')

      await viewport.trigger('keydown', { key: 'PageDown' })
      runSpringFrames(60)
      expect(wrapper.classes()).toContain('browsing')
      expect(lineY(wrapper, 5)).toBeCloseTo(ANCHOR_Y + 5 * PITCH - VIEWPORT * 0.8, 0)

      await viewport.trigger('keydown', { key: 'Home' })
      runSpringFrames(60)
      expect(lineY(wrapper, 0)).toBeCloseTo(ANCHOR_Y, 0)

      // Tab 落到视口外的行上:容器不会滚动,面板自己把它带进来
      const far = wrapper.get<HTMLElement>('[data-lyric-index="12"]')
      await far.trigger('focusin')
      runSpringFrames(60)
      const y = lineY(wrapper, 12)
      expect(y).toBeGreaterThan(0)
      expect(y + LINE).toBeLessThanOrEqual(VIEWPORT * 0.88 + 0.5)
    })

    it('restores the latest target when active changes from false to true', async () => {
      const { wrapper, store } = await mountLyricsPanel({ active: false })
      await flushVueUpdates()
      await layoutPanel(wrapper)

      await moveTo(store, 16)
      expect(wrapper.findAll('.lyric-line')).toHaveLength(0)
      // 不活跃时不动版面
      expect(lineY(wrapper, 3)).toBe(0)

      await wrapper.setProps({ active: true })
      await flushVueUpdates()

      expect(lineY(wrapper, 3)).toBeCloseTo(ANCHOR_Y, 0)
    })
  })

  describe('karaoke', () => {
    it('restores the current word fill when showing a paused panel after seeking while hidden', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
      const { wrapper, store } = await mountReadyPanel({ currentTime: 0.5 })
      await wrapper.setProps({ active: false })
      await moveTo(store, 5.5)
      await wrapper.setProps({ active: true })
      await flushVueUpdates()

      const active = wrapper.get('[data-lyric-index="1"]')
      expect(active.classes()).toContain('active')
      expect(
        active.get<HTMLElement>('.lyric-word').element.style.getPropertyValue('--lyric-word-fill'),
      ).toBe('0.500')
      expect(
        wrapper
          .get<HTMLElement>('[data-lyric-index="0"] .lyric-word')
          .element.style.getPropertyValue('--lyric-word-fill'),
      ).toBe('')
    })

    it('renders one span per syllable and keeps a wrappable gap between words', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
      const { wrapper } = await mountReadyPanel()

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
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 0.5)

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
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 0.5)
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
      const { wrapper, store } = await mountReadyPanel()

      store.settings.lyricAnimation = false
      await flushVueUpdates()
      await moveTo(store, 5.5)

      const active = wrapper.findAll<HTMLElement>('.lyric-line')[1]!
      expect(active.classes()).toContain('active')
      for (const word of active.findAll<HTMLElement>('.lyric-word')) {
        expect(word.element.style.getPropertyValue('--lyric-word-fill')).toBe('')
      }
    })

    it('advances the syllable fill from the extrapolated clock between timeupdates', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
      const { wrapper, store } = await mountReadyPanel()

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

      expect(Number(word.element.style.getPropertyValue('--lyric-word-fill'))).toBeGreaterThan(
        before,
      )
    })

    it('releases the syllable fill of the line that stops being active', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 0.5)
      const previous = wrapper
        .findAll<HTMLElement>('.lyric-line')[0]!
        .findAll<HTMLElement>('.lyric-word')[0]!
      expect(previous.element.style.getPropertyValue('--lyric-word-fill')).not.toBe('')

      await moveTo(store, 5.5)

      expect(previous.element.style.getPropertyValue('--lyric-word-fill')).toBe('')
      const current = wrapper
        .findAll<HTMLElement>('.lyric-line')[1]!
        .findAll<HTMLElement>('.lyric-word')[0]!
      expect(current.element.style.getPropertyValue('--lyric-word-fill')).toBe('0.500')
    })

    it('animates genuine long words as intact characters and releases their rise on handoff', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 1.5)

      const words = wrapper
        .findAll<HTMLElement>('.lyric-line')[0]!
        .findAll<HTMLElement>('.lyric-word')
      expect(words[0]!.element.style.getPropertyValue('--lyric-word-fill')).toBe('1.000')
      expect(words[0]!.element.style.getPropertyValue('--lyric-word-rise')).toBe('1.000')
      expect(words[0]!.findAll('.lyric-char').map((character) => character.text())).toEqual([
        'z',
        'e',
      ])
      await moveTo(store, 5)
      expect(words[0]!.element.style.getPropertyValue('--lyric-word-rise')).toBe('')
    })

    it('keeps unsung words a flat colour with no bright leading edge', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(karaokeLines)
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 0.5)

      const words = wrapper
        .findAll<HTMLElement>('.lyric-line')[0]!
        .findAll<HTMLElement>('.lyric-word')
      // 前沿柔化宽度必须随进度收敛到 0,否则未唱词的左边缘会被画出一段"亮→暗"
      expect(words[1]!.element.style.getPropertyValue('--lyric-word-fill')).toBe('0.000')
      expect(words[1]!.element.style.getPropertyValue('--lyric-word-edge')).toBe('0.000')
      expect(Number(words[0]!.element.style.getPropertyValue('--lyric-word-edge'))).toBeGreaterThan(
        0,
      )
    })

    it('renders plain lyrics as whole lines with no karaoke spans', async () => {
      const { wrapper, store } = await mountReadyPanel()
      await moveTo(store, 10)

      const active = wrapper.findAll('.lyric-line')[2]!
      expect(active.classes()).toContain('active')
      expect(active.classes()).not.toContain('karaoke')
      expect(active.findAll('.lyric-word')).toHaveLength(0)
      expect(active.text()).toContain('Line two')
    })
  })

  describe('duets and harmonies', () => {
    it('highlights both voices of a duet at the same time', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(appleMusicLines)
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 1)

      const rendered = wrapper.findAll('.lyric-line')
      expect(rendered[0]?.classes()).toContain('active')
      expect(rendered[1]?.classes()).toContain('active')
      expect(rendered[1]?.classes()).toContain('secondary')
      // 和声要到 3s 才开口,不该跟着父句一起亮
      expect(rendered[2]?.classes()).not.toContain('active')
      const snapshot = wrapper.emitted('snapshot')?.at(-1)?.[0] as LyricsSnapshot | undefined
      expect(snapshot?.activeIndices).toEqual([0, 1])
      expect(snapshot?.activeIndex).toBe(0)
    })

    it('lights a harmony line on its own timeline instead of with its parent', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(appleMusicLines)
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 3.5)

      const rendered = wrapper.findAll('.lyric-line')
      expect(rendered[0]?.classes()).toContain('active')
      expect(rendered[2]?.classes()).toContain('active')
      expect(rendered[2]?.classes()).toContain('background')
    })

    it('unfolds a harmony under its sentence while it is sung and folds it away afterwards', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(appleMusicLines)
      const { wrapper, store } = await mountReadyPanel()
      const harmony = () => wrapper.findAll('.lyric-line')[2]!
      expect(harmony().text()).toBe('ooh')

      // 间奏里(6s 唱完、8s 才有下一句):和声收着,下一句紧接在主句后面
      await moveTo(store, 7)
      runSpringFrames(120)
      const folded = lineY(wrapper, 3)
      expect(harmony().classes()).toContain('harmony-hidden')
      expect(harmony().attributes('inert')).toBeDefined()
      expect(folded).toBeCloseTo(lineY(wrapper, 1) + PITCH, 0)

      // 回到主句在唱的时候:和声现身(自己的时间点还没到),下一句被弹开
      await moveTo(store, 1)
      expect(harmony().classes()).not.toContain('harmony-hidden')
      expect(harmony().attributes('inert')).toBeUndefined()
      runSpringFrames(120)
      expect(lineY(wrapper, 3)).toBeGreaterThan(folded + LINE)
      // 和声从主句下沿探出来
      expect(lineY(wrapper, 2)).toBeCloseTo(lineY(wrapper, 1) + LINE + 8, 0)

      // 主句唱完进入间奏:主句保留完成态亮度,和声收走,下一句收拢回来
      await moveTo(store, 7)
      expect(harmony().classes()).toContain('harmony-hidden')
      expect(harmony().attributes('inert')).toBeDefined()
      runSpringFrames(120)
      expect(lineY(wrapper, 3)).toBeCloseTo(folded, 0)
    })

    it('holds visual focus across a short gap and dims completed lines when the next sentence starts', async () => {
      mockedLoadTrackLyrics.mockResolvedValueOnce(appleMusicLines)
      const { wrapper, store } = await mountReadyPanel()

      await moveTo(store, 6.5)

      const lastVoice = wrapper.get('[data-lyric-index="1"]')
      expect(lastVoice.classes()).not.toContain('completed')
      expect(lastVoice.classes()).toContain('active')
      expect(wrapper.get('[data-lyric-index="0"]').attributes('tabindex')).toBe('0')
      expect(wrapper.get('[data-lyric-index="3"]').classes()).not.toContain('completed')
      await moveTo(store, 8)
      expect(lastVoice.classes()).toContain('completed')
      expect(lastVoice.classes()).not.toContain('active')
    })
  })
})
