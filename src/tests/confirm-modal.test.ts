import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import ConfirmModal from '../admin/components/ConfirmModal.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ConfirmModal', () => {
  it('focuses cancel, traps Tab, handles Escape and restores the trigger', async () => {
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const wrapper = mount(ConfirmModal, {
      attachTo: document.body,
      props: { visible: false, title: '确认删除' },
    })
    await wrapper.setProps({ visible: true })
    await nextTick()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    const buttons = dialog.querySelectorAll<HTMLButtonElement>('button')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(buttons[0])
    buttons[1]!.focus()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(buttons[0])
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    )
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    await wrapper.setProps({ visible: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
  })

  it('does not cancel a pending operation from Escape or the backdrop', async () => {
    const wrapper = mount(ConfirmModal, {
      attachTo: document.body,
      props: { visible: true, loading: true },
    })
    await nextTick()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(document.activeElement).toBe(dialog)
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    document.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.querySelector<HTMLElement>('.confirm-modal-backdrop')!.click()
    expect(wrapper.emitted('cancel')).toBeUndefined()
    wrapper.unmount()
  })

  it('keeps backward Tab inside after buttons become enabled', async () => {
    const wrapper = mount(ConfirmModal, {
      attachTo: document.body,
      props: { visible: true, loading: true },
    })
    await nextTick()
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(document.activeElement).toBe(dialog)
    await wrapper.setProps({ loading: false })
    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    })
    document.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(dialog.querySelector('.confirm-modal-btn.confirm'))
    wrapper.unmount()
  })
})
