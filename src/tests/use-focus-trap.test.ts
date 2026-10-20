import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, toRef } from 'vue'
import { mount } from '@vue/test-utils'
import { useFocusTrap } from '../composables/useFocusTrap'

const FocusTrapHarness = defineComponent({
  props: {
    open: { type: Boolean, default: false },
    nested: { type: Boolean, default: false },
  },
  setup(props) {
    const containerRef = ref<HTMLElement | null>(null)
    const innerRef = ref<HTMLElement | null>(null)
    useFocusTrap(containerRef, toRef(props, 'open'))
    useFocusTrap(innerRef, toRef(props, 'nested'))
    return () =>
      h('div', [
        h('button', { id: 'trigger' }, 'open'),
        props.open
          ? h('div', { id: 'drawer', ref: containerRef as unknown as string, tabindex: '-1' }, [
              h('button', { id: 'first' }, 'first'),
              h('button', { id: 'last' }, 'last'),
            ])
          : null,
        props.nested
          ? h('div', { ref: innerRef as unknown as string }, [
              h('button', { id: 'inner-button' }, 'Nested'),
            ])
          : null,
      ])
  },
})

describe('useFocusTrap', () => {
  it('returns focus inside an underlying trap when a nested drawer closes', async () => {
    vi.useFakeTimers()
    const wrapper = mount(FocusTrapHarness, { attachTo: document.body })
    try {
      document.getElementById('trigger')!.focus()
      await wrapper.setProps({ open: true })
      await nextTick()
      await nextTick()
      expect(document.activeElement?.id).toBe('first')
      await wrapper.setProps({ nested: true })
      await nextTick()
      await nextTick()
      expect(document.activeElement?.id).toBe('inner-button')
      await wrapper.setProps({ nested: false })
      await nextTick()
      await vi.advanceTimersByTimeAsync(0)
      expect(document.activeElement?.id).toBe('first')
      await wrapper.setProps({ open: false })
      await nextTick()
      await vi.advanceTimersByTimeAsync(0)
      expect(document.activeElement?.id).toBe('trigger')
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })

  it('moves focus into the drawer when it is rendered with v-if', async () => {
    const wrapper = mount(FocusTrapHarness, { attachTo: document.body })

    const trigger = document.getElementById('trigger') as HTMLButtonElement
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    await wrapper.setProps({ open: true })
    await nextTick()
    await nextTick()
    await nextTick()

    const first = document.getElementById('first') as HTMLButtonElement
    expect(document.activeElement).toBe(first)

    wrapper.unmount()
  })

  it('restores focus to the trigger when the drawer closes', async () => {
    const wrapper = mount(FocusTrapHarness, { attachTo: document.body })

    const trigger = document.getElementById('trigger') as HTMLButtonElement
    trigger.focus()

    await wrapper.setProps({ open: true })
    await nextTick()
    await nextTick()
    await nextTick()

    await wrapper.setProps({ open: false })
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await nextTick()

    expect(document.activeElement).toBe(trigger)

    wrapper.unmount()
  })
})
