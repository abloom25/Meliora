import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts'

const Host = defineComponent({
  setup() {
    const currentTime = ref(20)
    const duration = ref(100)
    const onToggle = vi.fn()
    const onSeek = vi.fn()
    const onNext = vi.fn()
    const onPrevious = vi.fn()
    const onToggleLyrics = vi.fn()

    useKeyboardShortcuts({
      currentTime,
      duration,
      onToggle,
      onSeek,
      onNext,
      onPrevious,
      onToggleLyrics,
    })

    return { onToggle, onSeek, onNext, onPrevious, onToggleLyrics }
  },
  template: `
    <main>
      <button type="button" id="play-button">Play</button>
      <a id="track-link" href="/track">Track</a>
      <select id="mode-select"><option>Loop</option></select>
      <div id="custom-button" role="button" tabindex="0">Custom</div>
    </main>
  `,
})

function keydown(target: EventTarget, code: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('useKeyboardShortcuts', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('handles global shortcuts when the page body is the target', async () => {
    const wrapper = mount(Host, { attachTo: document.body })

    const event = keydown(window, 'Space')

    expect(event.defaultPrevented).toBe(true)
    expect(wrapper.vm.onToggle).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not steal keyboard input from focused interactive controls', async () => {
    const wrapper = mount(Host, { attachTo: document.body })
    const button = document.getElementById('play-button')
    const link = document.getElementById('track-link')
    const select = document.getElementById('mode-select')
    const customButton = document.getElementById('custom-button')

    if (!button || !link || !select || !customButton) throw new Error('test controls missing')

    const buttonEvent = keydown(button, 'Space')
    const linkEvent = keydown(link, 'ArrowRight')
    const selectEvent = keydown(select, 'ArrowLeft')
    const customEvent = keydown(customButton, 'KeyL')

    expect(buttonEvent.defaultPrevented).toBe(false)
    expect(linkEvent.defaultPrevented).toBe(false)
    expect(selectEvent.defaultPrevented).toBe(false)
    expect(customEvent.defaultPrevented).toBe(false)
    expect(wrapper.vm.onToggle).not.toHaveBeenCalled()
    expect(wrapper.vm.onSeek).not.toHaveBeenCalled()
    expect(wrapper.vm.onToggleLyrics).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})
