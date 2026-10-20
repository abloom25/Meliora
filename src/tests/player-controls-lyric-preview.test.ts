import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import PlayerControls from '../components/PlayerControls.vue'
import { usePlayerStore } from '../stores/player'
import type { LyricsSnapshot } from '../core/types'
import { createLyricWaitingTimeline, resolveLyricWaitingMotion } from '../core/lyrics'

const lyricPreview: LyricsSnapshot = {
  status: 'ready',
  activeIndex: 0,
  lines: [
    { time: 0, text: 'First line' },
    { time: 20, text: 'Second line', translation: '第二句' },
    { time: 40, text: 'Third line' },
  ],
}

// Apple Music 规格的 TTML:对唱双声部同时开唱、背景和声有自己的时间轴、逐字时间轴与罗马音。
// 进度条 40s / 100s 处 = clientX 80(轨道宽 200)
const advancedPreview: LyricsSnapshot = {
  status: 'ready',
  activeIndex: 1,
  lines: [
    { time: 0, endTime: 10, text: 'Opening line' },
    {
      time: 30,
      endTime: 50,
      text: 'main voice',
      agent: 'primary',
      roman: 'meinu boisu',
      translation: '主唱',
      wordSource: 'native',
      words: [
        { time: 30, duration: 10, text: 'main', trailingSpace: true },
        { time: 40, duration: 10, text: 'voice' },
      ],
    },
    { time: 30, endTime: 50, text: 'other voice', agent: 'secondary' },
    { time: 35, endTime: 45, text: 'ooh', background: true },
    { time: 60, endTime: 70, text: 'later line' },
  ],
}

const waitingPreview: LyricsSnapshot = {
  status: 'ready',
  activeIndex: -1,
  lines: [
    { time: 10, endTime: 20, text: 'First phrase' },
    { time: 40, endTime: 50, text: 'Second phrase', agent: 'secondary' },
    { time: 55, endTime: 60, text: 'Last phrase' },
  ],
}

function previewRows() {
  return [...document.body.querySelectorAll('.lyric-preview-row')].map((row) => ({
    text: row.querySelector('strong')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    secondary: row.classList.contains('secondary'),
    harmony: row.classList.contains('harmony'),
  }))
}

function dispatchPointerEvent(
  target: EventTarget,
  type: string,
  init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
) {
  const { pointerId = 1, pointerType = 'mouse', ...eventInit } = init
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...eventInit,
  })
  Object.defineProperty(event, 'pointerId', {
    value: pointerId,
  })
  Object.defineProperty(event, 'pointerType', {
    value: pointerType,
  })
  target.dispatchEvent(event)
}

function mountProgressControls(props: Partial<InstanceType<typeof PlayerControls>['$props']> = {}) {
  return mount(PlayerControls, {
    attachTo: document.body,
    props: {
      variant: 'progress',
      lyricPreview,
      onToggle: vi.fn(),
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onSeek: vi.fn(),
      ...props,
    },
  })
}

function mountPlayerControls(variant: 'bar' | 'page' | 'progress' | 'mini' | 'vertical') {
  return mount(PlayerControls, {
    attachTo: document.body,
    props: {
      variant,
      onToggle: vi.fn(),
      onPrevious: vi.fn(),
      onNext: vi.fn(),
      onSeek: vi.fn(),
    },
  })
}

function mockProgressRect(range: HTMLElement) {
  vi.spyOn(range, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 100,
    right: 200,
    bottom: 128,
    left: 0,
    width: 200,
    height: 28,
    toJSON: () => ({}),
  })
}

async function waitPreviewFrame() {
  await new Promise((resolve) => requestAnimationFrame(resolve))
  await nextTick()
}

describe('PlayerControls lyric preview', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('keeps the lyric preview disabled by default', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0

    const wrapper = mountProgressControls()

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 50,
      clientY: 120,
    })
    await waitPreviewFrame()

    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()

    wrapper.unmount()
  })

  it('shows the lyric at the hovered progress time when enabled', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls()

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 50,
      clientY: 120,
    })
    await waitPreviewFrame()

    const preview = document.body.querySelector('.lyric-preview-bubble')
    expect(preview?.textContent).toContain('0:25')
    expect(preview?.textContent).toContain('Second line')
    expect(preview?.textContent).toContain('第二句')

    dispatchPointerEvent(range.element, 'pointerleave', {})
    await nextTick()

    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()

    wrapper.unmount()
  })

  it('does not show a stale lyric preview after the pointer leaves before the next frame', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls()

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 50,
      clientY: 120,
    })
    dispatchPointerEvent(range.element, 'pointerleave', {})
    await waitPreviewFrame()

    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()

    wrapper.unmount()
  })

  it('shares one fresh track measurement per hover frame after the track moves', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.settings.progressLyricPreview = true
    const wrapper = mountProgressControls()
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)
    const measure = vi.mocked(range.element.getBoundingClientRect)

    dispatchPointerEvent(range.element, 'pointermove', { clientX: 50, clientY: 120 })
    await waitPreviewFrame()
    expect(measure).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('.lyric-preview-bubble')?.textContent).toContain('0:25')

    measure.mockClear()
    measure.mockReturnValue({
      x: 100,
      y: 200,
      top: 200,
      right: 500,
      bottom: 228,
      left: 100,
      width: 400,
      height: 28,
      toJSON: () => ({}),
    })
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 300, clientY: 214 })
    await waitPreviewFrame()
    const bubble = document.body.querySelector<HTMLElement>('.lyric-preview-bubble')
    expect(measure).toHaveBeenCalledTimes(1)
    expect(bubble?.textContent).toContain('0:50')
    expect(bubble?.style.translate).toBe('300px 174px')
    wrapper.unmount()
  })

  it('changes lyric preview scroll direction with pointer movement direction', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls()

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 50,
      clientY: 120,
    })
    await waitPreviewFrame()

    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 90,
      clientY: 120,
    })
    await waitPreviewFrame()

    const forwardPreview = document.body.querySelector('.lyric-preview-bubble')
    expect(forwardPreview?.classList.contains('scroll-forward')).toBe(true)

    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 20,
      clientY: 120,
    })
    await waitPreviewFrame()

    const backwardPreview = document.body.querySelector('.lyric-preview-bubble')
    expect(backwardPreview?.classList.contains('scroll-backward')).toBe(true)

    wrapper.unmount()
  })

  it('hides the lyric preview when preview is disabled externally', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls()

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 50,
      clientY: 120,
    })
    await waitPreviewFrame()
    expect(document.body.querySelector('.lyric-preview-bubble')).not.toBeNull()

    await wrapper.setProps({ previewEnabled: false })
    await nextTick()

    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()
    wrapper.unmount()
  })

  it('restores the lyric preview after lyrics become ready while still hovering', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls({ lyricPreview: null })

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 50,
      clientY: 120,
    })
    await waitPreviewFrame()
    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()

    await wrapper.setProps({ lyricPreview })
    await nextTick()

    const preview = document.body.querySelector('.lyric-preview-bubble')
    expect(preview?.textContent).toContain('Second line')
    wrapper.unmount()
  })

  it('keeps lyric preview bubbles hidden while dragging with touch input', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls()

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointerdown', {
      clientX: 50,
      clientY: 120,
      pointerType: 'touch',
    })
    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 80,
      clientY: 120,
      pointerType: 'touch',
    })
    await waitPreviewFrame()

    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()

    dispatchPointerEvent(range.element, 'pointercancel', {
      pointerType: 'touch',
    })
    wrapper.unmount()
  })

  it('shows both voices of a duet with its harmony line at the hovered moment', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls({ lyricPreview: advancedPreview })
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    // 40s:两个声部都在唱,和声(35–45s)也在
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 80, clientY: 120 })
    await waitPreviewFrame()

    expect(previewRows()).toEqual([
      { text: 'main voice', secondary: false, harmony: false },
      { text: 'other voice', secondary: true, harmony: false },
      { text: 'ooh', secondary: false, harmony: true },
    ])
    // 罗马音与译文一并显示
    const bubble = document.body.querySelector('.lyric-preview-bubble')
    expect(bubble?.querySelector('.lyric-preview-roman')?.textContent).toContain('meinu boisu')
    expect(bubble?.querySelector('.lyric-preview-translation')?.textContent).toContain('主唱')

    wrapper.unmount()
  })

  it('leaves out a harmony line whose sentence is not being sung', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls({ lyricPreview: advancedPreview })
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    // 65s:只剩最后一句,前面那句的和声不该跟过来
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 130, clientY: 120 })
    await waitPreviewFrame()

    expect(previewRows()).toEqual([{ text: 'later line', secondary: false, harmony: false }])
    wrapper.unmount()
  })

  it('renders a static karaoke snapshot of how far the line has been sung', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls({ lyricPreview: advancedPreview })
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    // 45s:第一个词唱完,第二个词唱到一半
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 90, clientY: 120 })
    await waitPreviewFrame()

    const words = [...document.body.querySelectorAll<HTMLElement>('.lyric-preview-word')]
    expect(words.map((word) => word.textContent)).toEqual(['main', 'voice'])
    expect(words[0]!.style.getPropertyValue('--lyric-word-fill')).toBe('1.000')
    expect(words[1]!.style.getPropertyValue('--lyric-word-fill')).toBe('0.500')
    // 唱完与没唱到的词都是实色,只有正在推进的那个才有柔化前沿
    expect(words[0]!.style.getPropertyValue('--lyric-word-edge')).toBe('0.000')
    expect(Number(words[1]!.style.getPropertyValue('--lyric-word-edge'))).toBeGreaterThan(0)
    // 音节之间要留一个可换行的空白节点
    expect(document.body.querySelectorAll('.lyric-preview-gap')).toHaveLength(1)

    wrapper.unmount()
  })

  it('replaces the completed line with waiting dots in a long instrumental gap', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls({ lyricPreview: advancedPreview })
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    // 20s:第一句 10s 就唱完了,下一句 30s 才开始
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 40, clientY: 120 })
    await waitPreviewFrame()

    const bubble = document.body.querySelector('.lyric-preview-bubble')
    expect(bubble?.classList.contains('held')).toBe(false)
    expect(bubble?.querySelectorAll('.waiting-dot')).toHaveLength(3)
    expect(previewRows()).toEqual([])

    // 正在唱的时刻不该被压暗
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 80, clientY: 120 })
    await waitPreviewFrame()
    expect(document.body.querySelector('.lyric-preview-bubble')?.classList.contains('held')).toBe(
      false,
    )
    expect(document.body.querySelector('.lyric-preview-waiting')).toBeNull()

    wrapper.unmount()
  })

  it('shows intro dots before any active lyric and uses hovered time independently of playback', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 45
    store.settings.progressLyricPreview = true
    store.settings.lyricAnimation = true
    const wrapper = mountProgressControls({ lyricPreview: waitingPreview })
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 0, clientY: 120 })
    await waitPreviewFrame()

    const indicator = document.body.querySelector<HTMLElement>('.lyrics-waiting-indicator')!
    expect(indicator).not.toBeNull()
    expect(indicator.style.opacity).toBe('1')
    expect(document.body.querySelector('.lyric-preview-time')?.textContent).toBe('0:00')
    expect(previewRows()).toEqual([])

    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const interval = createLyricWaitingTimeline(waitingPreview.lines).read(5)!.interval
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 10, clientY: 120 })
    await waitPreviewFrame()
    const expected = resolveLyricWaitingMotion(5, interval)
    expect(document.body.querySelector('.lyrics-waiting-indicator')).toBe(indicator)
    expect(Number(indicator.style.scale)).toBeCloseTo(expected.scale, 4)
    expect(
      [...indicator.children].map((dot) => Number((dot as HTMLElement).style.opacity)),
    ).toEqual(expected.dotOpacities.map((opacity) => Number(opacity.toFixed(3))))
    // 一次指针更新与测试等待各调用一次 RAF；指针停住不启动呼吸计时器。
    expect(raf).toHaveBeenCalledTimes(2)
    const frozen = indicator.outerHTML
    store.currentTime = 56
    store.isPlaying = true
    await nextTick()
    expect(indicator.outerHTML).toBe(frozen)
    expect(raf).toHaveBeenCalledTimes(2)

    dispatchPointerEvent(range.element, 'pointermove', { clientX: 20, clientY: 120 })
    await waitPreviewFrame()
    expect(document.body.querySelector('.lyric-preview-waiting')).toBeNull()
    expect(previewRows().map((row) => row.text)).toEqual(['First phrase'])
    wrapper.unmount()
  })

  it('switches across interlude boundaries in both directions and keeps short pauses as held lyrics', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.settings.progressLyricPreview = true
    const wrapper = mountProgressControls({ lyricPreview: waitingPreview })
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    for (const time of [20, 30, 40, 30, 19, 51, 60]) {
      dispatchPointerEvent(range.element, 'pointermove', { clientX: time * 2, clientY: 120 })
      await waitPreviewFrame()
      const waiting = document.body.querySelector('.lyric-preview-waiting')
      if (time === 20 || time === 30) {
        expect(waiting?.classList.contains('secondary')).toBe(true)
        expect(waiting?.querySelectorAll('.waiting-dot')).toHaveLength(3)
        expect(previewRows()).toEqual([])
      } else {
        expect(waiting).toBeNull()
        expect(previewRows()).toHaveLength(1)
      }
      if (time === 51) {
        expect(
          document.body.querySelector('.lyric-preview-bubble')?.classList.contains('held'),
        ).toBe(true)
        expect(previewRows()[0]?.text).toBe('Second phrase')
      }
    }
    wrapper.unmount()
  })

  it('restores waiting dots after lyrics load while hovering and removes them when unavailable', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.settings.progressLyricPreview = true
    const wrapper = mountProgressControls({ lyricPreview: null })
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 10, clientY: 120 })
    await waitPreviewFrame()
    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()

    await wrapper.setProps({ lyricPreview: waitingPreview })
    expect(document.body.querySelectorAll('.lyric-preview-waiting .waiting-dot')).toHaveLength(3)
    await wrapper.setProps({ previewEnabled: false })
    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()
    await wrapper.setProps({ previewEnabled: true })
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 10, clientY: 120 })
    await waitPreviewFrame()
    expect(document.body.querySelectorAll('.lyric-preview-waiting .waiting-dot')).toHaveLength(3)
    await wrapper.setProps({ lyricPreview: { ...waitingPreview, status: 'loading' } })
    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()
    await wrapper.setProps({ lyricPreview: waitingPreview })
    expect(document.body.querySelectorAll('.lyric-preview-waiting .waiting-dot')).toHaveLength(3)
    store.settings.progressLyricPreview = false
    await nextTick()
    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()
    wrapper.unmount()
  })

  it('uses a static waiting mark when animations are disabled or reduced motion changes', async () => {
    let reducedMotionChanged: ((event: MediaQueryListEvent) => void) | undefined
    const remove = vi.fn()
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
      addEventListener: (_event: string, handler: (event: MediaQueryListEvent) => void) => {
        reducedMotionChanged = handler
      },
      removeEventListener: remove,
    } as MediaQueryList)
    const store = usePlayerStore()
    store.duration = 100
    store.settings.progressLyricPreview = true
    store.settings.lyricAnimation = true
    const wrapper = mountProgressControls({ lyricPreview: waitingPreview })
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)
    dispatchPointerEvent(range.element, 'pointermove', { clientX: 10, clientY: 120 })
    await waitPreviewFrame()
    const indicator = document.body.querySelector<HTMLElement>('.lyrics-waiting-indicator')!
    expect(Number(indicator.style.scale)).toBeGreaterThan(1)
    store.settings.lyricAnimation = false
    await nextTick()
    expect(Number(indicator.style.scale)).toBe(1)
    expect([...indicator.children].map((dot) => (dot as HTMLElement).style.opacity)).toEqual([
      '0.65',
      '0.65',
      '0.65',
    ])
    store.settings.lyricAnimation = true
    await nextTick()
    expect(Number(indicator.style.scale)).toBeGreaterThan(1)
    reducedMotionChanged?.({ matches: true } as MediaQueryListEvent)
    await nextTick()
    expect(Number(indicator.style.scale)).toBe(1)
    wrapper.unmount()
    expect(remove).toHaveBeenCalledWith('change', reducedMotionChanged)
  })

  it('reclamps a waiting bubble that grows into long lyrics without another pointer move', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.settings.progressLyricPreview = true
    const originalMeasure = HTMLElement.prototype.getBoundingClientRect
    const right = window.innerWidth
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('range')) {
        return {
          x: right - 200,
          y: 100,
          top: 100,
          left: right - 200,
          right,
          bottom: 128,
          width: 200,
          height: 28,
        } as DOMRect
      }
      if (!this.classList.contains('lyric-preview-bubble')) return originalMeasure.call(this)
      const width = this.querySelector('.lyric-preview-waiting') ? 72 : 300
      return { x: 0, y: 0, top: 0, right: width, bottom: 60, left: 0, width, height: 60 } as DOMRect
    })
    const wrapper = mountProgressControls({
      lyricPreview: {
        status: 'ready',
        activeIndex: 0,
        lines: [
          { time: 0, endTime: 20, text: 'First phrase' },
          { time: 95, endTime: 100, text: 'A much longer final phrase beside the window edge' },
        ],
      },
    })
    const range = wrapper.get<HTMLElement>('.range')
    dispatchPointerEvent(range.element, 'pointermove', { clientX: right - 20, clientY: 114 })
    await waitPreviewFrame()
    const bubble = document.body.querySelector<HTMLElement>('.lyric-preview-bubble')!
    expect(bubble.style.width).toBe('72px')

    dispatchPointerEvent(range.element, 'pointermove', { clientX: right - 8, clientY: 114 })
    await waitPreviewFrame()
    expect(bubble.style.width).toBe('300px')
    expect(bubble.style.translate).toBe(`${right - 12 - 150}px 74px`)
    wrapper.unmount()
  })

  it('keeps showing a single line for lyrics that only carry line start times', async () => {
    // 快照来自外部,不保证每行都补了结束时间;不让位的话气泡会把整首歌越堆越多
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls()
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointermove', { clientX: 50, clientY: 120 })
    await waitPreviewFrame()

    expect(previewRows()).toEqual([{ text: 'Second line', secondary: false, harmony: false }])
    wrapper.unmount()
  })

  it('commits a progress drag from a window pointerup fallback', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true
    const onSeek = vi.fn()

    const wrapper = mountProgressControls({ onSeek })

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointerdown', {
      clientX: 40,
      clientY: 120,
    })
    dispatchPointerEvent(window, 'pointerup', {
      clientX: 160,
      clientY: 120,
    })

    expect(onSeek).toHaveBeenLastCalledWith(80)
    wrapper.unmount()
  })

  it('ignores progress drag completion from a different pointer', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    const onSeek = vi.fn()

    const wrapper = mountProgressControls({ onSeek })

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointerdown', {
      clientX: 40,
      clientY: 120,
      pointerId: 11,
    })
    await nextTick()
    dispatchPointerEvent(window, 'pointerup', {
      clientX: 180,
      clientY: 120,
      pointerId: 12,
    })
    await nextTick()

    expect(onSeek).not.toHaveBeenCalled()
    expect(range.classes()).toContain('is-dragging')

    dispatchPointerEvent(window, 'pointerup', {
      clientX: 120,
      clientY: 120,
      pointerId: 11,
    })
    await nextTick()

    expect(onSeek).toHaveBeenLastCalledWith(60)
    expect(range.classes()).not.toContain('is-dragging')
    wrapper.unmount()
  })

  it('cancels an old progress drag immediately when the current track changes', async () => {
    const store = usePlayerStore()
    store.duration = 100
    const onSeek = vi.fn()
    const wrapper = mountProgressControls({ onSeek })
    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)
    dispatchPointerEvent(range.element, 'pointerdown', { clientX: 40, clientY: 120 })
    store.currentTrackId = 'another-track'
    dispatchPointerEvent(window, 'pointerup', { clientX: 160, clientY: 120 })
    await nextTick()
    expect(onSeek).not.toHaveBeenCalled()
    expect(range.classes()).not.toContain('is-dragging')
    wrapper.unmount()
  })

  it('hides lyric preview bubbles when a pointer drag is canceled', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 0
    store.settings.progressLyricPreview = true

    const wrapper = mountProgressControls()

    const range = wrapper.get<HTMLElement>('.range')
    mockProgressRect(range.element)

    dispatchPointerEvent(range.element, 'pointermove', {
      clientX: 50,
      clientY: 120,
    })
    await waitPreviewFrame()
    expect(document.body.querySelector('.lyric-preview-bubble')).not.toBeNull()

    dispatchPointerEvent(range.element, 'pointerdown', {
      clientX: 50,
      clientY: 120,
    })
    dispatchPointerEvent(range.element, 'pointercancel')
    await nextTick()

    expect(document.body.querySelector('.lyric-preview-bubble')).toBeNull()
    wrapper.unmount()
  })

  it('supports keyboard seeking on the custom progress slider', async () => {
    const store = usePlayerStore()
    store.duration = 100
    store.currentTime = 50
    const onSeek = vi.fn()

    const wrapper = mountProgressControls({ onSeek })
    const range = wrapper.get('.range')

    await range.trigger('keydown', { key: 'ArrowRight' })
    expect(onSeek).toHaveBeenLastCalledWith(55)

    await range.trigger('keydown', { key: 'PageUp' })
    expect(onSeek).toHaveBeenLastCalledWith(60)

    await range.trigger('keydown', { key: 'Home' })
    expect(onSeek).toHaveBeenLastCalledWith(0)

    await range.trigger('keydown', { key: 'End' })
    expect(onSeek).toHaveBeenLastCalledWith(100)
    wrapper.unmount()
  })
})

describe('PlayerControls variant layout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it.each(['page', 'mini', 'vertical'] as const)(
    'keeps the %s wrapper state separate from the transport child state',
    (variant) => {
      const wrapper = mountPlayerControls(variant)
      const controls = wrapper.get('.controls')
      const buttons = wrapper.get(variant === 'mini' ? '.mini-buttons' : '.transport-buttons')

      expect(controls.classes()).toContain(`controls--${variant}`)
      expect(controls.classes()).not.toContain(`is-${variant}`)
      expect(buttons.classes()).toContain(`is-${variant}`)

      wrapper.unmount()
    },
  )
})
