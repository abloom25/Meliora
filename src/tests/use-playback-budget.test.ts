import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import { usePlaybackBudget } from '../platform/web/usePlaybackBudget'

const mounted: VueWrapper[] = []
function mountBudget(create: () => void): VueWrapper {
  const wrapper = mount(
    defineComponent({
      setup() {
        create()
        return () => h('div')
      },
    }),
  )
  mounted.push(wrapper)
  return wrapper
}
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.restoreAllMocks()
})
describe('web playback resource budget', () => {
  it('immediately removes throttling when disabled and starts with a fresh budget when re-enabled', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const enabled = ref(true)
    const audio = document.createElement('audio')
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 4 })
    let budget!: ReturnType<typeof usePlaybackBudget>
    mountBudget(() => {
      budget = usePlaybackBudget({
        enabled,
        playing: ref(true),
        source: ref('/song.mp3'),
        getActiveAudio: () => audio,
        subscribe: () => () => {},
      })
    })
    for (let time = 100; time <= 2400; time += 100) budget.observeFrame(time)
    expect(budget.visualIntervalMs.value).toBe(50)
    enabled.value = false
    expect(budget.pressure.value).toBe('normal')
    expect(budget.visualIntervalMs.value).toBe(0)
    for (let time = 2500; time <= 5000; time += 100) budget.observeFrame(time)
    enabled.value = true
    await nextTick()
    expect(budget.visualIntervalMs.value).toBe(0)
    expect(budget.pressure.value).toBe('normal')
  })
  it('observes actual buffer ranges and playback rate without adding a separate animation loop', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const audio = document.createElement('audio')
    let end = 12
    let ready: number = HTMLMediaElement.HAVE_FUTURE_DATA
    Object.defineProperties(audio, {
      buffered: { configurable: true, get: () => ({ length: 1, start: () => 0, end: () => end }) },
      duration: { configurable: true, value: 120 },
      readyState: { configurable: true, get: () => ready },
    })
    audio.currentTime = 10
    const playing = ref(true)
    let update!: () => void
    const stop = vi.fn()
    let budget!: ReturnType<typeof usePlaybackBudget>
    const wrapper = mountBudget(() => {
      budget = usePlaybackBudget({
        playing,
        source: ref('/song.mp3'),
        getActiveAudio: () => audio,
        subscribe: (listener) => {
          update = listener
          return stop
        },
      })
    })
    update()
    expect(budget.pressure.value).toBe('buffering')
    end = 15
    update()
    expect(budget.pressure.value).toBe('buffering')
    end = 18
    update()
    expect(budget.pressure.value).toBe('normal')
    audio.playbackRate = 4
    update()
    expect(budget.pressure.value).toBe('buffering')
    playing.value = false
    await nextTick()
    expect(budget.pressure.value).toBe('normal')
    playing.value = true
    ready = HTMLMediaElement.HAVE_CURRENT_DATA
    update()
    expect(budget.pressure.value).toBe('buffering')
    expect(raf).not.toHaveBeenCalled()
    wrapper.unmount()
    expect(stop).toHaveBeenCalledOnce()
  })
})
