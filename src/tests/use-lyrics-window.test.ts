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
  return {
    closed: false,
    document: popupDocument,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(function close(this: Window & { closed: boolean }) {
      this.closed = true
    }),
  } as unknown as Window
}

function mountLyricsWindowHarness(popup = createPopupWindow()) {
  vi.spyOn(window, 'open').mockReturnValue(popup)

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
        api = useLyricsWindow({
          currentTrack: ref(track),
          isPlaying: ref(false),
        })
        return {}
      },
      template: '<div />',
    }),
  )

  return { api, popup, track, wrapper }
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
})
