import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import PlayerControls from '../components/PlayerControls.vue'
import { usePlayerStore } from '../stores/player'
import type { LyricsSnapshot } from '../types/music'

const lyricPreview: LyricsSnapshot = {
  status: 'ready',
  activeIndex: 0,
  lines: [
    { time: 0, text: 'First line' },
    { time: 20, text: 'Second line', translation: '第二句' },
    { time: 40, text: 'Third line' },
  ],
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
