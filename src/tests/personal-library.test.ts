import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Track } from '../core/types'
import { listeningTrackKey } from '../core/playback/listening-stats'
import { sanitizeFavoriteKeys, selectLibraryTracks } from '../core/library/personal-library'
import { useLibraryStore } from '../stores/library'
import { setSettingsStore } from '../platform/settings-store'

const tracks: Track[] = ['a', 'b', 'c'].map((id) => ({
  id,
  kind: 'local',
  title: 'Same title',
  artist: 'Artist',
  audioUrl: `/${id}`,
}))
const records = tracks.map((track, index) => ({
  key: listeningTrackKey(track),
  title: track.title,
  artist: track.artist,
  qualifiedPlays: 3 - index,
  listenedSeconds: 90,
  lastPlayedAt: index + 1,
}))

describe('personal library', () => {
  afterEach(() => setSettingsStore(null))
  beforeEach(() => {
    const memory = new Map<string, string>()
    setSettingsStore({
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => {
        memory.set(key, value)
      },
      removeItem: (key) => {
        memory.delete(key)
      },
    })
    setActivePinia(createPinia())
  })

  it('restores favorites by identity, independently of titles and audio URL refreshes', () => {
    const store = useLibraryStore()
    store.toggleFavorite(tracks[1]!)
    const refreshed = { ...tracks[1]!, audioUrl: '/renewed' }
    setActivePinia(createPinia())
    expect(useLibraryStore().isFavorite(refreshed)).toBe(true)
    expect(useLibraryStore().isFavorite(tracks[0]!)).toBe(false)
    expect(useLibraryStore().toggleFavorite(refreshed)).toBe(false)
  })

  it('sorts recent and frequent songs without changing the queue or source list', () => {
    expect(selectLibraryTracks(tracks, [], records, new Set(), 'recent').map((t) => t.id)).toEqual([
      'c',
      'b',
      'a',
    ])
    expect(
      selectLibraryTracks(tracks, [], records, new Set(), 'frequent').map((t) => t.id),
    ).toEqual(['a', 'b', 'c'])
    expect(
      selectLibraryTracks(tracks, [tracks[2]!, tracks[0]!], records, new Set(), 'queue').map(
        (t) => t.id,
      ),
    ).toEqual(['c', 'a'])
    expect(tracks.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('ignores unavailable history entries and invalid saved favorite values', () => {
    expect(selectLibraryTracks([tracks[0]!], [], records, new Set(), 'recent')).toEqual([tracks[0]])
    const key = listeningTrackKey(tracks[1]!)
    expect(sanitizeFavoriteKeys([null, 'bad', '[]', '["local",""]', key, key])).toEqual([key])
    expect(selectLibraryTracks(tracks, [], records, new Set([key]), 'favorites')).toEqual([
      tracks[1],
    ])
  })
})
