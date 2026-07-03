import { mount } from '@vue/test-utils'
import { defineComponent, nextTick, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDrawerSheet } from '../composables/useDrawerSheet'

const Host = defineComponent({
  setup() {
    const active = ref(true)
    const containerRef = ref<HTMLElement | null>(null)
    const onDismiss = vi.fn(() => {
      active.value = false
    })
    const sheet = useDrawerSheet({
      containerRef,
      active,
      onDismiss,
      sheetHeight: () => 600,
    })

    return {
      active,
      containerRef,
      onDismiss,
      dismissAnimated: sheet.dismissAnimated,
      resetPosition: sheet.resetPosition,
    }
  },
  template: '<div v-if="active" ref="containerRef" class="sheet"></div>',
})

describe('useDrawerSheet', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('cancels a pending dismiss timer when the sheet is repositioned open again', async () => {
    vi.useFakeTimers()
    const wrapper = mount(Host, { attachTo: document.body })
    wrapper.vm.resetPosition('full')

    wrapper.vm.dismissAnimated()
    wrapper.vm.resetPosition('full')
    await nextTick()
    await vi.advanceTimersByTimeAsync(400)

    expect(wrapper.vm.onDismiss).not.toHaveBeenCalled()
    expect(wrapper.vm.active).toBe(true)
    wrapper.unmount()
  })
})
