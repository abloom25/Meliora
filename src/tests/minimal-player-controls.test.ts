import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import MinimalPlayerControls from '../components/MinimalPlayerControls.vue'

function mountControls(
  values: Partial<{
    isPlaying: boolean
    currentTime: number
    duration: number
    disabled: boolean
  }> = {},
) {
  const onToggle = vi.fn()
  const onNext = vi.fn()
  const wrapper = mount(MinimalPlayerControls, {
    props: {
      isPlaying: false,
      currentTime: 30,
      duration: 120,
      ...values,
      onToggle,
      onNext,
    },
  })
  return { wrapper, onToggle, onNext }
}

describe('MinimalPlayerControls', () => {
  it('offers only playback and next-track buttons and reflects playback state', async () => {
    const { wrapper, onToggle, onNext } = mountControls()
    expect(wrapper.findAll('button')).toHaveLength(2)
    expect(wrapper.find('[aria-label="上一首"]').exists()).toBe(false)
    await wrapper.get('button[aria-label="播放"]').trigger('click')
    expect(onToggle).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ isPlaying: true })
    await wrapper.get('button[aria-label="暂停"]').trigger('click')
    expect(onToggle).toHaveBeenCalledTimes(2)
    await wrapper.get('button[aria-label="下一首"]').trigger('click')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('disables both actions when playback is unavailable', async () => {
    const { wrapper, onToggle, onNext } = mountControls({ disabled: true })
    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('disabled')).toBeDefined()
      await button.trigger('click')
    }
    expect(onToggle).not.toHaveBeenCalled()
    expect(onNext).not.toHaveBeenCalled()
    await wrapper.setProps({ disabled: false })
    await wrapper.get('button[aria-label="播放"]').trigger('click')
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('exposes elapsed progress and time without offering a seek interaction', async () => {
    const { wrapper, onToggle, onNext } = mountControls()
    const ring = wrapper.get('[role="progressbar"]')
    expect(ring.attributes()).toMatchObject({
      'aria-label': '播放进度',
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-valuenow': '25',
      'aria-valuetext': '0:30 / 2:00',
      focusable: 'false',
    })
    expect(wrapper.find('[role="slider"]').exists()).toBe(false)
    expect(ring.attributes('tabindex')).toBeUndefined()
    await ring.trigger('click')
    await ring.trigger('keydown', { key: 'ArrowRight' })
    expect(onToggle).not.toHaveBeenCalled()
    expect(onNext).not.toHaveBeenCalled()
  })

  it('updates and resets the ring when playback advances or changes tracks', async () => {
    const { wrapper } = mountControls()
    const fill = wrapper.get('.minimal-progress-fill')
    expect(fill.attributes('stroke-dashoffset')).toBe('75')
    await wrapper.setProps({ currentTime: 120 })
    expect(fill.attributes('stroke-dashoffset')).toBe('0')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    await wrapper.setProps({ currentTime: 0, duration: 240 })
    expect(fill.attributes('stroke-dashoffset')).toBe('100')
    expect(fill.attributes('opacity')).toBe('0')
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuetext')).toBe('0:00 / 4:00')
  })

  it.each([
    { currentTime: -10, duration: 120, progress: '0', text: '0:00 / 2:00' },
    { currentTime: 150, duration: 120, progress: '100', text: '2:00 / 2:00' },
    { currentTime: Number.NaN, duration: 120, progress: '0', text: '0:00 / 2:00' },
    { currentTime: Number.POSITIVE_INFINITY, duration: 120, progress: '0', text: '0:00 / 2:00' },
    { currentTime: 30, duration: 0, progress: '0', text: '0:00 / 0:00' },
    { currentTime: 30, duration: -120, progress: '0', text: '0:00 / 0:00' },
    { currentTime: 30, duration: Number.NaN, progress: '0', text: '0:00 / 0:00' },
    { currentTime: 30, duration: Number.POSITIVE_INFINITY, progress: '0', text: '0:00 / 0:00' },
  ])('sanitizes invalid or out-of-range timing: $currentTime / $duration', (input) => {
    const { wrapper } = mountControls({
      currentTime: input.currentTime,
      duration: input.duration,
    })
    const ring = wrapper.get('[role="progressbar"]')
    expect(ring.attributes('aria-valuenow')).toBe(input.progress)
    expect(ring.attributes('aria-valuetext')).toBe(input.text)
    expect(Number(wrapper.get('.minimal-progress-fill').attributes('stroke-dashoffset'))).toBe(
      100 - Number(input.progress),
    )
  })

  it('formats long recordings with hours and floors partial seconds', () => {
    const { wrapper } = mountControls({ currentTime: 3661.9, duration: 7322.8 })
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuetext')).toBe(
      '1:01:01 / 2:02:02',
    )
  })
})
