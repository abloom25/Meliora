import { effectScope, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryStore } from '../core/platform/storage'
import type { Track } from '../core/types'
import { setSettingsStore } from '../platform/settings-store'
import { useSongLyricsPreferences } from '../composables/useSongLyricsPreferences'

const first: Track = { kind: 'local', id: 'one', title: 'One', artist: 'A', audioUrl: '/one.mp3' }
const scopes: EffectScope[] = []
function harness() {
  const track = ref<Track | null>(first)
  const scope = effectScope()
  scopes.push(scope)
  const api = scope.run(() => useSongLyricsPreferences(track))!
  return { api, track }
}

describe('song lyrics preferences', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setSettingsStore(createMemoryStore())
  })
  afterEach(() => {
    scopes.splice(0).forEach((scope) => scope.stop())
    setSettingsStore(null)
    vi.useRealTimers()
  })

  it('remembers selection per song and timing independently for each actual source', () => {
    const { api, track } = harness()
    api.reportSource('amll')
    api.setSource('amll')
    api.setOffset(300)
    api.reportSource('qq')
    expect(api.offsetMs.value).toBe(0)
    api.setOffset(-200)
    api.reportSource('amll')
    expect(api.offsetMs.value).toBe(300)
    track.value = { ...first, id: 'two' }
    expect(api.selection.value).toBe('auto')
    expect(api.offsetMs.value).toBe(0)
    track.value = {
      ...first,
      title: 'Updated title',
      artist: 'Updated artist',
      album: 'New album',
      audioUrl: '/one.mp3?token=new',
    }
    expect(api.selection.value).toBe('amll')
    expect(api.offsetMs.value).toBe(300)
  })

  it('debounces persistence and restores only finite, bounded values', async () => {
    const storage = createMemoryStore()
    const write = vi.spyOn(storage, 'setItem')
    setSettingsStore(storage)
    const { api } = harness()
    api.reportSource('meting')
    api.setOffset(100)
    api.setOffset(200)
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(write).toHaveBeenCalledTimes(1)
    api.setOffset(Number.NaN)
    expect(api.offsetMs.value).toBe(200)
    // 新的平台存储包装模拟重新载入，持久数据仍是同一份。
    setSettingsStore({ ...storage })
    const restored = harness().api
    restored.reportSource('meting')
    expect(restored.offsetMs.value).toBe(200)
    restored.setOffset(999999)
    expect(restored.offsetMs.value).toBe(30000)
  })

  it('normalizes old Meting playlist IDs when restoring source and timing preferences', () => {
    const legacyKey = JSON.stringify([
      'meting',
      'meting:netease:playlist:7:https://music.test/?server=netease&type=url&id=123',
    ])
    setSettingsStore(
      createMemoryStore({
        'meliora.song-lyrics.v1': JSON.stringify({
          version: 1,
          songs: {
            [legacyKey]: { source: 'amll', offsets: { amll: -300 }, updatedAt: 12 },
          },
        }),
      }),
    )
    const { api, track } = harness()
    track.value = { ...first, kind: 'meting', id: 'meting:v2:netease:song:123' }
    api.reportSource('amll')
    expect(api.selection.value).toBe('amll')
    expect(api.offsetMs.value).toBe(-300)
  })
})
