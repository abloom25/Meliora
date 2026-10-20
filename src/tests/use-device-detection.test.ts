import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDeviceDetection } from '../platform/web/useDeviceDetection'

function mountDevice(
  options: {
    userAgent?: string
    platform?: string
    touchPoints?: number
    width?: number
    height?: number
    visualViewportSupported?: boolean
  } = {},
) {
  const {
    userAgent = 'iPhone',
    platform = 'iPhone',
    touchPoints = 5,
    width = 390,
    height = 844,
    visualViewportSupported = true,
  } = options
  vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints: touchPoints })
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  const queries = new Map<string, MediaQueryList>()
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => {
    const existing = queries.get(media)
    if (existing) return existing
    const query = Object.assign(new EventTarget(), {
      media,
      matches: media.includes('max-width')
        ? width <= 720
        : touchPoints > 0 && media.includes('coarse'),
      onchange: null,
    }) as MediaQueryList
    queries.set(media, query)
    return query
  })
  let frame: FrameRequestCallback | undefined
  const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback
    return 42
  })
  const flushFrame = () => {
    const callback = frame
    frame = undefined
    callback?.(0)
  }
  const viewport = Object.assign(new EventTarget(), { width, height, offsetLeft: 0, offsetTop: 0 })
  vi.stubGlobal('visualViewport', visualViewportSupported ? viewport : null)
  let api!: ReturnType<typeof useDeviceDetection>
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useDeviceDetection()
        return () => null
      },
    }),
  )
  const resize = (nextWidth: number, nextHeight: number) => {
    window.innerWidth = nextWidth
    window.innerHeight = nextHeight
    viewport.width = nextWidth
    viewport.height = nextHeight
    const query = queries.get('(max-width: 720px)')!
    const matches = nextWidth <= 720
    Object.defineProperty(query, 'matches', { value: matches, configurable: true })
    query.dispatchEvent(Object.assign(new Event('change'), { matches }))
    window.dispatchEvent(new Event('resize'))
    flushFrame()
  }
  return { api, wrapper, viewport, request, flushFrame, resize }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useDeviceDetection', () => {
  it('switches a phone between portrait sheets and landscape playback, including narrow phones', async () => {
    const { api, wrapper, resize } = mountDevice()
    expect(api.isMobileSheet.value).toBe(true)
    resize(844, 390)
    await nextTick()
    expect(api.viewportMode.value).toBe('compact-landscape')
    expect(api.isMobileSheet.value).toBe(false)
    expect(api.lyricsWindowSupported.value).toBe(false)
    resize(667, 375)
    expect(api.viewportMode.value).toBe('compact-landscape')
    resize(390, 844)
    await nextTick()
    expect(api.viewportMode.value).toBe('mobile-sheet')
    wrapper.unmount()
  })

  it.each([
    { userAgent: 'Windows', platform: 'Win32', touchPoints: 0, lyricsWindow: true },
    { userAgent: 'Macintosh', platform: 'MacIntel', touchPoints: 0, lyricsWindow: true },
    { userAgent: 'Macintosh', platform: 'MacIntel', touchPoints: 5, lyricsWindow: false },
  ])(
    'adapts available space without changing device capabilities: $platform/$touchPoints',
    ({ userAgent, platform, touchPoints, lyricsWindow }) => {
      const { api, wrapper, resize } = mountDevice({
        userAgent,
        platform,
        touchPoints,
        width: 1440,
        height: 900,
      })
      expect(api.viewportMode.value).toBe('desktop')
      resize(956, 600)
      expect(api.isCompactLandscape.value).toBe(true)
      resize(956, 601)
      expect(api.viewportMode.value).toBe('compact-landscape')
      expect(api.isMobileSheet.value).toBe(false)
      expect(api.phoneDevice.value).toBe(false)
      expect(api.lyricsWindowSupported.value).toBe(lyricsWindow)

      resize(667, 375)
      expect(api.viewportMode.value).toBe('compact-landscape')
      resize(390, 844)
      expect(api.viewportMode.value).toBe('mobile-sheet')
      resize(1280, 720)
      expect(api.viewportMode.value).toBe('desktop')
      wrapper.unmount()
    },
  )

  it.each([['iPhone', 'iPhone', 5] as const, ['Windows', 'Win32', 0] as const])(
    'uses remaining stage space to rearrange artwork on %s',
    (userAgent, platform, touchPoints) => {
      const { api, wrapper, viewport, flushFrame } = mountDevice({
        userAgent,
        platform,
        touchPoints,
        width: 956,
        height: 440,
      })
      const resizeViewport = (height: number, offsetTop: number) => {
        viewport.height = height
        viewport.offsetTop = offsetTop
        viewport.dispatchEvent(new Event('resize'))
        viewport.dispatchEvent(new Event('scroll'))
        flushFrame()
      }

      expect(api.landscapeStageHeight.value).toBe(324)
      expect(api.landscapeCoverSize.value).toBe(262)
      expect(api.isShortLandscape.value).toBe(false)
      expect(api.isMinimalPlayer.value).toBe(false)
      resizeViewport(268, 36)
      expect(api.landscapeStageHeight.value).toBe(152)
      expect(api.isShortLandscape.value).toBe(true)
      expect(api.isMinimalPlayer.value).toBe(true)
      expect(api.viewportHeight.value).toBe(268)
      expect(api.viewportTop.value).toBe(36)
      expect(api.viewportMode.value).toBe('minimal-player')

      resizeViewport(440, 0)
      expect(api.isShortLandscape.value).toBe(false)
      expect(api.isMinimalPlayer.value).toBe(false)
      expect(api.viewportMode.value).toBe('compact-landscape')
      wrapper.unmount()
    },
  )

  it('reads safe area changes and removes its measurement element on unmount', () => {
    const { api, wrapper, viewport, flushFrame } = mountDevice({ width: 956, height: 283 })
    const probe = document.body.lastElementChild!
    const originalGetComputedStyle = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      if (element === probe) {
        return {
          paddingTop: '0px',
          paddingRight: '62px',
          paddingBottom: '21px',
          paddingLeft: '62px',
        } as CSSStyleDeclaration
      }
      return originalGetComputedStyle(element)
    })
    expect(api.isShortLandscape.value).toBe(false)
    viewport.dispatchEvent(new Event('resize'))
    flushFrame()
    expect(api.safeAreaInsets.value).toEqual({ top: 0, right: 62, bottom: 21, left: 62 })
    expect(api.landscapeStageHeight.value).toBe(154)
    expect(api.isShortLandscape.value).toBe(true)
    expect(api.isMinimalPlayer.value).toBe(true)
    expect(api.viewportMode.value).toBe('minimal-player')
    wrapper.unmount()
    expect(probe.isConnected).toBe(false)
  })

  it('coalesces viewport changes without turning portrait keyboard space into landscape', () => {
    const { api, wrapper, viewport, request, flushFrame } = mountDevice()
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const remove = vi.spyOn(viewport, 'removeEventListener')
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    viewport.height = 280
    viewport.offsetTop = 20
    viewport.offsetLeft = 4
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    expect(request).toHaveBeenCalledTimes(1)
    flushFrame()
    expect(api.viewportHeight.value).toBe(280)
    expect(api.viewportWidth.value).toBe(390)
    expect(api.viewportLeft.value).toBe(4)
    expect(api.viewportTop.value).toBe(20)
    expect(api.isCompactLandscape.value).toBe(false)
    expect(api.isShortLandscape.value).toBe(false)
    expect(api.isMinimalPlayer.value).toBe(false)
    viewport.dispatchEvent(new Event('resize'))
    wrapper.unmount()
    expect(cancel).toHaveBeenCalledWith(42)
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(removeWindow).toHaveBeenCalledWith('resize', expect.any(Function))
  })

  it('falls back to the window dimensions when VisualViewport is unavailable', () => {
    const { api, wrapper } = mountDevice({
      width: 956,
      height: 440,
      visualViewportSupported: false,
    })
    expect(api.viewportWidth.value).toBe(956)
    expect(api.viewportHeight.value).toBe(440)
    expect(api.viewportTop.value).toBe(0)
    expect(api.viewportMode.value).toBe('compact-landscape')
    wrapper.unmount()
  })

  it('selects minimal mode before compact mode when the lyrics column becomes too narrow', () => {
    const { api, wrapper, resize } = mountDevice({
      userAgent: 'Windows',
      platform: 'Win32',
      touchPoints: 0,
      width: 568,
      height: 320,
    })
    expect(api.viewportMode.value).toBe('compact-landscape')
    resize(400, 300)
    expect(api.isShortLandscape.value).toBe(false)
    expect(api.isCompactLandscape.value).toBe(true)
    expect(api.isMinimalPlayer.value).toBe(true)
    expect(api.isMobileSheet.value).toBe(false)
    expect(api.viewportMode.value).toBe('minimal-player')
    expect(api.lyricsWindowSupported.value).toBe(true)
    resize(667, 375)
    expect(api.isMinimalPlayer.value).toBe(false)
    expect(api.viewportMode.value).toBe('compact-landscape')
    wrapper.unmount()
  })

  it('progressively restores artwork and metadata while retaining minimal mode', () => {
    const { api, wrapper, resize } = mountDevice({
      userAgent: 'Windows',
      platform: 'Win32',
      touchPoints: 0,
      width: 400,
      height: 240,
    })
    expect(api.viewportMode.value).toBe('minimal-player')
    expect(api.minimalArtworkVisible.value).toBe(false)
    expect(api.minimalMetadataVisible.value).toBe(false)
    expect(api.minimalMetadataPlacement.value).toBe('hidden')
    expect(api.minimalCoverSize.value).toBe(0)
    expect(api.minimalArtworkWidth.value).toBe(0)

    resize(480, 240)
    expect(api.viewportMode.value).toBe('minimal-player')
    expect(api.minimalArtworkVisible.value).toBe(true)
    expect(api.minimalMetadataVisible.value).toBe(false)
    expect(api.minimalCoverSize.value).toBeCloseTo(126.4)

    resize(640, 240)
    expect(api.viewportMode.value).toBe('minimal-player')
    expect(api.minimalMetadataVisible.value).toBe(true)
    expect(api.minimalMetadataPlacement.value).toBe('below')
    expect(api.minimalCoverSize.value).toBe(164)
    expect(api.minimalArtworkWidth.value).toBe(164)

    resize(956, 150)
    expect(api.viewportMode.value).toBe('minimal-player')
    expect(api.minimalArtworkVisible.value).toBe(true)
    expect(api.minimalMetadataVisible.value).toBe(true)
    expect(api.minimalMetadataPlacement.value).toBe('beside')
    expect(api.minimalCoverSize.value).toBe(126)
    expect(api.minimalArtworkWidth.value).toBe(298)

    resize(956, 440)
    expect(api.viewportMode.value).toBe('compact-landscape')
    expect(api.minimalArtworkVisible.value).toBe(false)
    expect(api.minimalMetadataVisible.value).toBe(false)
    expect(api.minimalMetadataPlacement.value).toBe('hidden')
    expect(api.minimalCoverSize.value).toBe(0)
    wrapper.unmount()
  })
})
