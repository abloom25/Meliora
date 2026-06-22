import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { usePwaInstall } from '../composables/usePwaInstall'

interface DisplayModeChange {
  matches: boolean
}

interface BeforeInstallPromptEventStub extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function createMatchMediaStub(initialMatches: boolean) {
  let matches = initialMatches
  const listeners = new Set<(event: DisplayModeChange) => void>()
  return {
    get matches() {
      return matches
    },
    media: '(display-mode: standalone)',
    onchange: null,
    addEventListener(_type: string, listener: (event: DisplayModeChange) => void) {
      listeners.add(listener)
    },
    removeEventListener(_type: string, listener: (event: DisplayModeChange) => void) {
      listeners.delete(listener)
    },
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false
    },
    emit(newMatches: boolean) {
      matches = newMatches
      listeners.forEach((listener) => listener({ matches: newMatches }))
    },
  }
}

function createBeforeInstallPromptStub(
  outcome: 'accepted' | 'dismissed',
): BeforeInstallPromptEventStub {
  const event = new Event('beforeinstallprompt')
  Object.defineProperty(event, 'prompt', {
    value: () => Promise.resolve(),
    configurable: true,
  })
  Object.defineProperty(event, 'userChoice', {
    value: Promise.resolve({ outcome, platform: 'web' }),
    configurable: true,
  })
  return event as BeforeInstallPromptEventStub
}

const TestComponent = defineComponent({
  setup() {
    const { canInstall, isInstalled, install } = usePwaInstall()
    return { canInstall, isInstalled, install }
  },
  render() {
    return h('div')
  },
})

describe('usePwaInstall', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports installed when the initial display mode is standalone', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(
      createMatchMediaStub(true) as unknown as MediaQueryList,
    )

    const wrapper = mount(TestComponent)
    expect(wrapper.vm.isInstalled).toBe(true)
  })

  it('reports not installed when the browser display mode is active', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(
      createMatchMediaStub(false) as unknown as MediaQueryList,
    )

    const wrapper = mount(TestComponent)
    expect(wrapper.vm.isInstalled).toBe(false)
  })

  it('updates isInstalled when the display-mode media query changes', async () => {
    const stub = createMatchMediaStub(false)
    vi.spyOn(window, 'matchMedia').mockReturnValue(stub as unknown as MediaQueryList)

    const wrapper = mount(TestComponent)
    expect(wrapper.vm.isInstalled).toBe(false)

    stub.emit(true)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.isInstalled).toBe(true)

    stub.emit(false)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.isInstalled).toBe(false)
  })

  it('clears the install prompt after the user accepts it', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(
      createMatchMediaStub(false) as unknown as MediaQueryList,
    )

    const wrapper = mount(TestComponent)
    expect(wrapper.vm.canInstall).toBe(false)

    const accepted = createBeforeInstallPromptStub('accepted')
    window.dispatchEvent(accepted)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.canInstall).toBe(true)

    const result = await wrapper.vm.install()
    expect(result).toBe(true)
    expect(wrapper.vm.canInstall).toBe(false)

    await expect(wrapper.vm.install()).resolves.toBe(false)
  })

  it('clears the install prompt after the user dismisses it', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(
      createMatchMediaStub(false) as unknown as MediaQueryList,
    )

    const wrapper = mount(TestComponent)
    expect(wrapper.vm.canInstall).toBe(false)

    const dismissed = createBeforeInstallPromptStub('dismissed')
    window.dispatchEvent(dismissed)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.canInstall).toBe(true)

    const result = await wrapper.vm.install()
    expect(result).toBe(false)
    expect(wrapper.vm.canInstall).toBe(false)

    await expect(wrapper.vm.install()).resolves.toBe(false)
  })

  it('re-enables install after a fresh beforeinstallprompt event following dismissal', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue(
      createMatchMediaStub(false) as unknown as MediaQueryList,
    )

    const wrapper = mount(TestComponent)

    const dismissed = createBeforeInstallPromptStub('dismissed')
    window.dispatchEvent(dismissed)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.canInstall).toBe(true)

    await wrapper.vm.install()
    expect(wrapper.vm.canInstall).toBe(false)

    const accepted = createBeforeInstallPromptStub('accepted')
    window.dispatchEvent(accepted as unknown as Event)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.canInstall).toBe(true)

    const result = await wrapper.vm.install()
    expect(result).toBe(true)
    expect(wrapper.vm.canInstall).toBe(false)
  })
})
