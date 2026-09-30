import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { usePlayerPanels } from '../composables/usePlayerPanels'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('player panels', () => {
  it('binds extracted template refs, traps focus and keeps desktop drawers exclusive', async () => {
    let panels!: ReturnType<typeof usePlayerPanels>
    const available = ref(true)
    const wrapper = mount(
      defineComponent({
        setup() {
          panels = usePlayerPanels({
            compactViewport: ref(false),
            phoneDevice: ref(false),
            isPhoneLandscape: ref(false),
            isMobileSheet: ref(false),
            settingsAvailable: available,
            autoHideChrome: () => false,
            triggerHaptic: vi.fn(),
          })
          return () =>
            h('div', [
              panels.listOpen.value
                ? h('div', { ref: 'libraryDrawerRef' }, [
                    h('button', { id: 'library-first', ref: 'libraryHandleRef' }, 'First'),
                    h('button', { id: 'library-last' }, 'Last'),
                  ])
                : null,
              panels.settingsOpen.value
                ? h('div', { ref: 'settingsDrawerRef' }, [
                    h('button', { id: 'settings-first', ref: 'settingsHandleRef' }, 'Settings'),
                  ])
                : null,
            ])
        },
      }),
      { attachTo: document.body },
    )
    try {
      panels.toggleLibrary()
      await nextTick()
      await nextTick()
      const first = document.getElementById('library-first')!
      const last = document.getElementById('library-last')!
      last.focus()
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      )
      expect(document.activeElement).toBe(first)
      panels.toggleSettings()
      await nextTick()
      expect(panels.listOpen.value).toBe(false)
      expect(panels.settingsOpen.value).toBe(true)
      available.value = false
      await nextTick()
      expect(panels.settingsOpen.value).toBe(false)
      expect(panels.panelsSoftened.value).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })
})
