import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePlayerStore } from '../stores/player'
import type { Track } from '../types/music'

const tracks: Track[] = [
  { id: '1', title: 'One', artist: 'A', audioUrl: '/1.mp3', kind: 'local' },
  { id: '2', title: 'Two', artist: 'B', audioUrl: '/2.mp3', kind: 'local' },
  { id: '3', title: 'Three', artist: 'C', audioUrl: '/3.mp3', kind: 'local' },
]

describe('player store', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('stops after the final track in sequence mode', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'sequence'
    store.selectTrack(tracks[2]!, tracks)
    expect(store.nextTrack(false)).toBeNull()
    expect(store.currentTrackId).toBe('3')
  })

  it('loops to the first track in loop mode', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'loop'
    store.selectTrack(tracks[2]!, tracks)
    expect(store.nextTrack(false)?.id).toBe('1')
  })

  it('keeps the current track in single mode on automatic advance', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'single'
    store.selectTrack(tracks[1]!, tracks)
    expect(store.nextTrack(false)?.id).toBe('2')
    expect(store.nextTrack(true)?.id).toBe('3')
  })

  it('selects a different track in shuffle mode', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'shuffle'
    store.selectTrack(tracks[0]!, tracks)
    expect(store.nextTrack(false)?.id).toBe('3')
  })

  it('preserves the active track object when refreshing the library', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.selectTrack(tracks[1]!, tracks)
    const activeTrack = store.currentTrack

    store.setTracks(tracks.map((track) => ({ ...track })))

    expect(store.currentTrack).toBe(activeTrack)
    expect(store.currentTrackId).toBe('2')
  })
})
