import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, reactive, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useLyricsWindow } from '../platform/web/useLyricsWindow'
import type { LyricLine, LyricsSnapshot, Track } from '../core/types'
import type { LyricPlaybackState } from '../core/lyrics/render-schedule'
import { supportsDocumentPictureInPicture } from '../platform/web/browser'

vi.mock('../platform/web/browser', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/web/browser')>()),
  supportsDocumentPictureInPicture: vi.fn(() => false),
}))

function createPopupWindow(readyState: DocumentReadyState = 'complete'): Window {
  const popupDocument = document.implementation.createHTMLDocument('Meliora lyrics')
  Object.defineProperty(popupDocument, 'readyState', {
    configurable: true,
    value: readyState,
  })
  Object.defineProperty(popupDocument, 'hidden', { configurable: true, value: false })
  const frames: FrameRequestCallback[] = []
  return {
    closed: false,
    innerWidth: 430,
    innerHeight: 600,
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
    setTimeout: vi.fn((callback: () => void, delay: number) => window.setTimeout(callback, delay)),
    clearTimeout: vi.fn((handle: number) => window.clearTimeout(handle)),
    close: vi.fn(function close(this: Window & { closed: boolean }) {
      this.closed = true
    }),
  } as unknown as Window
}

function mountLyricsWindowHarness(
  popup = createPopupWindow(),
  getPlaybackSeconds?: () => number,
  playback: {
    getLyricsPlaybackState?: () => LyricPlaybackState
    subscribeLyricsPlayback?: (listener: () => void) => () => void
  } = {},
) {
  vi.spyOn(window, 'open').mockReturnValue(popup)
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const lyricAnimation = ref(true)
  const debugEnabled = ref(false)

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
          isPlaying,
          currentTime,
          getPlaybackSeconds,
          ...playback,
          lyricAnimation,
          debugEnabled,
        })
        return {}
      },
      template: '<div />',
    }),
  )

  return { api, popup, track, wrapper, isPlaying, currentTime, lyricAnimation, debugEnabled }
}

function runPopupFrames(popup: Window, count: number, stepMs = 16) {
  const host = popup as unknown as { frames: FrameRequestCallback[] }
  for (let frame = 0; frame < count; frame += 1) {
    vi.advanceTimersByTime(stepMs)
    const callbacks = host.frames.splice(0, host.frames.length)
    callbacks.forEach((callback) => callback(performance.now()))
  }
}

async function mountScrollingHarness(
  lines: LyricLine[] = Array.from({ length: 100 }, (_, index) => ({
    time: index,
    text: `Line ${index}`,
    words: [{ time: index, duration: 1, text: `Line ${index}` }],
  })),
) {
  const harness = mountLyricsWindowHarness()
  const { api, popup } = harness
  await api.toggleLyricsWindow()
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
  it('uses its own boundary timer while the main page is hidden and responds immediately to media state changes', async () => {
    const state: LyricPlaybackState = {
      timeSeconds: 0.2,
      playing: true,
      playbackRate: 2,
      seeking: false,
    }
    const getState = vi.fn(() => state)
    const listeners = new Set<() => void>()
    const { api, popup, wrapper, isPlaying, currentTime } = mountLyricsWindowHarness(
      createPopupWindow(),
      undefined,
      {
        getLyricsPlaybackState: getState,
        subscribeLyricsPlayback: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    )
    const notify = () => listeners.forEach((listener) => listener())
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        lines: [
          { time: 0, text: 'First' },
          { time: 1, text: 'Second' },
          { time: 2, text: 'Third' },
        ],
      })
      isPlaying.value = true
      await nextTick()
      runPopupFrames(popup, 1)
      expect(popup.setTimeout).toHaveBeenCalledWith(expect.any(Function), 400)
      vi.mocked(popup.requestAnimationFrame).mockClear()
      await vi.advanceTimersByTimeAsync(200)
      expect(popup.requestAnimationFrame).not.toHaveBeenCalled()
      state.timeSeconds = 1.01
      await vi.advanceTimersByTimeAsync(200)
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('Second')
      expect(currentTime.value).toBe(0)
      runPopupFrames(popup, 1)
      state.playing = false
      notify()
      getState.mockClear()
      await vi.advanceTimersByTimeAsync(3000)
      expect(getState).not.toHaveBeenCalled()
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('Second')
      state.timeSeconds = 0.1
      state.seeking = true
      notify()
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('First')
      state.seeking = false
      state.playing = true
      state.playbackRate = 0.5
      notify()
      expect(popup.setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 1000)
      Object.defineProperty(popup.document, 'hidden', { configurable: true, value: true })
      popup.document.dispatchEvent(new Event('visibilitychange'))
      runPopupFrames(popup, 1)
      getState.mockClear()
      state.timeSeconds = 2.1
      notify()
      await vi.advanceTimersByTimeAsync(2000)
      expect(getState).not.toHaveBeenCalled()
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('First')
      Object.defineProperty(popup.document, 'hidden', { configurable: true, value: false })
      popup.document.dispatchEvent(new Event('visibilitychange'))
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('Third')
      await api.toggleLyricsWindow()
      getState.mockClear()
      state.timeSeconds = 2.1
      notify()
      currentTime.value = 2.1
      await nextTick()
      expect(getState).not.toHaveBeenCalled()
      const reopened = createPopupWindow()
      vi.mocked(window.open).mockReturnValueOnce(reopened)
      await api.toggleLyricsWindow()
      expect(reopened.document.querySelector('.line.active')?.textContent).toBe('Third')
    } finally {
      Reflect.deleteProperty(document, 'hidden')
      wrapper.unmount()
    }
    expect(listeners.size).toBe(0)
  })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(supportsDocumentPictureInPicture).mockReturnValue(false)
  })

  afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('observes real popup slots and lifecycle only while diagnostics are enabled', async () => {
    const { api, popup, wrapper, debugEnabled, isPlaying, currentTime, track } =
      mountLyricsWindowHarness()
    try {
      expect(api.debugSnapshot.value).toBeNull()
      debugEnabled.value = true
      await nextTick()
      await vi.advanceTimersByTimeAsync(0)
      expect(api.debugSnapshot.value).toMatchObject({
        open: false,
        kind: null,
        nodesReady: false,
        lifecycle: [],
      })
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        source: 'netease',
        activeIndex: 0,
        lines: [{ time: 0, text: 'word', words: [{ time: 0, duration: 5, text: 'word' }] }],
      })
      isPlaying.value = true
      currentTime.value = 1
      await nextTick()
      await vi.advanceTimersByTimeAsync(200)
      expect(api.debugSnapshot.value).toMatchObject({
        open: true,
        opening: false,
        kind: 'popup',
        width: 430,
        height: 600,
        nodesReady: true,
        mountedLineCount: 1,
        activeSlots: [0],
        karaokeRunning: true,
        animatedWordCount: 1,
        source: 'netease',
        mediaSeconds: 1,
      })
      expect(api.debugSnapshot.value?.lifecycle.map((entry) => entry.event)).toEqual([
        'opening',
        'opened',
      ])
      track.id = 'track-2'
      api.setSnapshot({ status: 'loading', activeIndex: -1, lines: [] })
      await nextTick()
      await vi.advanceTimersByTimeAsync(200)
      expect(api.debugSnapshot.value).toMatchObject({
        trackId: 'track-2',
        status: 'loading',
        source: null,
        mountedLineCount: 0,
        activeSlots: [],
        animatedWordCount: 0,
        karaokeRunning: false,
      })
      await api.toggleLyricsWindow()
      await vi.advanceTimersByTimeAsync(200)
      expect(api.debugSnapshot.value).toMatchObject({ open: false, kind: null, nodesReady: false })
      expect(api.debugSnapshot.value?.lifecycle.at(-1)?.event).toBe('closed')
      expect(popup.close).toHaveBeenCalled()
      debugEnabled.value = false
      await nextTick()
      expect(api.debugSnapshot.value).toBeNull()
      currentTime.value = 10
      await nextTick()
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.debugSnapshot.value).toBeNull()
    } finally {
      wrapper.unmount()
    }
  })

  it('reports blocked windows without changing the failure and bounds debug history', async () => {
    const { api, wrapper, debugEnabled } = mountLyricsWindowHarness()
    try {
      vi.mocked(window.open).mockReturnValue(null)
      debugEnabled.value = true
      await nextTick()
      for (let attempt = 0; attempt < 10; attempt += 1)
        await expect(api.toggleLyricsWindow()).rejects.toThrow('Lyrics window was blocked')
      await vi.advanceTimersByTimeAsync(200)
      expect(api.debugSnapshot.value).toMatchObject({
        open: false,
        opening: false,
        kind: null,
        nodesReady: false,
        lastFailure: '浏览器阻止了歌词小窗',
      })
      expect(api.debugSnapshot.value?.lifecycle).toHaveLength(12)
      expect(api.debugSnapshot.value?.lifecycle.at(-1)?.event).toBe('failed')
      wrapper.unmount()
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.debugSnapshot.value).toBeNull()
    } finally {
      wrapper.unmount()
    }
  })

  it('identifies document PiP and cleans up a window whose document could not be created', async () => {
    const { api, popup, wrapper, debugEnabled } = mountLyricsWindowHarness()
    try {
      debugEnabled.value = true
      await nextTick()
      vi.mocked(supportsDocumentPictureInPicture).mockReturnValue(true)
      vi.stubGlobal('documentPictureInPicture', { requestWindow: vi.fn(async () => popup) })
      await api.toggleLyricsWindow()
      await vi.advanceTimersByTimeAsync(200)
      expect(api.debugSnapshot.value).toMatchObject({ open: true, kind: 'document-pip' })
      await api.toggleLyricsWindow()
      const broken = createPopupWindow()
      vi.stubGlobal('documentPictureInPicture', { requestWindow: vi.fn(async () => broken) })
      vi.spyOn(broken.document, 'write').mockImplementation(() => {
        throw new Error('write failed')
      })
      await expect(api.toggleLyricsWindow()).rejects.toThrow(
        'Failed to write lyrics window document',
      )
      await vi.advanceTimersByTimeAsync(200)
      expect(broken.close).toHaveBeenCalled()
      expect(api.debugSnapshot.value).toMatchObject({
        open: false,
        nodesReady: false,
        lastFailure: '无法写入歌词小窗内容',
      })
    } finally {
      wrapper.unmount()
    }
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

  it('refreshes hidden track and lyric changes immediately on visibility restoration while paused', async () => {
    const { api, popup, track, wrapper, currentTime } = mountLyricsWindowHarness()
    try {
      await api.toggleLyricsWindow()
      currentTime.value = 2
      await nextTick()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        activeIndices: [0],
        lines: [{ time: 0, endTime: 5, text: 'Old line' }],
      })
      Object.defineProperty(popup.document, 'hidden', { configurable: true, value: true })
      popup.document.dispatchEvent(new Event('visibilitychange'))
      Object.assign(track, { id: 'track-2', title: 'New song', artist: 'New artist' })
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        activeIndices: [0],
        lines: [
          {
            time: 0,
            endTime: 5,
            text: 'New line',
            words: [{ time: 0, duration: 5, text: 'New line' }],
          },
        ],
      })
      await nextTick()
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('Old line')
      Object.defineProperty(popup.document, 'hidden', { configurable: true, value: false })
      popup.document.dispatchEvent(new Event('visibilitychange'))
      expect(popup.document.querySelector('h1')?.textContent).toBe('New song')
      expect(popup.document.querySelector('header p')?.textContent).toBe('New artist')
      expect(popup.document.querySelector('.line.active .main')?.textContent).toBe('New line')
      expect(
        Number(
          popup.document
            .querySelector<HTMLElement>('.line.active .word')!
            .style.getPropertyValue('--w'),
        ),
      ).toBeGreaterThan(0)

      Object.defineProperty(popup.document, 'hidden', { configurable: true, value: true })
      popup.document.dispatchEvent(new Event('visibilitychange'))
      api.setSnapshot({ status: 'error', activeIndex: -1, lines: [] })
      Object.defineProperty(popup.document, 'hidden', { configurable: true, value: false })
      popup.document.dispatchEvent(new Event('visibilitychange'))
      expect(popup.document.querySelector('.state')?.textContent).toBe('歌词载入失败')
      expect(popup.document.querySelectorAll('.line')).toHaveLength(0)
    } finally {
      wrapper.unmount()
    }
  })

  it('renders, updates and removes romanization between original lyrics and translation', async () => {
    const { api, popup, wrapper } = mountLyricsWindowHarness()
    try {
      await api.toggleLyricsWindow()
      const show = (roman?: string) =>
        api.setSnapshot({
          status: 'ready',
          activeIndex: 0,
          lines: [{ time: 0, text: '原文', translation: 'Translation', roman }],
        })
      show()
      show('genbun')
      const line = popup.document.querySelector('.line')!
      expect([...line.children].map((node) => node.className)).toEqual([
        'main',
        'roman',
        'translation',
      ])
      const romanNode = line.querySelector('.roman')!
      expect(romanNode.textContent).toBe('genbun')
      show('gen bun')
      expect(line.querySelector('.roman')).toBe(romanNode)
      expect(romanNode.textContent).toBe('gen bun')
      show()
      expect(line.querySelector('.roman')).toBeNull()
      expect(line.querySelector('.translation')?.textContent).toBe('Translation')
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps romanization bound to the correct lyric when popup slots are reused in either direction', async () => {
    const { api, popup, wrapper } = mountLyricsWindowHarness()
    try {
      await api.toggleLyricsWindow()
      const lines = Array.from({ length: 12 }, (_, index) => ({
        time: index,
        text: `Line ${index}`,
        roman: index % 2 ? `Roman ${index}` : undefined,
        translation: `Translation ${index}`,
      }))
      for (const activeIndex of [0, 3, 8, 1, 11]) {
        api.setSnapshot({ status: 'ready', activeIndex, lines })
        for (const node of popup.document.querySelectorAll<HTMLElement>('.line')) {
          const index = Number(node.dataset.index)
          expect(node.querySelector('.main')?.textContent).toBe(`Line ${index}`)
          expect(node.querySelector('.roman')?.textContent).toBe(
            index % 2 ? `Roman ${index}` : undefined,
          )
          expect(node.querySelector('.translation')?.textContent).toBe(`Translation ${index}`)
        }
      }
    } finally {
      wrapper.unmount()
    }
  })

  it('treats track metadata, syllables, romanization and translations as text', async () => {
    const { api, popup, track, wrapper } = mountLyricsWindowHarness()
    try {
      const markup = '<img src=x onerror="alert(1)"><script>alert(2)</script>'
      Object.assign(track, { title: markup, artist: markup })
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        lines: [
          {
            time: 0,
            text: markup,
            roman: markup,
            translation: markup,
            words: [{ time: 0, duration: 1, text: markup }],
          },
        ],
      })
      expect(popup.document.querySelector('h1')?.textContent).toBe(markup)
      expect(popup.document.querySelector('header p')?.textContent).toBe(markup)
      for (const selector of ['.word', '.roman', '.translation']) {
        expect(popup.document.querySelector(selector)?.textContent).toBe(markup)
      }
      expect(
        popup.document.querySelector('h1 img,header p img,.lyrics-lines img,script'),
      ).toBeNull()
    } finally {
      wrapper.unmount()
    }
  })

  it('closes a popup that is still opening when the composable unmounts', async () => {
    const popup = createPopupWindow('loading')
    const { api, wrapper, debugEnabled } = mountLyricsWindowHarness(popup)
    debugEnabled.value = true

    const opening = api.toggleLyricsWindow()
    await nextTick()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.debugSnapshot.value).toMatchObject({
      opening: true,
      open: false,
      kind: 'popup',
      nodesReady: false,
    })
    wrapper.unmount()
    await vi.runOnlyPendingTimersAsync()
    await opening

    expect(popup.close).toHaveBeenCalled()
    expect(api.debugSnapshot.value).toBeNull()
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
    let containerReads = 0
    Object.defineProperty(viewport, 'clientHeight', { get: () => height })
    for (const node of container.children) {
      Object.defineProperty(node, 'offsetHeight', {
        get: () => (node.querySelector('.translation') ? 100 : 40),
      })
    }
    Object.defineProperty(container, 'offsetHeight', {
      get: () => {
        containerReads += 1
        return [...container.children].reduce(
          (total, node) =>
            total +
            ((node as HTMLElement).hidden ? 0 : node.querySelector('.translation') ? 100 : 40),
          0,
        )
      },
    })
    runPopupFrames(popup, 1)
    expect(containerReads).toBe(1)
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
    expect(containerReads).toBe(2)
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

  it.each([
    'starts a harmony',
    'ends a harmony',
    'upgrades lyrics',
    'coalesces same-frame updates',
  ])('continues from the visible position when the same anchor %s mid-scroll', async (change) => {
    const lines: LyricLine[] = Array.from({ length: 100 }, (_, index) => ({
      time: index,
      endTime: index + 1,
      text: `Line ${index}`,
      words: [{ time: index, duration: 1, text: `Line ${index}` }],
    }))
    lines[2] = {
      ...lines[2]!,
      endTime: 4,
      words: [{ time: 2, duration: 2, text: 'Line 2' }],
    }
    lines[3] = {
      ...lines[3]!,
      time: 2.1,
      endTime: 2.3,
      background: true,
      words: [{ time: 2.1, duration: 0.2, text: 'Line 3' }],
    }
    const { api, popup, animate, setDrift, wrapper } = await mountScrollingHarness(lines)
    try {
      api.setSnapshot({
        status: 'ready',
        activeIndex: 2,
        activeIndices: change === 'ends a harmony' ? [2, 3] : [2],
        lines,
      })
      runPopupFrames(popup, 1)
      setDrift(20)
      animate.mockClear()

      api.setSnapshot({
        status: 'ready',
        activeIndex: 2,
        activeIndices:
          change === 'starts a harmony' || change === 'coalesces same-frame updates' ? [2, 3] : [2],
        lines:
          change === 'upgrades lyrics'
            ? lines.map((line) => ({ ...line, translation: 'Translation' }))
            : lines,
      })
      if (change === 'coalesces same-frame updates') {
        const translated = lines.map((line) => ({ ...line, translation: 'Translation' }))
        api.setSnapshot({
          status: 'ready',
          activeIndex: 2,
          activeIndices: [2, 3],
          lines: translated,
        })
        api.setSnapshot({
          status: 'ready',
          activeIndex: 2,
          activeIndices: [2],
          lines: translated,
        })
      }
      expect(animate).not.toHaveBeenCalled()
      runPopupFrames(popup, 1)

      expect(animate).toHaveBeenCalledTimes(1)
      expect(animate).toHaveBeenCalledWith(
        [{ transform: 'translateY(20px)' }, { transform: 'translateY(0)' }],
        { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' },
      )
      expect(popup.document.querySelector('.line.active')?.getAttribute('data-index')).toBe('2')
    } finally {
      wrapper.unmount()
    }
  })

  it('does not restart scrolling or lose karaoke bindings for an unchanged snapshot', async () => {
    const {
      api,
      debugEnabled,
      popup,
      show,
      animate,
      animations,
      currentTime,
      lyricAnimation,
      wrapper,
    } = await mountScrollingHarness()
    debugEnabled.value = true
    await nextTick()
    show(2)
    runPopupFrames(popup, 1)
    await vi.advanceTimersByTimeAsync(200)
    expect(api.debugSnapshot.value?.scrollAnimationCount).toBe(1)
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
    await vi.advanceTimersByTimeAsync(200)
    expect(api.debugSnapshot.value).toMatchObject({
      scrollAnimationCount: 0,
      animatedWordCount: 0,
      animationEnabled: false,
    })
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
    expect(words[0]?.style.getPropertyValue('--lyric-word-rise')).toBe('0.875')
    expect(words[1]?.style.getPropertyValue('--lyric-word-rise')).toBe('0.000')

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
    expect(word.style.getPropertyValue('--lyric-word-rise')).toBe('')

    lyricAnimation.value = true
    await nextTick()
    expect(word.style.getPropertyValue('--w')).toBe('0.500')
    expect(word.style.getPropertyValue('--lyric-word-rise')).toBe('0.875')
  })

  it('continues independent word rise through a short held gap and releases it when the next phrase starts', async () => {
    let mediaSeconds = 0.1
    const { api, popup, wrapper, isPlaying } = mountLyricsWindowHarness(
      createPopupWindow(),
      () => mediaSeconds,
    )
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        lines: [
          {
            time: 0,
            endTime: 0.25,
            text: 'Short',
            words: [{ time: 0, duration: 0.25, text: 'Short' }],
          },
          { time: 3, endTime: 4, text: 'Next' },
        ],
      })
      isPlaying.value = true
      await nextTick()
      const word = popup.document.querySelector<HTMLElement>('.line.active .word')!
      mediaSeconds = 0.3
      runPopupFrames(popup, 1)
      expect(word.closest('.line')?.classList.contains('active')).toBe(true)
      expect(word.style.getPropertyValue('--w')).toBe('1.000')
      expect(word.style.getPropertyValue('--lyric-word-rise')).toBe('0.657')
      mediaSeconds = 0.7
      runPopupFrames(popup, 1)
      expect(word.style.getPropertyValue('--lyric-word-rise')).toBe('0.973')
      mediaSeconds = 3.1
      runPopupFrames(popup, 1)
      expect(word.style.getPropertyValue('--lyric-word-rise')).toBe('')
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('Next')
    } finally {
      wrapper.unmount()
    }
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

  it('changes plain lyric lines from the popup media clock while the main page stays stale', async () => {
    let mediaSeconds = 0
    const { api, popup, wrapper, isPlaying, currentTime, lyricAnimation } =
      mountLyricsWindowHarness(createPopupWindow(), () => mediaSeconds)
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        lines: [
          { time: 0, text: 'First' },
          { time: 1, text: 'Second' },
          { time: 2, text: 'Third' },
        ],
      })
      isPlaying.value = true
      await nextTick()
      lyricAnimation.value = false
      await nextTick()
      mediaSeconds = 1.1
      await vi.advanceTimersByTimeAsync(1000)
      runPopupFrames(popup, 2)
      expect(currentTime.value).toBe(0)
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('Second')
      const second = popup.document.querySelector('.line.active')
      // A stalled media clock must not keep extrapolating or rebuild unchanged rows.
      runPopupFrames(popup, 150)
      expect(popup.document.querySelector('.line.active')).toBe(second)
      mediaSeconds = 2.1
      await vi.advanceTimersByTimeAsync(1000)
      runPopupFrames(popup, 2)
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('Third')
      isPlaying.value = false
      await nextTick()
      mediaSeconds = 0.5
      currentTime.value = 0.5
      await nextTick()
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('First')
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps short-gap lyrics highlighted, dims the final boundary, and restores them after seeking back', async () => {
    let mediaSeconds = 0.25
    const { api, popup, wrapper, currentTime } = mountLyricsWindowHarness(
      createPopupWindow(),
      () => mediaSeconds,
    )
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        lines: [
          { time: 0, endTime: 1, text: 'First' },
          { time: 3, endTime: 4, text: 'Last' },
        ],
      })
      const seek = async (time: number) => {
        mediaSeconds = time
        currentTime.value = time
        await nextTick()
      }
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('First')
      await seek(1)
      expect(popup.document.querySelector('.line.active.focused')?.textContent).toBe('First')
      expect(popup.document.querySelector('.line.after')?.textContent).toBe('Last')
      await seek(3.5)
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('Last')
      await seek(4)
      expect(popup.document.querySelectorAll('.line.before')).toHaveLength(2)
      expect(popup.document.querySelector('.line.before.focused')?.textContent).toBe('Last')
      const viewport = popup.document.querySelector<HTMLElement>('.lyrics')!
      const container = popup.document.querySelector<HTMLElement>('.lyrics-lines')!
      Object.defineProperty(viewport, 'clientHeight', { value: 40 })
      Object.defineProperty(container, 'offsetHeight', { value: 80 })
      for (const node of container.children)
        Object.defineProperty(node, 'offsetHeight', { value: 40 })
      runPopupFrames(popup, 1)
      expect(container.querySelector<HTMLElement>('.focused')?.hidden).toBe(false)
      expect(container.querySelector<HTMLElement>('[data-index="0"]')?.hidden).toBe(true)
      await seek(0.5)
      expect(popup.document.querySelector('.line.active')?.textContent).toBe('First')
      expect(popup.document.querySelector('.line.after')?.textContent).toBe('Last')
    } finally {
      wrapper.unmount()
    }
  })

  it('dims a finished duet while its lead keeps singing and completed harmonies and future rows stay distinct', async () => {
    let mediaSeconds = 1.25
    const { api, popup, wrapper, currentTime } = mountLyricsWindowHarness(
      createPopupWindow(),
      () => mediaSeconds,
    )
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 2,
        lines: [
          { time: 8, endTime: 9, text: 'Future' },
          { time: 0, endTime: 4, text: 'Lead' },
          { time: 0, endTime: 2, text: 'Duet', agent: 'secondary' },
          { time: 1, endTime: 1.5, text: 'Harmony', background: true },
        ],
      })
      mediaSeconds = 2.25
      currentTime.value = mediaSeconds
      await nextTick()
      expect(
        [...popup.document.querySelectorAll('.line.active')].map((node) => node.textContent),
      ).toEqual(['Lead'])
      expect(popup.document.querySelector('.line.after')?.textContent).toBe('Future')
      expect(
        [...popup.document.querySelectorAll('.line.before')].map((node) => node.textContent),
      ).toEqual(['Duet', 'Harmony'])
      mediaSeconds = 1.25
      currentTime.value = mediaSeconds
      await nextTick()
      expect(popup.document.querySelectorAll('.line.before')).toHaveLength(0)
      expect(popup.document.querySelectorAll('.line.active')).toHaveLength(3)
    } finally {
      wrapper.unmount()
    }
  })

  it('releases an ended native line from its own media clock despite a stale parent snapshot', async () => {
    let mediaSeconds = 1.5
    const { api, popup, wrapper, isPlaying, currentTime } = mountLyricsWindowHarness(
      createPopupWindow(),
      () => mediaSeconds,
    )
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        activeIndices: [0],
        lines: [
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
        ],
      })
      isPlaying.value = true
      await nextTick()
      const row = (index: number) =>
        popup.document.querySelector<HTMLElement>(`.line[data-index="${index}"]`)!
      const firstWord = row(0).querySelector<HTMLElement>('.word')!
      const assertHandoff = () => {
        expect(row(0).classList.contains('before')).toBe(true)
        expect(row(0).classList.contains('active')).toBe(false)
        expect(row(1).classList.contains('active')).toBe(true)
        expect(row(1).classList.contains('focused')).toBe(true)
        expect(popup.document.querySelectorAll('.line.active')).toHaveLength(1)
        for (const property of ['--w', '--e', '--lyric-word-rise'])
          expect(firstWord.style.getPropertyValue(property)).toBe('')
        expect(row(1).querySelector<HTMLElement>('.word')?.style.getPropertyValue('--w')).not.toBe(
          '',
        )
      }

      mediaSeconds = 2
      runPopupFrames(popup, 1)
      expect(
        [...popup.document.querySelectorAll('.line.active')].map((line) => line.textContent),
      ).toEqual(['First', 'Second'])
      expect(firstWord.style.getPropertyValue('--w')).not.toBe('')

      mediaSeconds = 2.01
      runPopupFrames(popup, 1)
      assertHandoff()
      mediaSeconds = 2.02
      runPopupFrames(popup, 1)
      assertHandoff()
      expect(currentTime.value).toBe(0)

      mediaSeconds = 1.5
      currentTime.value = mediaSeconds
      await nextTick()
      expect(row(0).classList.contains('active')).toBe(true)
      expect(row(0).classList.contains('before')).toBe(false)
      expect(row(1).classList.contains('active')).toBe(false)
      expect(firstWord.style.getPropertyValue('--w')).not.toBe('')
      mediaSeconds = 2.02
      runPopupFrames(popup, 1)
      assertHandoff()
      expect(currentTime.value).toBe(1.5)
    } finally {
      wrapper.unmount()
    }
  })

  it('updates word progress without rerendering the completed-state layout inside one timing interval', async () => {
    let mediaSeconds = 0.25
    const { api, popup, wrapper, isPlaying } = mountLyricsWindowHarness(
      createPopupWindow(),
      () => mediaSeconds,
    )
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        lines: [
          { time: 0, endTime: 5, text: 'Long', words: [{ time: 0, duration: 5, text: 'Long' }] },
          { time: 6, endTime: 7, text: 'Next' },
        ],
      })
      isPlaying.value = true
      await nextTick()
      runPopupFrames(popup, 1)
      const coverReads = vi.spyOn(popup.document.querySelector('.cover')!, 'getAttribute')
      const word = popup.document.querySelector<HTMLElement>('.line.active .word')!
      const initialFill = Number(word.style.getPropertyValue('--w'))
      for (let frame = 0; frame < 30; frame += 1) {
        mediaSeconds += 0.016
        runPopupFrames(popup, 1)
      }
      expect(Number(word.style.getPropertyValue('--w'))).toBeGreaterThan(initialFill)
      expect(coverReads).not.toHaveBeenCalled()
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps independently timed duet and harmony groups together across seeks and source upgrades', async () => {
    let mediaSeconds = 0
    const { api, popup, wrapper, isPlaying } = mountLyricsWindowHarness(
      createPopupWindow(),
      () => mediaSeconds,
    )
    try {
      await api.toggleLyricsWindow()
      const lines = [
        { time: 0, endTime: 1, text: 'Intro' },
        { time: 1, endTime: 3, text: 'Lead' },
        { time: 1, endTime: 3, text: 'Duet', agent: 'secondary' as const },
        { time: 1.5, endTime: 2, text: 'Harmony', background: true },
      ]
      api.setSnapshot({ status: 'ready', activeIndex: 0, lines })
      isPlaying.value = true
      await nextTick()
      mediaSeconds = 1.6
      await vi.advanceTimersByTimeAsync(1000)
      runPopupFrames(popup, 2)
      expect(
        [...popup.document.querySelectorAll('.line.active')].map((node) => node.textContent),
      ).toEqual(['Lead', 'Duet', 'Harmony'])
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        lines: lines.map((line) => ({ ...line, translation: 'Translation' })),
      })
      expect(popup.document.querySelectorAll('.line.active')).toHaveLength(3)
      mediaSeconds = 2.1
      await vi.advanceTimersByTimeAsync(1000)
      runPopupFrames(popup, 2)
      expect(popup.document.querySelectorAll('.line.active')).toHaveLength(2)
      mediaSeconds = 0.2
      await vi.advanceTimersByTimeAsync(1000)
      runPopupFrames(popup, 2)
      expect(popup.document.querySelector('.line.active .main')?.textContent).toBe('Intro')
    } finally {
      wrapper.unmount()
    }
  })

  it('shows intro and interlude dots from media time, including paused starts and reverse seeks', async () => {
    const state: LyricPlaybackState = {
      timeSeconds: 0,
      playing: false,
      playbackRate: 1,
      seeking: false,
    }
    const listeners = new Set<() => void>()
    const { api, popup, wrapper, currentTime } = mountLyricsWindowHarness(
      createPopupWindow(),
      undefined,
      {
        getLyricsPlaybackState: () => state,
        subscribeLyricsPlayback: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    )
    const seek = (time: number) => {
      state.timeSeconds = time
      state.seeking = true
      listeners.forEach((listener) => listener())
      state.seeking = false
      listeners.forEach((listener) => listener())
    }
    const waiting = () => popup.document.querySelector<HTMLElement>('.waiting-row')
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: -1,
        lines: [
          { time: 4, endTime: 5, text: 'First' },
          { time: 14, endTime: 15, text: 'Last', agent: 'secondary' },
        ],
      })
      expect(waiting()?.getAttribute('aria-label')).toBe('前奏')
      expect(waiting()?.style.visibility).toBe('hidden')
      runPopupFrames(popup, 1)
      expect(waiting()?.style.visibility).toBe('visible')
      expect(
        waiting()?.querySelector<HTMLElement>('.lyrics-waiting-indicator')?.style.opacity,
      ).toBe('1')
      expect(
        [...waiting()!.querySelectorAll<HTMLElement>('.waiting-dot')].map(
          (dot) => dot.style.opacity,
        ),
      ).toEqual(['0.65', '0.65', '0.65'])
      expect(waiting()?.nextElementSibling?.textContent).toBe('First')
      seek(4)
      expect(waiting()).toBeNull()
      expect(popup.document.querySelector('.active')?.textContent).toBe('First')
      seek(5)
      expect(waiting()?.getAttribute('aria-label')).toBe('间奏')
      expect(waiting()?.classList.contains('secondary')).toBe(true)
      expect(waiting()?.nextElementSibling?.textContent).toBe('Last')
      expect(popup.document.querySelectorAll('.active')).toHaveLength(0)
      const row = waiting()
      seek(9)
      expect(waiting()).toBe(row)
      seek(14)
      expect(waiting()).toBeNull()
      expect(popup.document.querySelector('.active')?.textContent).toBe('Last')
      seek(15)
      expect(waiting()).toBeNull()
      expect(popup.document.querySelectorAll('.active')).toHaveLength(0)
      seek(2)
      expect(waiting()?.getAttribute('aria-label')).toBe('前奏')
      expect(currentTime.value).toBe(0)
      api.setSnapshot({ status: 'loading', activeIndex: -1, lines: [] })
      expect(waiting()).toBeNull()
    } finally {
      wrapper.unmount()
    }
  })

  it('advances waiting styles without rebuilding or measuring rows, then freezes and restores on visibility changes', async () => {
    const state: LyricPlaybackState = {
      timeSeconds: 1,
      playing: true,
      playbackRate: 1,
      seeking: false,
    }
    const getState = vi.fn(() => state)
    const listeners = new Set<() => void>()
    const { api, popup, wrapper, currentTime } = mountLyricsWindowHarness(
      createPopupWindow(),
      undefined,
      {
        getLyricsPlaybackState: getState,
        subscribeLyricsPlayback: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    )
    const notify = () => listeners.forEach((listener) => listener())
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: -1,
        lines: [{ time: 12, endTime: 13, text: 'First' }],
      })
      runPopupFrames(popup, 1)
      const container = popup.document.querySelector<HTMLElement>('.lyrics-lines')!
      const indicator = container.querySelector<HTMLElement>('.lyrics-waiting-indicator')!
      const firstDot = indicator.firstElementChild as HTMLElement
      const initialOpacity = firstDot.style.opacity
      const line = container.querySelector<HTMLElement>('.line')!
      const geometry = vi.spyOn(line, 'getBoundingClientRect')
      const insertions = vi.spyOn(container, 'insertBefore')
      const coverReads = vi.spyOn(popup.document.querySelector('.cover')!, 'getAttribute')
      for (let frame = 0; frame < 30; frame += 1) {
        state.timeSeconds += 0.016
        runPopupFrames(popup, 1)
      }
      expect(Number(firstDot.style.opacity)).toBeGreaterThan(Number(initialOpacity))
      expect(container.querySelector('.line')).toBe(line)
      expect(geometry).not.toHaveBeenCalled()
      expect(insertions).not.toHaveBeenCalled()
      expect(coverReads).not.toHaveBeenCalled()
      const viewport = container.parentElement!
      const beforeDetach = indicator.outerHTML
      container.remove()
      state.timeSeconds += 0.1
      runPopupFrames(popup, 1)
      expect(indicator.outerHTML).toBe(beforeDetach)
      viewport.append(container)
      state.timeSeconds += 0.1
      runPopupFrames(popup, 1)
      expect(indicator.outerHTML).not.toBe(beforeDetach)
      state.playing = false
      notify()
      runPopupFrames(popup, 1)
      const frozen = indicator.outerHTML
      getState.mockClear()
      vi.mocked(popup.requestAnimationFrame).mockClear()
      runPopupFrames(popup, 20)
      expect(getState).not.toHaveBeenCalled()
      expect(popup.requestAnimationFrame).not.toHaveBeenCalled()
      expect(indicator.outerHTML).toBe(frozen)
      Object.defineProperty(popup.document, 'hidden', { configurable: true, value: true })
      popup.document.dispatchEvent(new Event('visibilitychange'))
      state.timeSeconds = 8
      notify()
      expect(indicator.outerHTML).toBe(frozen)
      Object.defineProperty(popup.document, 'hidden', { configurable: true, value: false })
      popup.document.dispatchEvent(new Event('visibilitychange'))
      expect(indicator.outerHTML).not.toBe(frozen)
      expect(currentTime.value).toBe(0)
      state.playing = true
      notify()
      state.timeSeconds = 12
      runPopupFrames(popup, 1)
      expect(container.querySelector('.waiting-row')).toBeNull()
      expect(container.querySelector('.active')?.textContent).toBe('First')
    } finally {
      wrapper.unmount()
    }
    expect(listeners.size).toBe(0)
  })

  it.each(['disabled', 'reduced'] as const)(
    'uses static waiting dots and boundary timers when motion is %s',
    async (mode) => {
      let mediaSeconds = 0
      const popup = createPopupWindow()
      if (mode === 'reduced') {
        popup.matchMedia = vi.fn(() => ({ ...window.matchMedia(''), matches: true }))
      }
      const { api, wrapper, isPlaying, lyricAnimation } = mountLyricsWindowHarness(
        popup,
        () => mediaSeconds,
      )
      try {
        lyricAnimation.value = mode !== 'disabled'
        isPlaying.value = true
        await nextTick()
        await api.toggleLyricsWindow()
        api.setSnapshot({
          status: 'ready',
          activeIndex: -1,
          lines: [
            { time: 4, endTime: 5, text: 'First' },
            { time: 14, endTime: 15, text: 'Last' },
          ],
        })
        runPopupFrames(popup, 1)
        const dots = () =>
          [...popup.document.querySelectorAll<HTMLElement>('.waiting-dot')].map(
            (dot) => dot.style.opacity,
          )
        expect(dots()).toEqual(['0.65', '0.65', '0.65'])
        vi.mocked(popup.requestAnimationFrame).mockClear()
        mediaSeconds = 1
        await vi.advanceTimersByTimeAsync(1000)
        expect(popup.requestAnimationFrame).not.toHaveBeenCalled()
        expect(dots()).toEqual(['0.65', '0.65', '0.65'])
        mediaSeconds = 4
        await vi.advanceTimersByTimeAsync(1000)
        runPopupFrames(popup, 1)
        expect(popup.document.querySelector('.waiting-row')).toBeNull()
        mediaSeconds = 5
        await vi.advanceTimersByTimeAsync(1000)
        runPopupFrames(popup, 1)
        expect(popup.document.querySelector('.waiting-row')?.getAttribute('aria-label')).toBe(
          '间奏',
        )
        expect(dots()).toEqual(['0.65', '0.65', '0.65'])
        if (mode === 'disabled') {
          mediaSeconds = 7
          lyricAnimation.value = true
          await nextTick()
          const animatedDots = dots()
          expect(animatedDots).not.toEqual(['0.65', '0.65', '0.65'])
          mediaSeconds = 8
          runPopupFrames(popup, 1)
          expect(dots()).not.toEqual(animatedDots)
          lyricAnimation.value = false
          await nextTick()
          expect(dots()).toEqual(['0.65', '0.65', '0.65'])
        }
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('shares the lyric group FLIP when waiting enters or exits without changing the scene anchor', async () => {
    let mediaSeconds = 0.5
    const { api, popup, wrapper, currentTime } = mountLyricsWindowHarness(
      createPopupWindow(),
      () => mediaSeconds,
    )
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        lines: [
          { time: 0, endTime: 1, text: 'First' },
          { time: 10, endTime: 11, text: 'Next' },
          { time: 12, endTime: 13, text: 'Last' },
        ],
      })
      const container = popup.document.querySelector<HTMLElement>('.lyrics-lines')!
      runPopupFrames(popup, 1)
      const animate = vi.fn(() => ({ cancel: vi.fn(), onfinish: null }) as unknown as Animation)
      container.animate = animate
      for (const node of container.querySelectorAll<HTMLElement>('.line')) {
        vi.spyOn(node, 'getBoundingClientRect').mockImplementation(() => {
          const siblings = [...container.children]
          return new DOMRect(0, siblings.indexOf(node) * 60 - siblings.length * 30, 300, 60)
        })
      }
      mediaSeconds = 1
      currentTime.value = 1
      await nextTick()
      const waiting = container.querySelector<HTMLElement>('.waiting-row')!
      expect(waiting.style.visibility).toBe('hidden')
      expect(waiting.nextElementSibling?.classList.contains('focused')).toBe(true)
      expect(animate).not.toHaveBeenCalled()
      runPopupFrames(popup, 1)
      expect(waiting.style.visibility).toBe('visible')
      expect(animate).toHaveBeenCalledTimes(1)
      expect(animate).toHaveBeenLastCalledWith(
        [{ transform: 'translateY(-30px)' }, { transform: 'translateY(0)' }],
        { duration: 420, easing: 'cubic-bezier(.16,1,.3,1)' },
      )
      mediaSeconds = 2
      currentTime.value = 2
      await nextTick()
      runPopupFrames(popup, 1)
      expect(container.querySelector('.waiting-row')).toBe(waiting)
      expect(animate).toHaveBeenCalledTimes(1)
      mediaSeconds = 0.5
      currentTime.value = 0.5
      await nextTick()
      expect(waiting.parentNode).toBeNull()
      runPopupFrames(popup, 1)
      expect(animate).toHaveBeenCalledTimes(2)
      expect(container.querySelector('.active')?.textContent).toBe('First')
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps the waiting row and upcoming lyric together when the popup is too short for context', async () => {
    const { api, popup, wrapper } = mountLyricsWindowHarness(createPopupWindow(), () => 5)
    try {
      await api.toggleLyricsWindow()
      api.setSnapshot({
        status: 'ready',
        activeIndex: 0,
        lines: [
          { time: 0, endTime: 1, text: 'Previous' },
          { time: 10, endTime: 11, text: 'Next' },
          { time: 12, endTime: 13, text: 'Later' },
        ],
      })
      const viewport = popup.document.querySelector<HTMLElement>('.lyrics')!
      const container = popup.document.querySelector<HTMLElement>('.lyrics-lines')!
      Object.defineProperty(viewport, 'clientHeight', { value: 70 })
      for (const node of container.children) {
        Object.defineProperty(node, 'offsetHeight', {
          value: node.classList.contains('waiting-row') ? 20 : 50,
        })
      }
      Object.defineProperty(container, 'offsetHeight', {
        get: () =>
          [...container.children].reduce(
            (height, node) =>
              height + ((node as HTMLElement).hidden ? 0 : (node as HTMLElement).offsetHeight),
            0,
          ),
      })
      runPopupFrames(popup, 1)
      const visible = [...container.children].filter((node) => !(node as HTMLElement).hidden)
      expect(visible).toHaveLength(2)
      expect(visible[0]?.classList.contains('waiting-row')).toBe(true)
      expect((visible[0] as HTMLElement).style.visibility).toBe('visible')
      expect(visible[1]?.textContent).toBe('Next')
    } finally {
      wrapper.unmount()
    }
  })
})
