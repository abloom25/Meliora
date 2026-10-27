import { describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, toRef } from 'vue'
import { mount } from '@vue/test-utils'
import { useFocusTrap } from '../composables/useFocusTrap'

const FocusTrapHarness = defineComponent({
  props: {
    open: { type: Boolean, default: false },
    nested: { type: Boolean, default: false },
    autoFocus: { type: Boolean, default: true },
    initialFocusSelector: { type: String, default: '' },
    disableLast: { type: Boolean, default: false },
    rovingTabs: { type: Boolean, default: false },
  },
  setup(props) {
    const containerRef = ref<HTMLElement | null>(null)
    const innerRef = ref<HTMLElement | null>(null)
    useFocusTrap(containerRef, toRef(props, 'open'), undefined, {
      autoFocus: toRef(props, 'autoFocus'),
      initialFocus: () =>
        props.initialFocusSelector
          ? document.querySelector<HTMLElement>(props.initialFocusSelector)
          : null,
    })
    useFocusTrap(innerRef, toRef(props, 'nested'))
    return () =>
      h('div', [
        h('button', { id: 'trigger' }, 'open'),
        props.open
          ? h('div', { id: 'drawer', ref: containerRef as unknown as string, tabindex: '-1' }, [
              props.rovingTabs
                ? h('button', { id: 'inactive-category', role: 'tab', tabindex: -1 }, '全部')
                : null,
              h(
                'button',
                { id: 'first', role: props.rovingTabs ? 'tab' : undefined, tabindex: 0 },
                'first',
              ),
              h('button', { id: 'last', disabled: props.disableLast }, 'last'),
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
  it('wraps Tab around the selected roving tab instead of a programmatically focusable inactive tab', async () => {
    const wrapper = mount(FocusTrapHarness, {
      props: { open: true, rovingTabs: true },
      attachTo: document.body,
    })
    try {
      await nextTick()
      await nextTick()
      const selected = wrapper.get<HTMLButtonElement>('#first').element
      const last = wrapper.get<HTMLButtonElement>('#last').element
      expect(document.activeElement).toBe(selected)
      const backwards = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
      selected.dispatchEvent(backwards)
      expect(backwards.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(last)
      const forwards = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      last.dispatchEvent(forwards)
      expect(forwards.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(selected)
    } finally {
      wrapper.unmount()
    }
  })

  it.each([
    { initialFocusSelector: '#last', disableLast: false, expected: 'last' },
    { initialFocusSelector: '#trigger', disableLast: false, expected: 'first' },
    { initialFocusSelector: '#missing', disableLast: false, expected: 'first' },
    { initialFocusSelector: '#last', disableLast: true, expected: 'first' },
  ])('uses an available initial target inside the trap or falls back (%o)', async (options) => {
    const { expected, ...props } = options
    const wrapper = mount(FocusTrapHarness, { props, attachTo: document.body })
    try {
      document.getElementById('trigger')!.focus()
      await wrapper.setProps({ open: true })
      await nextTick()
      await nextTick()
      expect(document.activeElement?.id).toBe(expected)
    } finally {
      wrapper.unmount()
    }
  })

  it('does not focus the preferred target when automatic focus is disabled', async () => {
    const wrapper = mount(FocusTrapHarness, {
      props: { autoFocus: false, initialFocusSelector: '#last' },
      attachTo: document.body,
    })
    try {
      document.getElementById('trigger')!.focus()
      await wrapper.setProps({ open: true })
      await nextTick()
      await nextTick()
      expect(document.activeElement?.id).toBe('trigger')
    } finally {
      wrapper.unmount()
    }
  })

  it.each([true, false])(
    'returns focus inside an underlying trap when a nested drawer closes (autoFocus=%s)',
    async (autoFocus) => {
      vi.useFakeTimers()
      const wrapper = mount(FocusTrapHarness, {
        props: { autoFocus },
        attachTo: document.body,
      })
      try {
        document.getElementById('trigger')!.focus()
        await wrapper.setProps({ open: true })
        await nextTick()
        await nextTick()
        expect(document.activeElement?.id).toBe(autoFocus ? 'first' : 'trigger')
        document.getElementById('first')!.focus()
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
    },
  )

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
