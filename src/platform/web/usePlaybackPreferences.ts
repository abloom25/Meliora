import { onBeforeUnmount, watch, type Ref } from 'vue'
import type { PlayerSettings } from '../../core/types'
import { safeStorage } from './storage'

const KEY = 'meliora:tab-preferences:v1'

/** Coordination mode is shared; volume and visual preferences stay local to each page. */
export function usePlaybackPreferences(settings: Ref<PlayerSettings>): void {
  let applying = false
  let saveTimer: number | undefined
  function save(): void {
    saveTimer = undefined
    safeStorage.setItem(
      KEY,
      JSON.stringify({
        tabCoordination: settings.value.tabCoordination,
        syncTabPlayback: settings.value.syncTabPlayback,
      }),
    )
  }
  function receive(raw: string | null): void {
    if (!raw) return
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object') return
      const data = value as Record<string, unknown>
      if (typeof data.tabCoordination !== 'boolean' || typeof data.syncTabPlayback !== 'boolean')
        return
      if (saveTimer !== undefined) window.clearTimeout(saveTimer)
      saveTimer = undefined
      applying = true
      settings.value.tabCoordination = data.tabCoordination
      settings.value.syncTabPlayback = data.syncTabPlayback
    } catch {
      /* Ignore damaged preferences without changing the current mode. */
    } finally {
      applying = false
    }
  }
  receive(safeStorage.getItem(KEY))
  const stop = watch(
    () => [settings.value.tabCoordination, settings.value.syncTabPlayback],
    () => {
      if (applying) return
      if (saveTimer !== undefined) window.clearTimeout(saveTimer)
      saveTimer = window.setTimeout(save, 150)
    },
    { flush: 'sync' },
  )
  const storage = (event: StorageEvent): void => {
    if (event.key === KEY) receive(event.newValue)
  }
  window.addEventListener('storage', storage)
  onBeforeUnmount(() => {
    if (saveTimer !== undefined) {
      window.clearTimeout(saveTimer)
      save()
    }
    stop()
    window.removeEventListener('storage', storage)
  })
}
