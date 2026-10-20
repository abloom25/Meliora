import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useJsonDownload } from '../platform/web/useJsonDownload'

function harness() {
  let api!: ReturnType<typeof useJsonDownload>
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useJsonDownload()
        return () => h('div')
      },
    }),
  )
  return { api, wrapper }
}

beforeEach(() => {
  vi.useFakeTimers()
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:test'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('useJsonDownload', () => {
  it('downloads JSON, suppresses duplicate clicks, and releases the blob after acceptance', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      expect(this.isConnected).toBe(true)
      expect(this.download).toBe('comparison.json')
      expect(this.href).toBe('blob:test')
    })
    const { api, wrapper } = harness()
    const data = vi.fn(() => ({ schemaVersion: 1, observedSamples: [{ value: null }] }))
    const result = api.download(data, 'comparison.json')
    expect(api.exporting.value).toBe(true)
    expect(await api.download(data, 'duplicate.json')).toBe(false)
    expect(await result).toBe(true)
    expect(click).toHaveBeenCalledTimes(1)
    expect(data).toHaveBeenCalledTimes(1)
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0]![0] as Blob
    expect(blob.type).toBe('application/json;charset=utf-8')
    expect(await blob.text()).toContain('"observedSamples"')
    expect(document.querySelector('a')).toBeNull()
    expect(URL.revokeObjectURL).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1000)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
    wrapper.unmount()
  })

  it('cleans up failed clicks and reports a friendly error without exposing its cause', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('private URL')
    })
    const { api, wrapper } = harness()
    expect(await api.download(() => ({ value: 1 }), 'test.json')).toBe(false)
    expect(api.error.value).toContain('导出失败')
    expect(api.error.value).not.toContain('private')
    expect(document.querySelector('a')).toBeNull()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
    expect(api.exporting.value).toBe(false)
    api.clearError()
    expect(api.error.value).toBeNull()
    wrapper.unmount()
  })

  it('cancels a queued export and pending URL cleanup on unmount', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    const first = harness()
    const result = first.api.download(() => ({ ok: true }), 'test.json')
    first.wrapper.unmount()
    expect(await result).toBe(false)
    expect(click).not.toHaveBeenCalled()
    const second = harness()
    await second.api.download(() => ({ ok: true }), 'test.json')
    expect(vi.getTimerCount()).toBe(1)
    second.wrapper.unmount()
    await flushPromises()
    expect(vi.getTimerCount()).toBe(0)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test')
  })
})
