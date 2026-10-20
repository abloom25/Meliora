import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import LyricsWaitingIndicator from '../components/LyricsWaitingIndicator.vue'
import type { LyricWaitingInterval } from '../core/lyrics/interlude'

const interval: LyricWaitingInterval = {
  kind: 'intro',
  start: 0,
  end: 10,
  previousAnchor: -1,
  nextAnchor: 0,
}
let wrapper: VueWrapper<InstanceType<typeof LyricsWaitingIndicator>> | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('LyricsWaitingIndicator', () => {
  it('keeps an unstarted intro visible while paused and resumes the media animation on play', async () => {
    wrapper = mount(LyricsWaitingIndicator, {
      attachTo: document.body,
      props: { interval, animated: true, paused: true, getTime: () => 0 },
    })
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
    expect(
      wrapper.findAll('.waiting-dot').map((dot) => (dot.element as HTMLElement).style.opacity),
    ).toEqual(['0.65', '0.65', '0.65'])
    await wrapper.setProps({ paused: false })
    expect((wrapper.element as HTMLElement).style.opacity).toBe('0')
    wrapper.vm.write(1)
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
  })

  it('uses the host clock on mount and interval changes without starting its own loop', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const timer = vi.spyOn(window, 'setTimeout')
    let time = 4
    wrapper = mount(LyricsWaitingIndicator, {
      attachTo: document.body,
      props: { interval, animated: true, getTime: () => time },
    })
    const container = wrapper.element as HTMLElement
    expect(container.style.opacity).toBe('1')
    expect(wrapper.findAll('.waiting-dot')).toHaveLength(3)
    expect(container.getAttribute('aria-hidden')).toBe('true')
    time = 15
    await wrapper.setProps({ interval: { ...interval, start: 10, end: 20 } })
    expect(container.style.opacity).toBe('1')
    expect(raf).not.toHaveBeenCalled()
    expect(timer).not.toHaveBeenCalled()
  })

  it('deduplicates identical frames, then writes a seek directly at the host time', () => {
    wrapper = mount(LyricsWaitingIndicator, {
      attachTo: document.body,
      props: { interval, animated: true, getTime: () => 4 },
    })
    const observer = new MutationObserver(() => undefined)
    observer.observe(wrapper.element, { attributes: true, subtree: true })
    wrapper.vm.write(4)
    expect(observer.takeRecords()).toHaveLength(0)
    wrapper.vm.write(9.9)
    expect(observer.takeRecords().length).toBeGreaterThan(0)
    expect(Number((wrapper.element as HTMLElement).style.opacity)).toBeLessThan(1)
    wrapper.vm.write(4)
    expect((wrapper.element as HTMLElement).style.opacity).toBe('1')
    observer.disconnect()
  })

  it('switches immediately to a static mark for reduced motion and ignores detached nodes', async () => {
    wrapper = mount(LyricsWaitingIndicator, {
      attachTo: document.body,
      props: { interval, animated: true, getTime: () => 4, secondary: true },
    })
    await wrapper.setProps({ animated: false })
    const container = wrapper.element as HTMLElement
    expect(Number(container.style.scale)).toBe(1)
    expect(
      wrapper.findAll('.waiting-dot').map((dot) => (dot.element as HTMLElement).style.opacity),
    ).toEqual(['0.65', '0.65', '0.65'])
    expect(wrapper.classes()).toContain('secondary')
    const before = container.outerHTML
    container.remove()
    wrapper.vm.write(10)
    expect(container.outerHTML).toBe(before)
  })
})
