import { afterEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, enableAutoUnmount, mount } from '@vue/test-utils'
import { h, nextTick } from 'vue'
import Dropdown from '../components/Dropdown.vue'

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function dropdown(teleport = false) {
  return mount(Dropdown, {
    attachTo: document.body,
    props: { teleport, label: '测试菜单' },
    slots: {
      trigger: ({ toggle }: { toggle: () => void }) => h('button', { onClick: toggle }, '菜单'),
      default: ({ close }: { close: () => void }) => [
        h('button', { onClick: close }, '第一项'),
        h('button', { disabled: true }, '不可用'),
        h('button', { onClick: close }, '最后一项'),
      ],
    },
  })
}
function menu(): DOMWrapper<HTMLElement> {
  return new DOMWrapper(document.querySelector<HTMLElement>('[role="menu"]')!)
}
function bounds(width: number, height: number): DOMRect {
  return {
    width,
    height,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }
}

describe('Dropdown', () => {
  it('preserves ordinary dropdown keyboard navigation and restores its trigger', async () => {
    const wrapper = dropdown()
    const trigger = wrapper.get<HTMLButtonElement>('button')
    await trigger.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.find('[role="menu"]').exists()).toBe(true)
    expect(document.activeElement?.textContent).toBe('第一项')
    await menu().trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('最后一项')
    await menu().trigger('keydown', { key: 'Home' })
    expect(document.activeElement?.textContent).toBe('第一项')
    await menu().trigger('keydown', { key: 'Escape' })
    expect(document.activeElement).toBe(trigger.element)
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })
  it('teleports the menu, contains Escape, and returns Tab focus to the logical trigger', async () => {
    const wrapper = dropdown(true)
    const trigger = wrapper.get<HTMLButtonElement>('button')
    await trigger.trigger('click')
    expect(wrapper.find('[role="menu"]').exists()).toBe(false)
    const keydown = vi.fn()
    document.addEventListener('keydown', keydown)
    try {
      await menu().trigger('keydown', { key: 'Escape' })
      expect(keydown).not.toHaveBeenCalled()
      await trigger.trigger('click')
      await menu().trigger('keydown', { key: 'Tab' })
      expect(keydown).toHaveBeenCalledOnce()
      expect(document.activeElement).toBe(trigger.element)
      expect(document.querySelector('[role="menu"]')).toBeNull()
    } finally {
      document.removeEventListener('keydown', keydown)
    }
  })
  it('removes outgoing controls from keyboard interaction before the leave transition finishes', async () => {
    const wrapper = dropdown()
    const trigger = wrapper.get('button')
    await trigger.trigger('click')
    const outgoing = menu().element
    wrapper.vm.close()
    expect(outgoing.inert).toBe(true)
    expect(document.activeElement).toBe(trigger.element)
    await nextTick()
    await trigger.trigger('click')
    expect(menu().element.inert).toBe(false)
    expect(document.activeElement?.textContent).toBe('第一项')
  })
  it('clamps context menus into the visual viewport including its width', async () => {
    vi.stubGlobal('visualViewport', {
      width: 220,
      height: 180,
      offsetLeft: 20,
      offsetTop: 40,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds(160, 120))
    const wrapper = dropdown(true)
    await wrapper.vm.openAt({ x: 500, y: 600 }, wrapper.get('button').element)
    await nextTick()
    const style = menu().element.style
    expect(style.left).toBe('72px')
    expect(style.top).toBe('92px')
    expect(style.maxWidth).toBe('204px')
    expect(style.maxHeight).toBe('164px')
  })
  it('remeasures expanded viewport constraints before placing a menu after keyboard dismissal', async () => {
    vi.stubGlobal('innerWidth', 400)
    vi.stubGlobal('innerHeight', 240)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return bounds(160, Math.min(350, Number.parseFloat(this.style.maxHeight) || 350))
    })
    const wrapper = dropdown(true)
    await wrapper.vm.openAt({ x: 100, y: 580 }, wrapper.get('button').element)
    await nextTick()
    expect(menu().element.style.maxHeight).toBe('224px')
    vi.stubGlobal('innerHeight', 640)
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(menu().element.style.top).toBe('282px')
    expect(menu().element.style.maxHeight).toBe('624px')
  })
  it('clamps the full menu size while its entrance animation is scaled down', async () => {
    vi.stubGlobal('innerWidth', 320)
    vi.stubGlobal('innerHeight', 240)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(bounds(160, 120))
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180)
    const wrapper = dropdown(true)
    await wrapper.vm.openAt({ x: 310, y: 230 }, wrapper.get('button').element)
    const style = menu().element.style
    expect(style.left).toBe('112px')
    expect(style.top).toBe('52px')
    expect(style.transformOrigin).toBe('198px 178px')
  })
  it('keeps inside clicks and scrolling inside the menu open, while external interactions dismiss', async () => {
    const wrapper = dropdown(true)
    await wrapper.get('button').trigger('click')
    await menu().trigger('click')
    await menu().trigger('scroll')
    expect(menu().exists()).toBe(true)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(document.querySelector('[role="menu"]')).toBeNull()
    await wrapper.get('button').trigger('click')
    document.body.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})
