import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import Toast from '../components/Toast.vue'

function queryToast(): HTMLElement | null {
  return document.body.querySelector('.app-toast')
}

describe('Toast accessibility', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('uses role="alert" with an assertive live region for errors', () => {
    const wrapper = mount(Toast, {
      props: { message: '出错了', type: 'error' },
      attachTo: document.body,
    })

    const toast = queryToast()
    expect(toast?.getAttribute('role')).toBe('alert')
    expect(toast?.getAttribute('aria-live')).toBe('assertive')
    wrapper.unmount()
  })

  it('uses role="status" with a polite live region for non-error types', () => {
    for (const type of ['success', 'info', undefined] as const) {
      const wrapper = mount(Toast, {
        props: { message: '提示', type },
        attachTo: document.body,
      })

      const toast = queryToast()
      expect(toast?.getAttribute('role')).toBe('status')
      expect(toast?.getAttribute('aria-live')).toBe('polite')
      wrapper.unmount()
    }
  })
})
