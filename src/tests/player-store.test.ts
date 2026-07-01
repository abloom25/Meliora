import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { migrateSettings, usePlayerStore } from '../stores/player'
import type { PlayerSettings, Track } from '../types/music'

const tracks: Track[] = [
  {
    id: '1',
    title: 'One',
    artist: 'A',
    audioUrl: '/1.mp3',
    kind: 'local',
  },
  {
    id: '2',
    title: 'Two',
    artist: 'B',
    audioUrl: '/2.mp3',
    kind: 'local',
  },
  {
    id: '3',
    title: 'Three',
    artist: 'C',
    audioUrl: '/3.mp3',
    kind: 'local',
  },
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

  it('syncs the queue when refreshing the library, removes deleted tracks, and preserves the active object', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.selectTrack(tracks[1]!, [tracks[2]!, tracks[1]!, tracks[0]!])
    const activeTrack = store.currentTrack
    const nextTracks: Track[] = [
      { ...tracks[1]!, title: 'Two updated' },
      { ...tracks[2]!, title: 'Three updated' },
      { id: '4', title: 'Four', artist: 'D', audioUrl: '/4.mp3', kind: 'local' },
    ]

    store.setTracks(nextTracks)

    expect(store.currentTrack).toBe(activeTrack)
    expect(store.queue.map((track) => track.id)).toEqual(['3', '2', '4'])
    expect(store.queue[1]).toBe(activeTrack)
    expect(store.tracks.map((track) => track.id)).toEqual(['2', '3', '4'])
    expect(store.currentTrackId).toBe('2')
  })

  it('clears the current track when it no longer exists after refreshing the library', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.selectTrack(tracks[1]!, tracks)

    store.setTracks([tracks[0]!, tracks[2]!])

    expect(store.currentTrackId).toBeNull()
    expect(store.queue.map((track) => track.id)).toEqual(['1', '3'])
  })
})

describe('player store peekNext / peekPrevious', () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('peekNext returns null on an empty queue', () => {
    const store = usePlayerStore()
    store.settings.playMode = 'loop'
    expect(store.peekNext()).toBeNull()
  })

  it('peekNext steps forward in loop mode and wraps to the first track at the end', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'loop'
    store.selectTrack(tracks[0]!, tracks)
    expect(store.peekNext()?.id).toBe('2')
    store.selectTrack(tracks[2]!, tracks)
    expect(store.peekNext()?.id).toBe('1')
  })

  it('peekNext returns null at the final track in sequence mode', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'sequence'
    store.selectTrack(tracks[2]!, tracks)
    expect(store.peekNext()).toBeNull()
  })

  it('peekNext steps forward in sequence mode when not at the end', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'sequence'
    store.selectTrack(tracks[0]!, tracks)
    expect(store.peekNext()?.id).toBe('2')
  })

  it('peekNext returns the current track in single mode on automatic advance', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'single'
    store.selectTrack(tracks[1]!, tracks)
    expect(store.peekNext(false)?.id).toBe('2')
  })

  it('peekNext advances normally in single mode on manual advance', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'single'
    store.selectTrack(tracks[1]!, tracks)
    expect(store.peekNext(true)?.id).toBe('3')
  })

  it('peekNext picks a different track in shuffle mode', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9)
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'shuffle'
    store.selectTrack(tracks[0]!, tracks)
    expect(store.peekNext()?.id).toBe('3')
  })

  it('peekNext never returns the current track in shuffle mode', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'shuffle'
    store.selectTrack(tracks[1]!, tracks)
    expect(store.peekNext()?.id).toBe('1')
  })

  it('peekNext is pure and does not mutate the current track state', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'loop'
    store.selectTrack(tracks[0]!, tracks)
    store.currentTime = 12
    const beforeId = store.currentTrackId
    const beforeQueueVersion = store.queueVersion
    const beforeTime = store.currentTime

    const peeked = store.peekNext()

    expect(peeked?.id).toBe('2')
    expect(store.currentTrackId).toBe(beforeId)
    expect(store.queueVersion).toBe(beforeQueueVersion)
    expect(store.currentTime).toBe(beforeTime)
  })

  it('peekPrevious returns null on an empty queue', () => {
    const store = usePlayerStore()
    expect(store.peekPrevious()).toBeNull()
  })

  it('peekPrevious steps back by one track', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.selectTrack(tracks[2]!, tracks)
    expect(store.peekPrevious()?.id).toBe('2')
  })

  it('peekPrevious wraps to the last track from the first', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.selectTrack(tracks[0]!, tracks)
    expect(store.peekPrevious()?.id).toBe('3')
  })

  it('peekPrevious is pure and does not mutate the current track state', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.selectTrack(tracks[1]!, tracks)
    store.currentTime = 7
    const beforeId = store.currentTrackId
    const beforeQueueVersion = store.queueVersion
    const beforeTime = store.currentTime

    const peeked = store.peekPrevious()

    expect(peeked?.id).toBe('1')
    expect(store.currentTrackId).toBe(beforeId)
    expect(store.queueVersion).toBe(beforeQueueVersion)
    expect(store.currentTime).toBe(beforeTime)
  })

  it('nextTrack still applies the preferred track id when provided', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.settings.playMode = 'loop'
    store.selectTrack(tracks[0]!, tracks)
    expect(store.nextTrack(false, '3')?.id).toBe('3')
    expect(store.currentTrackId).toBe('3')
  })

  it('previousTrack still applies the preferred track id when provided', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.selectTrack(tracks[2]!, tracks)
    expect(store.previousTrack('1')?.id).toBe('1')
    expect(store.currentTrackId).toBe('1')
  })
})

describe('player settings migration', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('defaultSettings has settingsVersion 1', () => {
    const result = migrateSettings({})
    expect(result.settingsVersion).toBe(1)
    expect(result.volume).toBe(0.72)
    expect(result.playMode).toBe('loop')
    expect(result.smoothTrackChange).toBe(true)
    expect(result.autoHideChrome).toBe(true)
    expect(result.lyricTranslation).toBe(true)
  })

  it('migrates legacy settings without settingsVersion to version 1 while preserving user preferences', () => {
    const legacy: Partial<PlayerSettings> = {
      volume: 0.3,
      playMode: 'shuffle',
      backgroundBlur: 50,
      lyricFontSize: 24,
    }
    const result = migrateSettings(legacy)

    expect(result.settingsVersion).toBe(1)
    expect(result.volume).toBe(0.3)
    expect(result.playMode).toBe('shuffle')
    expect(result.backgroundBlur).toBe(50)
    expect(result.lyricFontSize).toBe(24)
    expect(result.smoothTrackChange).toBe(true)
    expect(result.autoHideChrome).toBe(true)
  })

  it('keeps settingsVersion when already at current version', () => {
    const result = migrateSettings({ settingsVersion: 1, volume: 0.5 })
    expect(result.settingsVersion).toBe(1)
    expect(result.volume).toBe(0.5)
  })

  it('loadSettings migrates persisted legacy data via the store', () => {
    localStorage.setItem('meliora:settings', JSON.stringify({ volume: 0.4, playMode: 'single' }))
    const store = usePlayerStore()

    expect(store.settings.settingsVersion).toBe(1)
    expect(store.settings.volume).toBe(0.4)
    expect(store.settings.playMode).toBe('single')
    expect(store.settings.autoHideChrome).toBe(true)
  })

  it('sanitizes invalid persisted settings instead of leaking NaN or out-of-range values', () => {
    const result = migrateSettings({
      volume: Number.NaN,
      playMode: 'bad-mode' as PlayerSettings['playMode'],
      smoothTrackChange: 'yes' as unknown as boolean,
      preloadNextTrack: false,
      dynamicBackground: 'no' as unknown as boolean,
      backgroundBlur: 999,
      backgroundSaturation: Number.POSITIVE_INFINITY,
      beatBrightness: -1,
      lyricFontSize: '22' as unknown as number,
      lyricAnimation: null as unknown as boolean,
      lyricTranslation: null as unknown as boolean,
      skipOnError: false,
      autoHideChrome: 1 as unknown as boolean,
      equalizer: {
        enabled: true,
        preset: 'missing' as PlayerSettings['equalizer']['preset'],
        bands: [99, Number.NaN, -99, Number.POSITIVE_INFINITY, 3],
      },
      settingsVersion: 999,
    })

    expect(result.volume).toBe(0.72)
    expect(result.playMode).toBe('loop')
    expect(result.smoothTrackChange).toBe(true)
    expect(result.preloadNextTrack).toBe(false)
    expect(result.dynamicBackground).toBe(true)
    expect(result.backgroundBlur).toBe(130)
    expect(result.backgroundSaturation).toBe(1.15)
    expect(result.beatBrightness).toBe(0)
    expect(result.lyricFontSize).toBe(22)
    expect(result.lyricAnimation).toBe(true)
    expect(result.lyricTranslation).toBe(true)
    expect(result.skipOnError).toBe(false)
    expect(result.autoHideChrome).toBe(true)
    expect(result.equalizer).toEqual({
      enabled: true,
      preset: 'flat',
      bands: [12, 0, -12, 0, 3],
    })
    expect(result.settingsVersion).toBe(1)
  })
})
