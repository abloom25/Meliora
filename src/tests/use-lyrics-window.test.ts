import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLyricsWindow } from '../composables/useLyricsWindow'
import type { LyricsSnapshot, Track } from '../types/music'

vi.mock('../utils/browser', () => ({
  supportsDocumentPictureInPicture: vi.fn(() => false),
}))

function createPopupWindow(readyState: DocumentReadyState = 'complete'): Window {
  const popupDocument = document.implementation.createHTMLDocument('Meliora lyrics')
  Object.defineProperty(popupDocument, 'readyState', {
    configurable: true,
    value: readyState,
  })
  const frames: FrameRequestCallback[] = []
  return {
    closed: false,
    document: popupDocument,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    // 小窗的扫光跑在它自己的帧循环上:主窗口后台时 rAF 会被节流到约 1Hz
    frames,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    }),
    cancelAnimationFrame: vi.fn(),
    close: vi.fn(function close(this: Window & { closed: boolean }) {
      this.closed = true
    }),
  } as unknown as Window
}

function mountLyricsWindowHarness(popup = createPopupWindow()) {
  vi.spyOn(window, 'open').mockReturnValue(popup)
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const lyricAnimation = ref(true)

  const track = reactive<Track>({
    id: 'track-1',
    title: 'Original title',
    artist: 'Original artist',
    cover: '/cover-a.jpg',
    audioUrl: '/audio.mp3',
    kind: 'local',
  })
  let api!: ReturnType<typeof useLyricsWindow>

  const wrapper = mount(
    defineComponent({
      setup() {
        api = useLyricsWindow({ currentTrack: ref(track), isPlaying, currentTime, lyricAnimation })
        return {}
      },
      template: '<div />',
    }),
  )

  return { api, popup, track, wrapper, isPlaying, currentTime, lyricAnimation }
}

function runPopupFrames(popup: Window, count: number, stepMs = 16) {
  const host = popup as unknown as { frames: FrameRequestCallback[] }
  for (let frame = 0; frame < count; frame += 1) {
    vi.advanceTimersByTime(stepMs)
    const callbacks = host.frames.splice(0, host.frames.length)
    callbacks.forEach((callback) => callback(performance.now()))
  }
}

async function mountScrollingHarness() {
  const harness = mountLyricsWindowHarness()
  const { api, popup } = harness
  await api.toggleLyricsWindow()
  const lines = Array.from({ length: 100 }, (_, index) => ({
    time: index,
    text: `Line ${index}`,
    words: [{ time: index, duration: 1, text: `Line ${index}` }],
  }))
  const show = (activeIndex: number, tempoScale = 1) =>
    api.setSnapshot({ status: 'ready', activeIndex, tempoScale, lines })
  show(1)
  const viewport = popup.document.querySelector<HTMLElement>('.lyrics')!
  Object.defineProperty(viewport, 'clientHeight', { value: 600 })
  runPopupFrames(popup, 1)
  let drift = 0
  const animations: Animation[] = []
  const animate = vi.fn(() => {
    const animation = {
      cancel: vi.fn(() => {
        drift = 0
      }),
      onfinish: null,
    } as unknown as Animation
    animations.push(animation)
    return animation
  })
  popup.document.querySelector<HTMLElement>('.lyrics-lines')!.animate = animate
  for (const node of popup.document.querySelectorAll<HTMLElement>('.line')) {
    vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, [...node.parentNode!.children].indexOf(node) * 60 + drift, 300, 60),
    )
  }
  return {
    ...harness,
    show,
    animate,
    animations,
    setDrift: (value: number) => {
      drift = value
    },
  }
}

describe('useLyricsWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('does not force the first plain lyric line active when activeIndex is -1', async () => {
    const { api, popup, wrapper } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()

    api.setSnapshot({
      status: 'ready',
      activeIndex: -1,
      lines: [
        { time: null, text: 'Plain line one' },
        { time: null, text: 'Plain line two' },
      ],
    })

    expect(popup.document.querySelectorAll('.line')).toHaveLength(2)
    expect(popup.document.querySelector('.line.active')).toBeNull()
    wrapper.unmount()
  })

  it('renders a state message while lyrics are not ready', async () => {
    const { api, popup, wrapper } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()

    api.setSnapshot({
      status: 'loading',
      activeIndex: -1,
      lines: [],
    })

    expect(popup.document.querySelector('.state')?.textContent).toBe('正在载入歌词')
    expect(popup.document.querySelectorAll('.line')).toHaveLength(0)
    wrapper.unmount()
  })

  it('updates track metadata when the same track object changes in place', async () => {
    const { api, popup, track, wrapper } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()

    Object.assign(track, {
      title: 'Updated title',
      artist: 'Updated artist',
      cover: '/cover-b.jpg',
    })
    await nextTick()

    expect(popup.document.querySelector('h1')?.textContent).toBe('Updated title')
    expect(popup.document.querySelector('header p')?.textContent).toBe('Updated artist')
    expect(popup.document.querySelector('img')?.getAttribute('src')).toBe('/cover-b.jpg')
    wrapper.unmount()
  })

  it('removes stale translation nodes when the snapshot no longer includes translations', async () => {
    const { api, popup, wrapper } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()

    const withTranslation: LyricsSnapshot = {
      status: 'ready',
      activeIndex: 0,
      lines: [{ time: 0, text: 'Original', translation: 'Translation' }],
    }
    api.setSnapshot(withTranslation)
    expect(popup.document.querySelector('.translation')?.textContent).toBe('Translation')

    api.setSnapshot({
      status: 'ready',
      activeIndex: 0,
      lines: [{ time: 0, text: 'Original' }],
    })

    expect(popup.document.querySelector('.translation')).toBeNull()
    wrapper.unmount()
  })

  it('closes a popup that is still opening when the composable unmounts', async () => {
    const popup = createPopupWindow('loading')
    const { api, wrapper } = mountLyricsWindowHarness(popup)

    const opening = api.toggleLyricsWindow()
    await nextTick()
    wrapper.unmount()
    await vi.runOnlyPendingTimersAsync()
    await opening

    expect(popup.close).toHaveBeenCalled()
  })

  it('prioritizes current lyrics and restores context when the popup grows', async () => {
    const { api, popup, wrapper } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()
    api.setSnapshot({
      status: 'ready',
      activeIndex: 1,
      lines: [
        { time: 0, text: 'Previous' },
        { time: 1, text: 'Current', translation: '当前句的译文' },
        { time: 2, text: 'Next' },
        { time: 3, text: 'Later' },
      ],
    })
    const viewport = popup.document.querySelector<HTMLElement>('.lyrics')!
    const container = popup.document.querySelector<HTMLElement>('.lyrics-lines')!
    let height = 110
    Object.defineProperty(viewport, 'clientHeight', { get: () => height })
    Object.defineProperty(container, 'offsetHeight', {
      get: () =>
        [...container.children].reduce(
          (total, node) =>
            total +
            ((node as HTMLElement).hidden ? 0 : node.querySelector('.translation') ? 100 : 40),
          0,
        ),
    })
    runPopupFrames(popup, 1)
    const visibleText = () =>
      [...container.querySelectorAll<HTMLElement>('.line')]
        .filter((node) => !node.hidden)
        .map((node) => node.querySelector('.main')?.textContent)
    expect(visibleText()).toEqual(['Current'])
    expect(container.querySelector('.translation')?.textContent).toBe('当前句的译文')

    const resize = vi
      .mocked(popup.addEventListener)
      .mock.calls.find(([event]) => event === 'resize')![1] as EventListener
    height = 160
    resize(new Event('resize'))
    runPopupFrames(popup, 1)
    expect(visibleText()).toEqual(['Current', 'Next'])

    height = 300
    resize(new Event('resize'))
    runPopupFrames(popup, 1)
    expect(visibleText()).toEqual(['Previous', 'Current', 'Next', 'Later'])
    wrapper.unmount()
    expect(popup.removeEventListener).toHaveBeenCalledWith('resize', resize)
  })

  it('keeps the entire active duet and harmony group even when it needs scrolling', async () => {
    const { api, popup, wrapper } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()
    api.setSnapshot({
      status: 'ready',
      activeIndex: 1,
      activeIndices: [1, 2, 3],
      lines: [
        { time: 0, text: 'Previous' },
        { time: 1, text: 'Lead' },
        { time: 1, text: 'Duet', agent: 'secondary' },
        { time: 1, text: 'Harmony', background: true },
      ],
    })
    const viewport = popup.document.querySelector<HTMLElement>('.lyrics')!
    const container = popup.document.querySelector<HTMLElement>('.lyrics-lines')!
    Object.defineProperty(viewport, 'clientHeight', { value: 40 })
    Object.defineProperty(container, 'offsetHeight', { value: 200 })
    runPopupFrames(popup, 1)
    expect(container.querySelector<HTMLElement>('.before')?.hidden).toBe(true)
    expect(
      [...container.querySelectorAll<HTMLElement>('.active')].every((node) => !node.hidden),
    ).toBe(true)
    wrapper.unmount()
  })

  it('retains the first plain lyric and cancels pending layout on close', async () => {
    const { api, popup, wrapper } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()
    api.setSnapshot({
      status: 'ready',
      activeIndex: -1,
      lines: [
        { time: null, text: 'First' },
        { time: null, text: 'Second' },
      ],
    })
    const viewport = popup.document.querySelector<HTMLElement>('.lyrics')!
    const container = popup.document.querySelector<HTMLElement>('.lyrics-lines')!
    Object.defineProperty(viewport, 'clientHeight', { value: 30 })
    Object.defineProperty(container, 'offsetHeight', { value: 100 })
    runPopupFrames(popup, 1)
    const lines = container.querySelectorAll<HTMLElement>('.line')
    expect(lines[0]?.hidden).toBe(false)
    expect(lines[1]?.hidden).toBe(true)
    api.setSnapshot({ status: 'ready', activeIndex: -1, lines: [{ time: null, text: 'Changed' }] })
    wrapper.unmount()
    expect(popup.cancelAnimationFrame).toHaveBeenCalled()
  })

  it('scrolls retained lyric nodes without rebuilding words or growing the DOM', async () => {
    const { popup, show, animate, wrapper } = await mountScrollingHarness()
    const nextLine = popup.document.querySelector('[data-index="2"]')!
    const nextWord = nextLine.querySelector('.word')
    show(2)
    runPopupFrames(popup, 1)
    expect(popup.document.querySelector('.active')).toBe(nextLine)
    expect(nextLine.querySelector('.word')).toBe(nextWord)
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateY(60px)' }, { transform: 'translateY(0)' }],
      { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' },
    )
    expect(animate).toHaveBeenCalledTimes(1)
    for (let index = 3; index < 90; index += 1) {
      show(index)
      runPopupFrames(popup, 1)
      expect(popup.document.querySelectorAll('.line')).toHaveLength(4)
    }
    wrapper.unmount()
  })

  it('interrupts rapid changes at the visual position and coalesces updates into one frame', async () => {
    const { popup, show, animate, animations, setDrift, wrapper } = await mountScrollingHarness()
    show(2)
    runPopupFrames(popup, 1)
    const firstAnimations = [...animations]
    setDrift(20)
    animate.mockClear()
    show(3, 0.5)
    show(4, 0.5)
    expect(
      firstAnimations.every((animation) => vi.mocked(animation.cancel).mock.calls.length === 1),
    ).toBe(true)
    expect(animate).not.toHaveBeenCalled()
    runPopupFrames(popup, 1)
    expect(animate).toHaveBeenCalledWith(
      [{ transform: 'translateY(140px)' }, { transform: 'translateY(0)' }],
      { duration: 210, easing: 'cubic-bezier(.16,1,.3,1)' },
    )
    expect(popup.document.querySelector('.active')?.getAttribute('data-index')).toBe('4')
    wrapper.unmount()
    expect(
      animations.every((animation) => vi.mocked(animation.cancel).mock.calls.length === 1),
    ).toBe(true)
  })

  it('does not restart scrolling or lose karaoke bindings for an unchanged snapshot', async () => {
    const { popup, show, animate, animations, currentTime, lyricAnimation, wrapper } =
      await mountScrollingHarness()
    show(2)
    runPopupFrames(popup, 1)
    const calls = animate.mock.calls.length
    const frames = vi.mocked(popup.requestAnimationFrame).mock.calls.length
    show(2)
    expect(animate).toHaveBeenCalledTimes(calls)
    expect(popup.requestAnimationFrame).toHaveBeenCalledTimes(frames)
    expect(
      animations.every((animation) => vi.mocked(animation.cancel).mock.calls.length === 0),
    ).toBe(true)
    lyricAnimation.value = false
    await nextTick()
    expect(
      animations.every((animation) => vi.mocked(animation.cancel).mock.calls.length === 1),
    ).toBe(true)
    lyricAnimation.value = true
    currentTime.value = 2.5
    await nextTick()
    expect(
      popup.document.querySelector<HTMLElement>('.active .word')?.style.getPropertyValue('--w'),
    ).toBe('0.500')
    wrapper.unmount()
  })

  it('skips scrolling with animation disabled and releases compositor hints after finishing', async () => {
    const { popup, show, animate, animations, lyricAnimation, wrapper } =
      await mountScrollingHarness()
    lyricAnimation.value = false
    await nextTick()
    show(2)
    runPopupFrames(popup, 1)
    expect(animate).not.toHaveBeenCalled()
    lyricAnimation.value = true
    await nextTick()
    show(3)
    runPopupFrames(popup, 1)
    expect(popup.document.querySelector('.lyrics.scrolling')).not.toBeNull()
    for (const animation of animations) {
      animation.onfinish?.call(animation, {} as AnimationPlaybackEvent)
    }
    expect(popup.document.querySelector('.lyrics.scrolling')).toBeNull()
    expect(
      [...popup.document.querySelectorAll<HTMLElement>('.line, .lyrics-lines')].every(
        (node) => !node.style.willChange,
      ),
    ).toBe(true)
    wrapper.unmount()
  })

  it('moves mixed-height lyrics as one group when context is restored or playback reverses', async () => {
    const { popup, show, animate, wrapper } = await mountScrollingHarness()
    const nodes = [...popup.document.querySelectorAll<HTMLElement>('.line')]
    const individualAnimations = nodes.map((node) => (node.animate = vi.fn()))
    for (const node of nodes) {
      vi.mocked(node.getBoundingClientRect).mockImplementation(() => {
        const siblings = [...node.parentNode!.children] as HTMLElement[]
        const heightOf = (element: HTMLElement) => (Number(element.dataset.index) % 2 ? 140 : 40)
        const top = siblings
          .slice(0, siblings.indexOf(node))
          .reduce((y, row) => y + heightOf(row) + 12, 0)
        return new DOMRect(0, top, 300, heightOf(node))
      })
    }
    // 旧视图中曾被隐藏的行,在切句后重新显示。
    nodes[2]!.hidden = true
    show(2)
    runPopupFrames(popup, 1)
    expect(animate).toHaveBeenCalledTimes(1)
    expect(individualAnimations.every((animation) => animation.mock.calls.length === 0)).toBe(true)
    expect(popup.document.querySelector<HTMLElement>('.lyrics-lines')!.style.willChange).toBe(
      'transform',
    )
    show(1)
    runPopupFrames(popup, 1)
    expect(animate).toHaveBeenCalledTimes(2)
    expect(individualAnimations.every((animation) => animation.mock.calls.length === 0)).toBe(true)
    wrapper.unmount()
  })

  it('does not animate when the popup prefers reduced motion', async () => {
    const popup = createPopupWindow()
    popup.matchMedia = vi.fn(() => ({ ...window.matchMedia(''), matches: true }))
    const { api, wrapper } = mountLyricsWindowHarness(popup)
    await api.toggleLyricsWindow()
    const lines = Array.from({ length: 5 }, (_, index) => ({ time: index, text: `Line ${index}` }))
    api.setSnapshot({ status: 'ready', activeIndex: 1, lines })
    runPopupFrames(popup, 1)
    const nodes = [...popup.document.querySelectorAll<HTMLElement>('.line')]
    const reads = nodes.map((node) => vi.spyOn(node, 'getBoundingClientRect'))
    api.setSnapshot({ status: 'ready', activeIndex: 2, lines })
    runPopupFrames(popup, 1)
    expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true)
    wrapper.unmount()
  })

  it('renders syllable spans and fills only the active line', async () => {
    const { api, popup, currentTime } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()
    await nextTick()

    currentTime.value = 0.5
    await nextTick()
    api.setSnapshot({
      status: 'ready',
      activeIndex: 0,
      lines: [
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
          words: [{ time: 5, duration: 2, text: 'one' }],
        },
      ],
    })

    const words = popup.document.querySelectorAll<HTMLElement>('.line.active .word')
    expect([...words].map((word) => word.textContent)).toEqual(['ze', 'ro'])
    expect(popup.document.querySelectorAll('.line.active .gap')).toHaveLength(1)
    expect(words[0]?.style.getPropertyValue('--w')).toBe('0.500')
    expect(words[1]?.style.getPropertyValue('--w')).toBe('0.000')

    // 非当前行不写内联值,CSS 的 var() 兜底把它们渲染成已唱完
    const idle = popup.document.querySelector<HTMLElement>('.line:not(.active) .word')
    expect(idle?.style.getPropertyValue('--w')).toBe('')
  })

  it('stops the syllable scan in the popup when lyric animation is off', async () => {
    const { api, popup, currentTime, lyricAnimation } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()
    await nextTick()

    currentTime.value = 0.5
    await nextTick()
    api.setSnapshot({
      status: 'ready',
      activeIndex: 0,
      lines: [
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
      ],
    })

    const word = popup.document.querySelector<HTMLElement>('.line.active .word')!
    expect(word.style.getPropertyValue('--w')).toBe('0.500')

    lyricAnimation.value = false
    await nextTick()

    // 释放内联值后由样式里的 var(--w,1) 兜底成"已唱完",整行一次性高亮
    expect(word.style.getPropertyValue('--w')).toBe('')
    expect(word.style.getPropertyValue('--e')).toBe('')

    lyricAnimation.value = true
    await nextTick()
    expect(word.style.getPropertyValue('--w')).toBe('0.500')
  })

  it('drives the fill from its own frame loop while playing', async () => {
    const { api, popup, isPlaying, currentTime } = mountLyricsWindowHarness()
    await api.toggleLyricsWindow()
    await nextTick()

    api.setSnapshot({
      status: 'ready',
      activeIndex: 0,
      lines: [
        {
          time: 0,
          endTime: 4,
          text: 'long',
          wordSource: 'native',
          words: [{ time: 0, duration: 4, text: 'long' }],
        },
      ],
    })

    isPlaying.value = true
    currentTime.value = 0
    await nextTick()

    const word = popup.document.querySelector<HTMLElement>('.line.active .word')!
    const before = Number(word.style.getPropertyValue('--w'))
    runPopupFrames(popup, 20)

    expect(Number(word.style.getPropertyValue('--w'))).toBeGreaterThan(before)
  })
})
