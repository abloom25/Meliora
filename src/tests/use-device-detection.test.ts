import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDeviceDetection } from '../composables/useDeviceDetection'

function mountDevice(userAgent = 'iPhone', platform = 'iPhone') {
  vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints: platform === 'Win32' ? 0 : 5 })
  const queries = new Map<string, MediaQueryList>()
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => {
    const existing = queries.get(media)
    if (existing) return existing
    const query = Object.assign(new EventTarget(), {
      media,
      matches: media.includes('coarse'),
      onchange: null,
    }) as MediaQueryList
    queries.set(media, query)
    return query
  })
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 })
  vi.stubGlobal('visualViewport', viewport)
  let api!: ReturnType<typeof useDeviceDetection>
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useDeviceDetection()
        return () => null
      },
    }),
  )
  const setQuery = (media: string, matches: boolean) => {
    const query = queries.get(media)!
    Object.defineProperty(query, 'matches', { value: matches, configurable: true })
    query.dispatchEvent(Object.assign(new Event('change'), { matches }))
  }
  return { api, wrapper, viewport, setQuery }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('useDeviceDetection', () => {
  it('switches a phone between portrait sheets and landscape playback, including narrow phones', async () => {
    const { api, wrapper, setQuery } = mountDevice()
    setQuery('(max-width: 720px)', true)
    expect(api.isMobileSheet.value).toBe(true)
    setQuery('(orientation: landscape) and (max-height: 600px)', true)
    await nextTick()
    expect(api.viewportMode.value).toBe('phone-landscape')
    expect(api.isMobileSheet.value).toBe(false)
    expect(api.lyricsWindowSupported.value).toBe(false)
    setQuery('(orientation: landscape) and (max-height: 600px)', false)
    await nextTick()
    expect(api.viewportMode.value).toBe('mobile-sheet')
    wrapper.unmount()
  })

  it.each([
    ['Windows', 'Win32'],
    ['Macintosh', 'MacIntel'],
  ])(
    'does not treat desktop or desktop-mode iPad as a landscape phone: %s',
    (userAgent, platform) => {
      const { api, wrapper, setQuery } = mountDevice(userAgent, platform)
      setQuery('(orientation: landscape) and (max-height: 600px)', true)
      expect(api.isPhoneLandscape.value).toBe(false)
      expect(api.viewportMode.value).toBe('desktop')
      wrapper.unmount()
    },
  )

  it('coalesces visual viewport changes without changing orientation and cleans up listeners', () => {
    let callback: FrameRequestCallback | undefined
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      callback = fn
      return 42
    })
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')
    const { api, wrapper, viewport } = mountDevice()
    const remove = vi.spyOn(viewport, 'removeEventListener')
    viewport.height = 300
    viewport.offsetTop = 20
    viewport.dispatchEvent(new Event('resize'))
    viewport.dispatchEvent(new Event('scroll'))
    expect(request).toHaveBeenCalledTimes(1)
    callback!(0)
    expect(api.viewportHeight.value).toBe(300)
    expect(api.viewportTop.value).toBe(20)
    expect(api.isPhoneLandscape.value).toBe(false)
    viewport.dispatchEvent(new Event('resize'))
    wrapper.unmount()
    expect(cancel).toHaveBeenCalledWith(42)
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
  })
})
