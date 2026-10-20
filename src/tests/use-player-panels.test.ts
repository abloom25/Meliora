import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { usePlayerPanels } from '../composables/usePlayerPanels'

afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function mountPanels(
  options: {
    mobile?: boolean
    phoneLandscape?: boolean
    compactLandscape?: boolean
    debugEnabled?: boolean
    autoHide?: boolean
  } = {},
) {
  let panels!: ReturnType<typeof usePlayerPanels>
  const debugAvailable = ref(options.debugEnabled ?? false)
  const settingsAvailable = ref(true)
  const wrapper = mount(
    defineComponent({
      setup() {
        panels = usePlayerPanels({
          compactViewport: ref(options.mobile ?? false),
          phoneDevice: ref(Boolean(options.mobile || options.phoneLandscape)),
          isCompactLandscape: ref(Boolean(options.phoneLandscape || options.compactLandscape)),
          isMobileSheet: ref(
            Boolean(options.mobile && !options.phoneLandscape && !options.compactLandscape),
          ),
          settingsAvailable,
          ...(options.debugEnabled === undefined ? {} : { debugAvailable }),
          autoHideChrome: () => options.autoHide ?? false,
          triggerHaptic: vi.fn(),
        })
        return () =>
          h('div', [
            h('button', { id: 'debug-trigger', onClick: panels.toggleDebug }, 'Debug'),
            h('button', { id: 'library-trigger', onClick: panels.toggleLibrary }, 'Library'),
            panels.listOpen.value
              ? h('div', { ref: 'libraryDrawerRef' }, [
                  h('span', { ref: 'libraryHandleRef' }),
                  options.phoneLandscape || options.compactLandscape
                    ? h(
                        'button',
                        { id: 'library-close', onClick: panels.closePanelsAnimated },
                        '关闭曲库',
                      )
                    : null,
                  h('input', { id: 'library-first', type: 'search', 'aria-label': '搜索歌曲' }),
                  h('button', { id: 'library-last' }, 'Last'),
                ])
              : null,
            panels.settingsOpen.value
              ? h('div', { ref: 'settingsDrawerRef' }, [
                  h('button', { id: 'settings-first', ref: 'settingsHandleRef' }, 'Settings'),
                ])
              : null,
            panels.debugOpen.value
              ? h('div', { ref: 'debugDrawerRef' }, [
                  h('button', { id: 'debug-first' }, 'First'),
                  h('button', { id: 'debug-last' }, 'Last'),
                ])
              : null,
          ])
      },
    }),
    { attachTo: document.body },
  )
  return { wrapper, panels, debugAvailable, settingsAvailable }
}

describe('player panels', () => {
  it.each([
    { mobile: true, phoneLandscape: false },
    { mobile: false, phoneLandscape: true },
  ])('does not autofocus the library search on a phone (%o)', async (options) => {
    const { wrapper, panels } = mountPanels(options)
    try {
      const trigger = document.getElementById('library-trigger')!
      trigger.focus()
      trigger.click()
      await nextTick()
      await nextTick()
      expect(panels.listOpen.value).toBe(true)
      expect(document.activeElement).toBe(trigger)
    } finally {
      wrapper.unmount()
    }
  })

  it.each([false, true])(
    'autofocuses desktop library search and restores its trigger on Escape (compactLandscape=%s)',
    async (compactLandscape) => {
      vi.useFakeTimers()
      const { wrapper, panels } = mountPanels({ compactLandscape })
      try {
        const trigger = document.getElementById('library-trigger')!
        trigger.focus()
        trigger.click()
        await nextTick()
        await nextTick()
        expect(document.activeElement?.id).toBe('library-first')
        if (compactLandscape) {
          document.getElementById('library-last')!.focus()
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
          expect(document.activeElement?.id).toBe('library-close')
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
        await nextTick()
        expect(panels.listOpen.value).toBe(false)
        await vi.advanceTimersByTimeAsync(0)
        expect(document.activeElement).toBe(trigger)
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('keeps keyboard entry, focus wrapping and Escape available on a landscape phone', async () => {
    vi.useFakeTimers()
    const { wrapper, panels } = mountPanels({ phoneLandscape: true })
    try {
      const trigger = document.getElementById('library-trigger')!
      trigger.focus()
      trigger.click()
      await nextTick()
      await nextTick()
      const first = document.getElementById('library-close')!
      const last = document.getElementById('library-last')!
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
      expect(document.activeElement).toBe(first)
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
      )
      expect(document.activeElement).toBe(last)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
      expect(document.activeElement).toBe(first)
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      await nextTick()
      expect(panels.listOpen.value).toBe(false)
      expect(wrapper.find('[aria-label="搜索歌曲"]').exists()).toBe(false)
      await vi.advanceTimersByTimeAsync(0)
      expect(document.activeElement).toBe(trigger)
    } finally {
      wrapper.unmount()
    }
  })

  it.each([false, true])(
    'hands off other drawers to debug immediately (mobile=%s)',
    async (mobile) => {
      vi.useFakeTimers()
      const { wrapper, panels } = mountPanels({ mobile, debugEnabled: true })
      try {
        panels.toggleLibrary()
        await nextTick()
        await vi.advanceTimersByTimeAsync(50)
        panels.toggleSettings()
        await nextTick()
        panels.toggleDebug()
        expect(panels.listOpen.value).toBe(false)
        expect(panels.settingsOpen.value).toBe(false)
        expect(panels.debugOpen.value).toBe(true)
        await nextTick()
        await nextTick()
        await vi.advanceTimersByTimeAsync(400)
        expect(document.activeElement?.id).toBe('debug-first')
        expect(panels.panelsSoftened.value).toBe(true)

        panels.toggleSettings()
        expect(panels.debugOpen.value).toBe(false)
        await nextTick()
        await nextTick()
        await vi.advanceTimersByTimeAsync(400)
        expect(panels.settingsOpen.value).toBe(true)
        expect(document.activeElement?.id).toBe('settings-first')

        panels.toggleDebug()
        await nextTick()
        panels.toggleLibrary()
        expect(panels.debugOpen.value).toBe(false)
        await nextTick()
        await vi.advanceTimersByTimeAsync(400)
        expect(panels.listOpen.value).toBe(true)
        expect(panels.settingsOpen.value).toBe(false)
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('keeps debug unavailable unless explicitly enabled', () => {
    const { wrapper, panels } = mountPanels()
    try {
      panels.toggleDebug()
      expect(panels.debugOpen.value).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('closes debug when its setting or the settings entry becomes unavailable', async () => {
    const { wrapper, panels, debugAvailable, settingsAvailable } = mountPanels({
      debugEnabled: true,
    })
    try {
      panels.toggleDebug()
      await nextTick()
      debugAvailable.value = false
      await nextTick()
      expect(panels.debugOpen.value).toBe(false)
      expect(panels.panelsSoftened.value).toBe(false)
      panels.toggleDebug()
      expect(panels.debugOpen.value).toBe(false)
      debugAvailable.value = true
      panels.toggleDebug()
      await nextTick()
      expect(panels.debugOpen.value).toBe(true)
      settingsAvailable.value = false
      await nextTick()
      expect(panels.debugOpen.value).toBe(false)
      panels.toggleDebug()
      expect(panels.debugOpen.value).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('traps debug focus and restores its trigger on Escape, also on mobile', async () => {
    vi.useFakeTimers()
    const { wrapper, panels } = mountPanels({ mobile: true, debugEnabled: true })
    try {
      const trigger = document.getElementById('debug-trigger')!
      trigger.focus()
      trigger.click()
      await nextTick()
      await nextTick()
      expect(document.activeElement?.id).toBe('debug-first')
      document.getElementById('debug-last')!.focus()
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
      expect(document.activeElement?.id).toBe('debug-first')
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
      expect(panels.debugOpen.value).toBe(false)
      await nextTick()
      await vi.advanceTimersByTimeAsync(0)
      expect(document.activeElement).toBe(trigger)
    } finally {
      wrapper.unmount()
    }
  })

  it('closes debug through the shared backdrop and topbar handlers', async () => {
    const { wrapper, panels } = mountPanels({ mobile: true, debugEnabled: true })
    try {
      panels.toggleDebug()
      await nextTick()
      panels.closePanelsAnimated()
      expect(panels.debugOpen.value).toBe(false)
      panels.toggleDebug()
      await nextTick()
      const event = new MouseEvent('click')
      Object.defineProperty(event, 'target', { value: document.getElementById('debug-first') })
      panels.onTopbarClick(event)
      expect(panels.debugOpen.value).toBe(true)
      panels.onTopbarClick(new MouseEvent('click'))
      expect(panels.debugOpen.value).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps chrome visible while debug is open and resumes the idle delay after closing', async () => {
    vi.useFakeTimers()
    const { wrapper, panels } = mountPanels({ debugEnabled: true, autoHide: true })
    try {
      window.dispatchEvent(new MouseEvent('mousemove'))
      await vi.advanceTimersByTimeAsync(30000)
      expect(panels.chromeHidden.value).toBe(true)
      panels.toggleDebug()
      await nextTick()
      expect(panels.chromeHidden.value).toBe(false)
      window.dispatchEvent(new MouseEvent('mousemove'))
      await vi.advanceTimersByTimeAsync(60000)
      expect(panels.chromeHidden.value).toBe(false)
      panels.closeDebugPanel()
      await nextTick()
      await vi.advanceTimersByTimeAsync(29999)
      expect(panels.chromeHidden.value).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(panels.chromeHidden.value).toBe(true)
    } finally {
      wrapper.unmount()
    }
  })
  it('binds extracted template refs, traps focus and keeps desktop drawers exclusive', async () => {
    const { wrapper, panels, settingsAvailable } = mountPanels()
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
      settingsAvailable.value = false
      await nextTick()
      expect(panels.settingsOpen.value).toBe(false)
      expect(panels.panelsSoftened.value).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })
})
