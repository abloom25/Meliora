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
