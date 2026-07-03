import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SettingRange from '../components/SettingRange.vue'
import ToggleSwitch from '../components/ToggleSwitch.vue'

describe('settings form controls accessibility', () => {
  it('exposes an accessible name for setting ranges', () => {
    const wrapper = mount(SettingRange, {
      props: {
        modelValue: 0.5,
        min: 0,
        max: 1,
        step: 0.01,
        ariaLabel: '音量',
      },
    })

    expect(wrapper.find('input[type="range"]').attributes('aria-label')).toBe('音量')
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
})
