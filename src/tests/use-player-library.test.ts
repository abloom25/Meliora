import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { usePlayerLibrary } from '../composables/usePlayerLibrary'
import { usePlayerStore } from '../stores/player'
import { loadConfiguredTracks, type TrackLoadResult } from '../services/music'
import type { Track } from '../core/types'
import { createTrackShareId } from '../core/library/tracks'

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

function setup(onOpenSharedTrack?: (track: Track, seconds: number | null) => void) {
  let library!: ReturnType<typeof usePlayerLibrary>
  const showNotice = vi.fn()
  const wrapper = mount(
    defineComponent({
      setup() {
        library = usePlayerLibrary({ showNotice, clearNotice: vi.fn(), onOpenSharedTrack })
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

  it('shows progressive tracks and resolves a late shared song without losing the hash', async () => {
    const pending = deferred()
    let progress!: NonNullable<
      import('../services/music').LoadConfiguredTracksOptions['onProgress']
    >
    vi.mocked(loadConfiguredTracks).mockImplementation((_config, options) => {
      progress = options!.onProgress!
      return pending.promise
    })
    const { library, wrapper, store } = setup()
    window.history.replaceState(null, '', `/?share=${createTrackShareId(track)}&view=lyrics#saved`)
    try {
      const loading = library.loadTracks()
      progress({ tracks: [{ ...track, id: 'early', title: 'Early' }], failedSources: 0 })
      expect(store.tracks).toHaveLength(1)
      expect(library.loading.value).toBe(false)
      expect(window.location.search).toContain('share=')
      progress({ tracks: [track], failedSources: 0 })
      expect(store.currentTrackId).toBe(track.id)
      expect(window.location.search).toBe('?view=lyrics')
      expect(window.location.hash).toBe('#saved')
      pending.resolve({ tracks: [track], failedSources: 0 })
      await loading
    } finally {
      wrapper.unmount()
    }
  })

  it('aborts stale requests and ignores their progress callbacks', async () => {
    const first = deferred()
    const second = deferred()
    const requests: import('../services/music').LoadConfiguredTracksOptions[] = []
    vi.mocked(loadConfiguredTracks).mockImplementation((_config, options) => {
      requests.push(options!)
      return requests.length === 1 ? first.promise : second.promise
    })
    const { library, wrapper, store } = setup()
    try {
      const old = library.loadTracks()
      const latest = library.loadTracks()
      expect(requests[0]?.signal?.aborted).toBe(true)
      requests[0]?.onProgress?.({ tracks: [track], failedSources: 0 })
      expect(store.tracks).toEqual([])
      first.resolve({ tracks: [], failedSources: 0 })
      second.resolve({ tracks: [track], failedSources: 0 })
      await Promise.all([old, latest])
      expect(store.tracks[0]?.id).toBe(track.id)
    } finally {
      wrapper.unmount()
    }
  })

  it('hands a late shared timestamp to the audio owner exactly once', async () => {
    const pending = deferred()
    let progress!: NonNullable<
      import('../services/music').LoadConfiguredTracksOptions['onProgress']
    >
    vi.mocked(loadConfiguredTracks).mockImplementation((_config, options) => {
      progress = options!.onProgress!
      return pending.promise
    })
    const open = vi.fn()
    const { library, wrapper } = setup(open)
    window.history.replaceState(
      null,
      '',
      `/?share=${createTrackShareId(track)}&t=80.125&view=lyrics#saved`,
    )
    try {
      const loading = library.loadTracks()
      progress({ tracks: [{ ...track, id: 'early', title: 'Early' }], failedSources: 0 })
      expect(open).not.toHaveBeenCalled()
      progress({ tracks: [track], failedSources: 0 })
      expect(open).toHaveBeenCalledExactlyOnceWith(track, 80.125)
      expect(window.location.search).toBe('?view=lyrics')
      expect(window.location.hash).toBe('#saved')
      pending.resolve({ tracks: [track], failedSources: 0 })
      await loading
      expect(open).toHaveBeenCalledTimes(1)
    } finally {
      wrapper.unmount()
    }
  })

  it.each(['', '&t=NaN', '&t=-10', '&t=Infinity', '&t=86401'])(
    'opens a song without an unsafe or absent timestamp: %s',
    async (time) => {
      vi.mocked(loadConfiguredTracks).mockResolvedValue({ tracks: [track], failedSources: 0 })
      const open = vi.fn()
      const { library, wrapper } = setup(open)
      window.history.replaceState(null, '', `/?share=${createTrackShareId(track)}${time}`)
      try {
        await library.loadTracks()
        expect(open).toHaveBeenCalledExactlyOnceWith(track, null)
        expect(window.location.search).toBe('')
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('never treats a timestamp without a shared song as a seek request', async () => {
    vi.mocked(loadConfiguredTracks).mockResolvedValue({ tracks: [track], failedSources: 0 })
    const open = vi.fn()
    const { library, wrapper } = setup(open)
    window.history.replaceState(null, '', '/?t=80')
    try {
      await library.loadTracks()
      expect(open).not.toHaveBeenCalled()
      expect(window.location.search).toBe('?t=80')
    } finally {
      wrapper.unmount()
    }
  })

  it('keeps legacy shared song selection paused when there is no audio owner', async () => {
    vi.mocked(loadConfiguredTracks).mockResolvedValue({ tracks: [track], failedSources: 0 })
    const { library, wrapper, store } = setup()
    store.isPlaying = true
    window.history.replaceState(null, '', `/?share=${createTrackShareId(track)}`)
    try {
      await library.loadTracks()
      expect(store.currentTrackId).toBe(track.id)
      expect(store.isPlaying).toBe(false)
    } finally {
      wrapper.unmount()
    }
  })
})
