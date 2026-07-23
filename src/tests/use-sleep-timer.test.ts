import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useSleepTimer } from '../composables/useSleepTimer'

function mountSleepTimer() {
  const onPause = vi.fn()
  const onShowNotice = vi.fn()
  const Harness = defineComponent({
    setup() {
      const timer = useSleepTimer({ onPause, onShowNotice })
      return { timer }
    },
    render() {
      return h('div', { id: 'harness' })
    },
  })
  const wrapper = mount(Harness)
  const timer = wrapper.vm.timer as ReturnType<typeof useSleepTimer>
  return { wrapper, timer, onPause, onShowNotice }
}

function setDocumentHidden(hidden: boolean) {
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(hidden)
}

describe('useSleepTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('stops playback when the timer expires on schedule', () => {
    setDocumentHidden(false)
    const { timer, onPause, onShowNotice } = mountSleepTimer()
    timer.setSleepTimer(15)

    vi.advanceTimersByTime(15 * 60 * 1000)

    expect(onPause).toHaveBeenCalledTimes(1)
    expect(onShowNotice).toHaveBeenLastCalledWith('定时关闭已完成')
    expect(timer.sleepTimerRemaining.value).toBe(0)
  })

  it('stops immediately on visibilitychange when the deadline passed while throttled in background', () => {
    setDocumentHidden(false)
    const { timer, onPause, onShowNotice } = mountSleepTimer()
    timer.setSleepTimer(15)

    // 模拟后台节流：系统时间已过到点，但链式 setTimeout 一次都没触发
    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 5000)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(onPause).toHaveBeenCalledTimes(1)
    expect(onShowNotice).toHaveBeenLastCalledWith('定时关闭已完成')
    expect(timer.sleepTimerMinutes.value).toBe(0)
    expect(timer.sleepTimerRemaining.value).toBe(0)
  })

  it('does not stop on visibilitychange before the deadline', () => {
    setDocumentHidden(false)
    const { timer, onPause } = mountSleepTimer()
    timer.setSleepTimer(15)

    vi.setSystemTime(Date.now() + 60 * 1000)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(onPause).not.toHaveBeenCalled()
    expect(timer.sleepTimerRemaining.value).toBeGreaterThan(0)
  })

  it('ignores visibilitychange while the document is still hidden', () => {
    setDocumentHidden(true)
    const { timer, onPause } = mountSleepTimer()
    timer.setSleepTimer(15)

    vi.setSystemTime(Date.now() + 20 * 60 * 1000)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(onPause).not.toHaveBeenCalled()
  })

  it('removes the visibilitychange listener on unmount', () => {
    setDocumentHidden(false)
    const { wrapper, timer, onPause } = mountSleepTimer()
    timer.setSleepTimer(15)
    wrapper.unmount()

    vi.setSystemTime(Date.now() + 20 * 60 * 1000)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(onPause).not.toHaveBeenCalled()
  })
})
