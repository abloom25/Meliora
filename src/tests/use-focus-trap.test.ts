import { describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref, watch } from 'vue'
import { mount } from '@vue/test-utils'
import { useFocusTrap } from '../composables/useFocusTrap'

const FocusTrapHarness = defineComponent({
  props: {
    open: { type: Boolean, default: false },
  },
  setup(props) {
    const containerRef = ref<HTMLElement | null>(null)
    const active = ref(props.open)
    watch(
      () => props.open,
      (value) => {
        active.value = value
      },
    )
    useFocusTrap(containerRef, active)
    return () =>
      h('div', [
        h('button', { id: 'trigger' }, 'open'),
        props.open
          ? h('div', { id: 'drawer', ref: containerRef as unknown as string, tabindex: '-1' }, [
              h('button', { id: 'first' }, 'first'),
              h('button', { id: 'last' }, 'last'),
            ])
          : null,
      ])
  },
})

describe('useFocusTrap', () => {
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
