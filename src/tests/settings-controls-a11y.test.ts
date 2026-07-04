import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import SettingRange from '../components/SettingRange.vue'
import SleepTimerControl from '../components/SleepTimerControl.vue'
import ToggleSwitch from '../components/ToggleSwitch.vue'

function dispatchPointerEvent(
  target: EventTarget,
  type: string,
  init: MouseEventInit & { pointerId?: number } = {},
) {
  const { pointerId = 1, ...eventInit } = init
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    ...eventInit,
  })
  Object.defineProperty(event, 'pointerId', {
    value: pointerId,
  })
  target.dispatchEvent(event)
}

describe('settings form controls accessibility', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes an accessible name for setting ranges', () => {
    const wrapper = mount(SettingRange, {
      props: {
        modelValue: 0.555,
        min: 0,
        max: 1,
        step: 0.1,
        ariaLabel: '音量',
        ariaValueText: '50%',
      },
    })

    const slider = wrapper.find('[role="slider"]')
    expect(slider.attributes('aria-label')).toBe('音量')
    expect(slider.attributes('aria-valuenow')).toBe('0.6')
    expect(slider.attributes('aria-valuetext')).toBe('50%')
  })

  it('exposes an accessible name for toggle switches', () => {
    const wrapper = mount(ToggleSwitch, {
      props: {
        modelValue: true,
        ariaLabel: '平滑切歌',
      },
    })

    expect(wrapper.find('input[type="checkbox"]').attributes('aria-label')).toBe('平滑切歌')
  })

  it('updates and commits range values from pointer interactions with a window fallback', async () => {
    const wrapper = mount(SettingRange, {
      props: {
        modelValue: 0,
        min: 0,
        max: 10,
        step: 1,
        ariaLabel: '测试滑块',
      },
    })
    const slider = wrapper.get<HTMLElement>('[role="slider"]')
    vi.spyOn(slider.element, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 28,
      left: 0,
      width: 100,
      height: 28,
      toJSON: () => ({}),
    })

    dispatchPointerEvent(slider.element, 'pointerdown', { clientX: 25 })
    await nextTick()
    expect(slider.classes()).toContain('is-dragging')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([3])

    dispatchPointerEvent(window, 'pointerup', { clientX: 80 })
    await nextTick()

    expect(slider.classes()).not.toContain('is-dragging')
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([8])
    expect(wrapper.emitted('change')?.at(-1)).toEqual([8])
  })

  it('ignores range drag events from a different pointer', async () => {
    const wrapper = mount(SettingRange, {
      props: {
        modelValue: 0,
        min: 0,
        max: 10,
        step: 1,
        ariaLabel: '测试滑块',
      },
    })
    const slider = wrapper.get<HTMLElement>('[role="slider"]')
    vi.spyOn(slider.element, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 100,
      bottom: 28,
      left: 0,
      width: 100,
      height: 28,
      toJSON: () => ({}),
    })

    dispatchPointerEvent(slider.element, 'pointerdown', { clientX: 20, pointerId: 7 })
    await nextTick()
    expect(slider.classes()).toContain('is-dragging')

    dispatchPointerEvent(window, 'pointerup', { clientX: 90, pointerId: 8 })
    await nextTick()
    expect(slider.classes()).toContain('is-dragging')
    expect(wrapper.emitted('change')).toBeUndefined()

    dispatchPointerEvent(window, 'pointerup', { clientX: 70, pointerId: 7 })
    await nextTick()
    expect(slider.classes()).not.toContain('is-dragging')
    expect(wrapper.emitted('change')?.at(-1)).toEqual([7])
  })

  it('commits the current draft when a range drag is canceled', async () => {
    const wrapper = mount(SettingRange, {
      props: {
        modelValue: 4,
        min: 0,
        max: 10,
        step: 1,
        ariaLabel: '测试滑块',
      },
    })
    const slider = wrapper.get<HTMLElement>('[role="slider"]')

    dispatchPointerEvent(slider.element, 'pointerdown', { clientX: 25 })
    await wrapper.setProps({ modelValue: 3 })
    dispatchPointerEvent(slider.element, 'pointercancel')
    await nextTick()

    expect(slider.classes()).not.toContain('is-dragging')
    expect(wrapper.emitted('change')?.at(-1)).toEqual([3])
  })

  it('supports keyboard control for custom ranges', async () => {
    const wrapper = mount(SettingRange, {
      props: {
        modelValue: 5,
        min: 0,
        max: 10,
        step: 0.5,
        ariaLabel: '测试滑块',
      },
    })
    const slider = wrapper.get('[role="slider"]')

    await slider.trigger('keydown', { key: 'PageUp' })
    expect(wrapper.emitted('change')?.at(-1)).toEqual([10])

    await wrapper.setProps({ modelValue: 5 })
    await slider.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.emitted('change')?.at(-1)).toEqual([4.5])

    await slider.trigger('keydown', { key: 'Home' })
    expect(wrapper.emitted('change')?.at(-1)).toEqual([0])
  })

  it('passes sleep timer range input and change values through', () => {
    const wrapper = mount(SleepTimerControl, {
      props: {
        minutes: 0,
        remaining: 0,
        displayMinutes: 0,
        progress: 0,
        options: [0, 15, 30, 45, 60, 90],
        formatRemaining: (value: number) => `${value}`,
      },
    })
    const range = wrapper.getComponent(SettingRange)

    range.vm.$emit('update:modelValue', 44)
    range.vm.$emit('change', 44)

    expect(wrapper.emitted('input')?.at(-1)).toEqual([44])
    expect(wrapper.emitted('change')?.at(-1)).toEqual([44])
    expect(range.props('ariaValueText')).toBe('关闭')
  })
})
