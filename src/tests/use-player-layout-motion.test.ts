import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePlayerLayoutMotion } from '../platform/web/usePlayerLayoutMotion'

const reducedMotion = vi.hoisted(() => ({
  value: false,
  listeners: new Set<(value: boolean) => void>(),
}))

vi.mock('../platform/web/reduced-motion', () => ({
  isReducedMotion: () => reducedMotion.value,
  onReducedMotionChange: (listener: (value: boolean) => void) => {
    reducedMotion.listeners.add(listener)
    return () => reducedMotion.listeners.delete(listener)
  },
}))

interface TestRect {
  left: number
  top: number
  width: number
  height: number
}

const mounted: VueWrapper[] = []

async function createHarness(
  options: {
    panelBoxSizing?: 'border-box' | 'content-box'
    revealArtwork?: boolean
    includeMetaInitially?: boolean
  } = {},
) {
  const layoutKey = ref('desktop')
  const includeMeta = ref(options.includeMetaInitially ?? true)
  const root = ref<HTMLElement | null>(null)
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++frameId, callback)
    return frameId
  })
  const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id)
  })
  const flushFrames = () => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach((callback) => callback(0))
  }
  let notifyResize: () => void = () => undefined
  const observe = vi.fn()
  const unobserve = vi.fn()
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notifyResize = callback
      }
      observe = observe
      unobserve = unobserve
      disconnect = disconnect
    },
  )
  const viewport = new EventTarget()
  vi.stubGlobal('visualViewport', viewport)
  const roles = ['cover', 'meta', 'lyrics', 'panel'] as const
  const rects: Record<(typeof roles)[number], TestRect> = {
    cover: { left: 30, top: 50, width: 300, height: 300 },
    meta: { left: 30, top: 370, width: 300, height: 60 },
    lyrics: { left: 400, top: 50, width: 500, height: 500 },
    panel: { left: 700, top: 72, width: 390, height: 644 },
  }
  const wrapper = mount(
    defineComponent({
      setup() {
        usePlayerLayoutMotion({
          layoutKey: () => layoutKey.value,
          getTargets: () =>
            roles.map((key) => ({
              key,
              element:
                key === 'meta' && !includeMeta.value
                  ? null
                  : (root.value?.querySelector<HTMLElement>(`[data-target="${key}"]`) ?? null),
              scale: key === 'cover',
              resize: key === 'panel',
              reveal: options.revealArtwork && (key === 'cover' || key === 'meta'),
            })),
        })
        return () =>
          h('main', { ref: root, 'data-layout': layoutKey.value }, [
            ...roles.map((role) =>
              h('div', { 'data-target': role }, role === 'lyrics' ? [h('span', '歌词')] : role),
            ),
          ])
      },
    }),
    { attachTo: document.body },
  )
  mounted.push(wrapper)
  const animations: Array<{
    role: string
    frames: Keyframe[]
    options: KeyframeAnimationOptions
    animation: Animation
    cancel: ReturnType<typeof vi.fn>
  }> = []
  const elements = {} as Record<(typeof roles)[number], HTMLElement>
  for (const role of roles) {
    const element = root.value!.querySelector<HTMLElement>(`[data-target="${role}"]`)!
    elements[role] = element
    if (role === 'panel') {
      element.style.cssText = `position: fixed; right: 14px; bottom: 84px; left: auto; top: auto; box-sizing: ${options.panelBoxSizing ?? 'border-box'}; padding: 20px; border: 2px solid`
      Object.defineProperty(element, 'offsetLeft', { get: () => rects.panel.left })
      Object.defineProperty(element, 'offsetTop', { get: () => rects.panel.top })
    }
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => {
      const rect = rects[role]
      return {
        ...rect,
        x: rect.left,
        y: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        toJSON: () => rect,
      }
    })
    element.animate = vi.fn((keyframes, options) => {
      const cancel = vi.fn()
      const animation = { cancel, onfinish: null, oncancel: null } as unknown as Animation
      animations.push({
        role,
        frames: keyframes as Keyframe[],
        options: options as KeyframeAnimationOptions,
        animation,
        cancel,
      })
      return animation
    })
  }
  await nextTick()
  await nextTick()
  return {
    wrapper,
    layoutKey,
    includeMeta,
    rects,
    elements,
    animations,
    viewport,
    request,
    cancelFrame,
    frames,
    flushFrames,
    notifyResize: () => notifyResize(),
    observe,
    unobserve,
    disconnect,
  }
}

afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  reducedMotion.listeners.clear()
  reducedMotion.value = false
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('usePlayerLayoutMotion', () => {
  it('uses the previous stable geometry even when a media query has already changed the DOM layout', async () => {
    const { layoutKey, rects, animations, elements } = await createHarness()
    expect(animations).toHaveLength(0)
    const line = elements.lyrics.querySelector('span')!
    line.style.translate = '0 125px'
    rects.cover = { left: 100, top: 70, width: 200, height: 200 }
    rects.meta = { left: 100, top: 280, width: 200, height: 60 }
    rects.lyrics = { left: 360, top: 70, width: 400, height: 250 }
    layoutKey.value = 'compact'
    await nextTick()

    const cover = animations.find((entry) => entry.role === 'cover')!
    expect(cover.frames).toEqual([
      { translate: '-70px -20px', scale: '1.5 1.5', transformOrigin: '0 0' },
      { translate: '0px 0px', scale: '1 1', transformOrigin: '0 0' },
    ])
    expect(cover.options.duration).toBe(380)
    expect(animations.find((entry) => entry.role === 'meta')!.frames[0]).toEqual({
      translate: '-70px 90px',
    })
    expect(animations.find((entry) => entry.role === 'lyrics')!.frames[0]).toEqual({
      translate: '40px -20px',
    })
    expect(line.style.translate).toBe('0 125px')
  })

  it('refreshes cached geometry during continuous resizing without animating every size change', async () => {
    const { layoutKey, rects, animations, notifyResize, flushFrames, request, viewport } =
      await createHarness()
    rects.cover.left = 80
    notifyResize()
    window.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    expect(request).toHaveBeenCalledTimes(1)
    flushFrames()
    expect(animations).toHaveLength(0)

    rects.cover.left = 100
    layoutKey.value = 'compact'
    await nextTick()
    expect(animations[0]!.frames[0]!.translate).toBe('-20px 0px')
  })

  it('animates a drawer border box and extended sheet padding without scaling its text or changing its transform', async () => {
    const { layoutKey, rects, animations, elements } = await createHarness()
    elements.panel.style.transform = 'translateY(96px)'
    elements.panel.style.padding = '19px 30px 258px'
    rects.panel = { left: 0, top: 58, width: 480, height: 982 }
    layoutKey.value = 'sheet'
    await nextTick()

    const panel = animations.find((entry) => entry.role === 'panel')!
    expect(panel.frames[0]).toMatchObject({
      translate: '700px 14px',
      width: '390px',
      height: '644px',
      left: '0px',
      top: '58px',
      right: 'auto',
      bottom: 'auto',
      paddingBottom: '20px',
      borderBottomWidth: '2px',
    })
    expect(panel.frames[1]).toMatchObject({
      translate: '0px 0px',
      width: '480px',
      height: '982px',
      left: '0px',
      top: '58px',
      right: 'auto',
      bottom: 'auto',
      paddingBottom: '258px',
      borderBottomWidth: '2px',
    })
    expect(panel.frames.every((frame) => !('scale' in frame) && !('transform' in frame))).toBe(true)
    expect(elements.panel.style.transform).toBe('translateY(96px)')
    panel.animation.onfinish!.call(panel.animation, {} as AnimationPlaybackEvent)
    expect(panel.cancel).toHaveBeenCalledOnce()
    expect(elements.panel.style.width).toBe('')
    expect(elements.panel.style.left).toBe('auto')
    expect(elements.panel.style.right).toBe('14px')
  })

  it('accounts for padding and borders when interpolating content-box drawer dimensions', async () => {
    const { layoutKey, rects, animations, elements } = await createHarness({
      panelBoxSizing: 'content-box',
    })
    elements.panel.style.padding = '10px 30px 80px'
    rects.panel = { left: 200, top: 24, width: 500, height: 400 }
    layoutKey.value = 'compact'
    await nextTick()

    const panel = animations.find((entry) => entry.role === 'panel')!
    expect(panel.frames[0]).toMatchObject({
      width: '346px',
      height: '600px',
      paddingTop: '20px',
      paddingBottom: '20px',
    })
    expect(panel.frames[1]).toMatchObject({
      width: '436px',
      height: '306px',
      paddingTop: '10px',
      paddingBottom: '80px',
    })
  })

  it('starts an interrupted drawer resize at its current visible size and cancels its temporary dimensions for reduced motion', async () => {
    const { layoutKey, rects, animations, elements } = await createHarness()
    rects.panel = { left: 0, top: 58, width: 480, height: 982 }
    layoutKey.value = 'sheet'
    await nextTick()
    const previous = animations.find((entry) => entry.role === 'panel')!
    const readRect = vi.mocked(elements.panel.getBoundingClientRect)
    readRect.mockReturnValueOnce({
      ...readRect(),
      left: 240,
      x: 240,
      top: 64,
      y: 64,
      width: 440,
      height: 800,
    })
    rects.panel = { left: 540, top: 12, width: 390, height: 226 }
    layoutKey.value = 'minimal'
    await nextTick()

    const restarted = animations.filter((entry) => entry.role === 'panel')[1]!
    expect(previous.cancel).toHaveBeenCalledOnce()
    expect(restarted.frames[0]).toMatchObject({
      translate: '-300px 52px',
      width: '440px',
      height: '800px',
    })
    reducedMotion.value = true
    reducedMotion.listeners.forEach((listener) => listener(true))
    expect(restarted.cancel).toHaveBeenCalledOnce()
    expect(elements.panel.style.width).toBe('')
    expect(elements.panel.style.height).toBe('')
    expect(elements.panel.style.right).toBe('14px')
  })

  it('releases drawer dimensions on a viewport resize without cancelling on its own ResizeObserver updates', async () => {
    const { layoutKey, rects, animations, notifyResize, flushFrames, viewport } =
      await createHarness()
    rects.panel.width = 480
    layoutKey.value = 'sheet'
    await nextTick()
    const panel = animations.find((entry) => entry.role === 'panel')!
    notifyResize()
    flushFrames()
    expect(panel.cancel).not.toHaveBeenCalled()

    viewport.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(panel.cancel).toHaveBeenCalledOnce()
    expect(panel.animation.onfinish).toBeNull()
  })

  it('preserves a restarted drawer animation when the viewport resize also changes its layout mode', async () => {
    const { layoutKey, rects, animations, elements, flushFrames } = await createHarness()
    rects.panel.width = 480
    layoutKey.value = 'sheet'
    await nextTick()
    const previous = animations.find((entry) => entry.role === 'panel')!
    window.dispatchEvent(new Event('resize'))
    const readRect = vi.mocked(elements.panel.getBoundingClientRect)
    readRect.mockReturnValueOnce(readRect())
    rects.panel.width = 390
    layoutKey.value = 'compact'
    await nextTick()
    flushFrames()

    expect(previous.cancel).toHaveBeenCalledOnce()
    const current = animations.filter((entry) => entry.role === 'panel')[1]!
    expect(current.cancel).not.toHaveBeenCalled()
  })

  it('refreshes the stable drawer position after its CSS entry transition ends', async () => {
    const { layoutKey, rects, animations, elements, flushFrames } = await createHarness()
    rects.panel.top = 120
    elements.panel.dispatchEvent(new Event('transitionend'))
    flushFrames()
    rects.panel.top = 60
    layoutKey.value = 'compact'
    await nextTick()

    const panel = animations.find((entry) => entry.role === 'panel')!
    expect(panel.frames[0]!.translate).toBe('0px 60px')
  })

  it('restarts an interrupted transition from its current visual position', async () => {
    const { layoutKey, rects, animations, elements } = await createHarness()
    rects.cover.left = 100
    layoutKey.value = 'compact'
    await nextTick()
    const previous = animations[0]!
    const readRect = vi.mocked(elements.cover.getBoundingClientRect)
    readRect.mockReturnValueOnce({
      ...readRect(),
      left: 65,
      x: 65,
    })
    rects.cover.left = 200
    layoutKey.value = 'centered'
    await nextTick()

    expect(previous.cancel).toHaveBeenCalledOnce()
    expect(previous.animation.onfinish).toBeNull()
    expect(animations[1]!.frames[0]!.translate).toBe('-135px 0px')
  })

  it('leaves hidden, newly visible, and unchanged targets to their CSS visibility transitions', async () => {
    const { layoutKey, rects, animations, elements } = await createHarness()
    elements.cover.style.visibility = 'hidden'
    rects.cover.left = 100
    layoutKey.value = 'hidden'
    await nextTick()
    expect(animations).toHaveLength(0)
    elements.cover.style.visibility = 'visible'
    layoutKey.value = 'visible'
    await nextTick()
    expect(animations).toHaveLength(0)
  })

  it('fades existing artwork and metadata back into layout without scaling their hidden zero-size boxes', async () => {
    const { layoutKey, rects, animations, elements } = await createHarness({
      revealArtwork: true,
    })
    const coverRect = { ...rects.cover }
    const metaRect = { ...rects.meta }
    rects.cover = { left: 0, top: 0, width: 0, height: 0 }
    rects.meta = { left: 0, top: 0, width: 0, height: 0 }
    layoutKey.value = 'minimal'
    await nextTick()
    expect(animations).toHaveLength(0)

    // 模拟 media query 在 Vue pre watcher 之前已经恢复元素尺寸。
    rects.cover = coverRect
    rects.meta = metaRect
    layoutKey.value = 'wide-minimal'
    await nextTick()
    expect(animations.map((entry) => entry.role)).toEqual(['cover', 'meta'])
    for (const entry of animations) {
      expect(entry.frames).toEqual([{ opacity: 0 }, { opacity: 1 }])
      expect(entry.options.duration).toBe(280)
      entry.animation.onfinish!.call(entry.animation, {} as AnimationPlaybackEvent)
      expect(entry.cancel).toHaveBeenCalledOnce()
    }
    expect(elements.cover.style.opacity).toBe('')
    expect(elements.meta.style.opacity).toBe('')
  })

  it('does not add a reveal animation to new targets or when reduced motion is enabled', async () => {
    const { layoutKey, includeMeta, rects, animations } = await createHarness({
      revealArtwork: true,
      includeMetaInitially: false,
    })
    includeMeta.value = true
    layoutKey.value = 'new-meta'
    await nextTick()
    expect(animations).toHaveLength(0)

    const coverRect = { ...rects.cover }
    rects.cover = { left: 0, top: 0, width: 0, height: 0 }
    layoutKey.value = 'minimal'
    await nextTick()
    reducedMotion.value = true
    rects.cover = coverRect
    layoutKey.value = 'wide-minimal'
    await nextTick()
    expect(animations).toHaveLength(0)
  })

  it('continues an interrupted reveal from its current opacity and cleans it up for reduced motion', async () => {
    const { layoutKey, rects, animations, elements } = await createHarness({
      revealArtwork: true,
    })
    const coverRect = { ...rects.cover }
    rects.cover = { left: 0, top: 0, width: 0, height: 0 }
    layoutKey.value = 'minimal'
    await nextTick()
    rects.cover = coverRect
    layoutKey.value = 'wide-minimal'
    await nextTick()
    const previous = animations[0]!
    vi.spyOn(window, 'getComputedStyle').mockReturnValueOnce({
      ...window.getComputedStyle(elements.cover),
      opacity: '0.35',
    } as CSSStyleDeclaration)
    layoutKey.value = 'full'
    await nextTick()

    expect(previous.cancel).toHaveBeenCalledOnce()
    const current = animations[1]!
    expect(current.frames[0]).toMatchObject({ opacity: 0.35 })
    expect(current.frames[1]).toMatchObject({ opacity: 1 })
    reducedMotion.value = true
    reducedMotion.listeners.forEach((listener) => listener(true))
    expect(current.cancel).toHaveBeenCalledOnce()
    expect(elements.cover.style.opacity).toBe('')
  })

  it('honors reduced motion both before and during an active animation', async () => {
    const { layoutKey, rects, animations } = await createHarness()
    reducedMotion.value = true
    rects.cover.left = 100
    layoutKey.value = 'compact'
    await nextTick()
    expect(animations).toHaveLength(0)

    reducedMotion.value = false
    rects.cover.left = 200
    layoutKey.value = 'centered'
    await nextTick()
    expect(animations).toHaveLength(1)
    reducedMotion.value = true
    reducedMotion.listeners.forEach((listener) => listener(true))
    expect(animations[0]!.cancel).toHaveBeenCalledOnce()
  })

  it('cleans up finished animation effects and all observers, listeners and frames on unmount', async () => {
    const {
      wrapper,
      layoutKey,
      rects,
      animations,
      elements,
      disconnect,
      cancelFrame,
      viewport,
      frames,
    } = await createHarness()
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const removeViewport = vi.spyOn(viewport, 'removeEventListener')
    rects.cover.left = 100
    layoutKey.value = 'compact'
    await nextTick()
    const finished = animations[0]!
    finished.animation.onfinish!.call(finished.animation, {} as AnimationPlaybackEvent)
    expect(finished.cancel).toHaveBeenCalledOnce()
    expect(elements.cover.style.translate).toBe('')
    expect(frames.size).toBe(1)
    wrapper.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(cancelFrame).toHaveBeenCalled()
    expect(frames.size).toBe(0)
    expect(reducedMotion.listeners.size).toBe(0)
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeViewport).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeViewport).toHaveBeenCalledWith('scroll', expect.any(Function))
  })

  it('works without Web Animations support', async () => {
    const { layoutKey, rects, elements, animations } = await createHarness()
    Object.defineProperty(elements.cover, 'animate', { value: undefined })
    rects.cover.left = 100
    layoutKey.value = 'compact'
    await nextTick()
    expect(animations).toHaveLength(0)
  })

  it('cancels in-flight animations when the component unmounts', async () => {
    const { wrapper, layoutKey, rects, animations } = await createHarness()
    rects.cover.left = 100
    layoutKey.value = 'compact'
    await nextTick()
    wrapper.unmount()
    expect(animations[0]!.cancel).toHaveBeenCalledOnce()
    expect(animations[0]!.animation.onfinish).toBeNull()
    expect(animations[0]!.animation.oncancel).toBeNull()
  })
})
