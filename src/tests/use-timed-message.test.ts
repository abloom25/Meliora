import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTimedMessage } from '../admin/composables/useTimedMessage'

describe('useTimedMessage', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('restarts the timer when a newer message replaces the previous one', () => {
    vi.useFakeTimers()
    const wrapper = mount(
      defineComponent({
        setup() {
          return useTimedMessage(1000)
        },
        template: '<div />',
      }),
    )
    const state = wrapper.vm as unknown as ReturnType<typeof useTimedMessage>

    state.showMessage('first', 'error')
    vi.advanceTimersByTime(800)
    state.showMessage('second', 'success')
    vi.advanceTimersByTime(300)
    expect(state.message).toBe('second')

    vi.advanceTimersByTime(700)
    expect(state.message).toBe('')
    wrapper.unmount()
  })
})
