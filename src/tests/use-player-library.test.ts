import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { usePlayerLibrary } from '../composables/usePlayerLibrary'
import { usePlayerStore } from '../stores/player'
import { loadConfiguredTracks, type TrackLoadResult } from '../services/music'
import type { Track } from '../core/types'

vi.mock('../services/music', () => ({
  loadConfiguredTracks: vi.fn(),
  loadMusicConfig: () => ({ siteName: 'Test', apiEndpoint: '', playlists: [], localTracks: [] }),
}))
vi.mock('../platform/web/site-integrations', () => ({ applySiteIntegrations: vi.fn() }))

const track: Track = {
  id: 'new',
  title: 'New',
  artist: 'Test',
  audioUrl: '/new.mp3',
  kind: 'local',
}

function deferred() {
  let resolve!: (result: TrackLoadResult) => void
  const promise = new Promise<TrackLoadResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setup() {
  let library!: ReturnType<typeof usePlayerLibrary>
  const showNotice = vi.fn()
  const wrapper = mount(
    defineComponent({
      setup() {
        library = usePlayerLibrary({ showNotice, clearNotice: vi.fn() })
        return () => h('div')
      },
    }),
  )
  return { library, wrapper, showNotice, store: usePlayerStore() }
}

describe('player library lifecycle', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(loadConfiguredTracks).mockReset()
  })
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('ignores stale results and keeps the newest request loading', async () => {
    const old = deferred()
    const latest = deferred()
    vi.mocked(loadConfiguredTracks)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(latest.promise)
    const { library, wrapper, store, showNotice } = setup()
    try {
      const first = library.loadTracks()
      const second = library.loadTracks()
      old.resolve({ tracks: [], failedSources: 1 })
      await first
      expect(library.loading.value).toBe(true)
      expect(showNotice).not.toHaveBeenCalled()
      latest.resolve({ tracks: [track], failedSources: 0 })
      await second
      expect(store.tracks.map((entry) => entry.id)).toEqual(['new'])
      expect(library.loading.value).toBe(false)
      expect(library.loadFailed.value).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })

  it('does not update the store, share URL or notices after unmount', async () => {
    const pending = deferred()
    vi.mocked(loadConfiguredTracks).mockReturnValue(pending.promise)
    const { library, wrapper, store, showNotice } = setup()
    window.history.replaceState(null, '', '/?share=new')
    const loading = library.loadTracks()
    wrapper.unmount()
    pending.resolve({ tracks: [track], failedSources: 1 })
    await loading
    expect(store.tracks).toEqual([])
    expect(window.location.search).toBe('?share=new')
    expect(showNotice).not.toHaveBeenCalled()
  })
})
