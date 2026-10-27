import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import { usePlaybackPreferences } from '../platform/web/usePlaybackPreferences'
import { migrateSettings } from '../stores/player'
import { safeStorage } from '../platform/web/storage'

const key = 'meliora:tab-preferences:v1'
const mounted: VueWrapper[] = []
function page() {
  const settings = ref(migrateSettings({}))
  const wrapper = mount(
    defineComponent({
      setup() {
        usePlaybackPreferences(settings)
        return () => h('div')
      },
    }),
  )
  mounted.push(wrapper)
  return { settings, wrapper }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.runOnlyPendingTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
describe('shared tab preferences', () => {
  it('keeps defaults backwards compatible and validates saved switches', () => {
    expect(migrateSettings({})).toMatchObject({
      adaptivePerformance: true,
      tabCoordination: true,
      syncTabPlayback: false,
    })
    expect(
      migrateSettings({
        adaptivePerformance: false,
        tabCoordination: false,
        syncTabPlayback: true,
      }),
    ).toMatchObject({ adaptivePerformance: false, tabCoordination: false, syncTabPlayback: true })
    const invalid = JSON.parse(
      '{"adaptivePerformance":"false","tabCoordination":0,"syncTabPlayback":1}',
    )
    expect(migrateSettings(invalid)).toMatchObject({
      adaptivePerformance: true,
      tabCoordination: true,
      syncTabPlayback: false,
    })
  })
  it('propagates only coordination switches, without echo writes or changing volume and visual preferences', () => {
    const a = page()
    const b = page()
    b.settings.value.volume = 0.1
    b.settings.value.adaptivePerformance = false
    const write = vi.spyOn(safeStorage, 'setItem')
    a.settings.value.syncTabPlayback = true
    vi.advanceTimersByTime(149)
    expect(localStorage.getItem(key)).toBeNull()
    vi.advanceTimersByTime(1)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key) }))
    expect(b.settings.value.syncTabPlayback).toBe(true)
    expect(b.settings.value.volume).toBe(0.1)
    expect(b.settings.value.adaptivePerformance).toBe(false)
    vi.advanceTimersByTime(500)
    expect(write).toHaveBeenCalledTimes(1)
    const reopened = page()
    expect(reopened.settings.value.syncTabPlayback).toBe(true)
    a.settings.value.tabCoordination = false
    a.wrapper.unmount()
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key) }))
    expect(b.settings.value.tabCoordination).toBe(false)
    expect(b.settings.value.syncTabPlayback).toBe(true)
  })
  it('ignores corrupt mode messages and detaches its listener on unmount', () => {
    const a = page()
    for (const newValue of ['{broken', '{"tabCoordination":false}', 'null'])
      window.dispatchEvent(new StorageEvent('storage', { key, newValue }))
    expect(a.settings.value.tabCoordination).toBe(true)
    a.wrapper.unmount()
    window.dispatchEvent(
      new StorageEvent('storage', {
        key,
        newValue: JSON.stringify({ tabCoordination: false, syncTabPlayback: true }),
      }),
    )
    expect(a.settings.value.tabCoordination).toBe(true)
  })
})
