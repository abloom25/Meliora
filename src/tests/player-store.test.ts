import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { nextTick } from 'vue'
import { loadTrackLyrics, registerTrackLyrics } from '../services/lyrics'
import { migrateSettings, usePlayerStore } from '../stores/player'
import { wireApplication } from '../app/composition-root'
import type { PlayerSettings, Track } from '../core/types'

let testPinia: Pinia | undefined

function activateTestPinia() {
  if (testPinia) disposePinia(testPinia)
  testPinia = createPinia()
  setActivePinia(testPinia)
}

beforeEach(activateTestPinia)
afterEach(() => {
  // Stop each store's watchers and debounce timer before the next test clears storage.
  if (testPinia) disposePinia(testPinia)
  testPinia = undefined
  setActivePinia(undefined)
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

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
  beforeEach(() => {
    // store 不再直接依赖服务层,歌词来源的搬运由组装点装上(与 main.ts 一致)
    wireApplication()
  })

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

  it('preserves optional metadata when a progressive snapshot reuses the active object', () => {
    const store = usePlayerStore()
    const song: Track = {
      ...tracks[0]!,
      cover: '/one.jpg',
      album: 'Album',
      titleVersions: ['Live'],
      shareAliases: ['legacy'],
    }
    store.setTracks([song])
    store.selectTrack(song)
    store.setTracks([song, tracks[1]!], { complete: false })
    expect(store.currentTrack).toMatchObject({
      cover: '/one.jpg',
      album: 'Album',
      titleVersions: ['Live'],
      shareAliases: ['legacy'],
    })
  })

  it('keeps a pending restored track id until the complete library is known', () => {
    const store = usePlayerStore()
    store.currentTrackId = '2'
    store.setTracks([tracks[0]!], { complete: false })
    expect(store.currentTrackId).toBe('2')
    store.setTracks(tracks)
    expect(store.currentTrack?.id).toBe('2')
    store.setTracks([tracks[0]!])
    expect(store.currentTrackId).toBeNull()
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

  it('updates active track metadata and lyrics provider while preserving the active object', async () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.selectTrack(tracks[1]!, tracks)
    const activeTrack = store.currentTrack
    const initialTrackVersion = store.currentTrackVersion
    const refreshedTrack: Track = {
      ...tracks[1]!,
      title: 'Two updated',
      titleVersions: ['Live'],
      cover: '/cover.jpg',
    }
    registerTrackLyrics(refreshedTrack, {
      cacheKey: 'lyrics:updated',
      load: () => Promise.resolve([{ time: 2, text: 'Updated lyric' }]),
    })

    store.setTracks([tracks[0]!, refreshedTrack, tracks[2]!])

    expect(store.currentTrack).toBe(activeTrack)
    expect(store.currentTrackVersion).toBe(initialTrackVersion + 1)
    expect(store.currentTrack).toMatchObject({
      title: 'Two updated',
      titleVersions: ['Live'],
      cover: '/cover.jpg',
    })
    expect(store.currentTrack).not.toHaveProperty('revision')
    await expect(loadTrackLyrics(store.currentTrack!)).resolves.toEqual([
      { time: 2, text: 'Updated lyric' },
    ])

    store.setTracks([
      tracks[0]!,
      { id: '2', title: 'Two plain', artist: 'B', audioUrl: '/2.mp3', kind: 'local' },
      tracks[2]!,
    ])

    expect(store.currentTrack).toBe(activeTrack)
    expect(store.currentTrackVersion).toBe(initialTrackVersion + 2)
    expect(store.currentTrack).toMatchObject({ title: 'Two plain' })
    expect(store.currentTrack).not.toHaveProperty('titleVersions')
    expect(store.currentTrack).not.toHaveProperty('cover')
    await expect(loadTrackLyrics(store.currentTrack!)).resolves.toEqual([])
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

  it('keeps the existing queue instance and version when stepping through the current queue', () => {
    const store = usePlayerStore()
    store.setTracks(tracks)
    store.selectTrack(tracks[0]!, tracks)
    const queue = store.queue
    const queueVersion = store.queueVersion

    expect(store.nextTrack()?.id).toBe('2')
    expect(store.queue).toBe(queue)
    expect(store.queueVersion).toBe(queueVersion)

    expect(store.previousTrack()?.id).toBe('1')
    expect(store.queue).toBe(queue)
    expect(store.queueVersion).toBe(queueVersion)
  })
})

describe('player settings migration', () => {
  it('defaults to responsive lyric scaling with settingsVersion 2', () => {
    const result = migrateSettings({})
    expect(result.settingsVersion).toBe(2)
    expect(result.lyricScale).toBe(1)
    expect(result.volume).toBe(0.72)
    expect(result.playMode).toBe('loop')
    expect(result.smoothTrackChange).toBe(true)
    expect(result.autoHideChrome).toBe(true)
    expect(result.debugPanelEnabled).toBe(false)
    expect(result.lyricTranslation).toBe(true)
    expect(result.progressLyricPreview).toBe(false)
    expect(result.beatAnalysisMode).toBe('basic')
  })

  it('migrates legacy pixel sizes to proportional scaling while preserving preferences', () => {
    const legacy = {
      volume: 0.3,
      playMode: 'shuffle' as const,
      backgroundBlur: 50,
      lyricFontSize: 24,
    }
    const result = migrateSettings(legacy)

    expect(result.settingsVersion).toBe(2)
    expect(result.volume).toBe(0.3)
    expect(result.playMode).toBe('shuffle')
    expect(result.backgroundBlur).toBe(50)
    expect(result.lyricScale).toBe(1.2)
    expect(result).not.toHaveProperty('lyricFontSize')
    expect(result.smoothTrackChange).toBe(true)
    expect(result.autoHideChrome).toBe(true)
    expect(result.progressLyricPreview).toBe(false)
  })

  it('keeps settingsVersion when already at current version', () => {
    const result = migrateSettings({ settingsVersion: 2, volume: 0.5 })
    expect(result.settingsVersion).toBe(2)
    expect(result.volume).toBe(0.5)
  })

  it('migrates removed model and invalid preferences to the available basic mode', () => {
    expect(
      migrateSettings({ beatAnalysisMode: 'beatnet' as PlayerSettings['beatAnalysisMode'] })
        .beatAnalysisMode,
    ).toBe('basic')
    expect(
      migrateSettings({ beatAnalysisMode: 'madmom-onset' as PlayerSettings['beatAnalysisMode'] })
        .beatAnalysisMode,
    ).toBe('basic')
    expect(migrateSettings({ beatAnalysisMode: 'basic' }).beatAnalysisMode).toBe('basic')
    expect(migrateSettings({ volume: 0.4 }).beatAnalysisMode).toBe('basic')
    expect(
      migrateSettings({
        beatAnalysisMode: 'unknown-model' as PlayerSettings['beatAnalysisMode'],
      }).beatAnalysisMode,
    ).toBe('basic')
  })

  it.each(['beat-this-small', 'beat-this-standard'] as const)(
    'preserves manually selected %s across settings loads and unrelated resets',
    (selectedMode) => {
      expect(migrateSettings({ beatAnalysisMode: selectedMode }).beatAnalysisMode).toBe(
        selectedMode,
      )
      localStorage.setItem('meliora:settings', JSON.stringify({ beatAnalysisMode: selectedMode }))
      const store = usePlayerStore()
      expect(store.settings.beatAnalysisMode).toBe(selectedMode)
      store.resetSettings(['volume'])
      expect(store.settings.beatAnalysisMode).toBe(selectedMode)
      store.resetSettings(['beatAnalysisMode'])
      expect(store.settings.beatAnalysisMode).toBe('basic')
    },
  )

  it('loadSettings migrates persisted legacy data via the store', () => {
    localStorage.setItem('meliora:settings', JSON.stringify({ volume: 0.4, playMode: 'single' }))
    const store = usePlayerStore()

    expect(store.settings.settingsVersion).toBe(2)
    expect(store.settings.volume).toBe(0.4)
    expect(store.settings.playMode).toBe('single')
    expect(store.settings.autoHideChrome).toBe(true)
    expect(store.settings.debugPanelEnabled).toBe(false)
  })

  it('only enables the debug panel for an explicit boolean preference', () => {
    for (const value of [undefined, null, 'true', 1, {}, false]) {
      expect(migrateSettings({ debugPanelEnabled: value as boolean }).debugPanelEnabled).toBe(false)
    }
    expect(migrateSettings({ debugPanelEnabled: true }).debugPanelEnabled).toBe(true)
  })

  it('discards a persisted debug opt-in outside development', () => {
    vi.stubEnv('DEV', false)
    localStorage.setItem('meliora:settings', JSON.stringify({ debugPanelEnabled: true }))
    expect(migrateSettings({ debugPanelEnabled: true }).debugPanelEnabled).toBe(false)
    const store = usePlayerStore()
    expect(store.settings.debugPanelEnabled).toBe(false)
    store.$dispose()
  })

  it('persists the debug opt-in and preserves it when unrelated settings are reset', async () => {
    vi.useFakeTimers()
    const store = usePlayerStore()
    store.settings.debugPanelEnabled = true
    store.resetSettings(['volume'])
    await nextTick()
    await vi.advanceTimersByTimeAsync(200)
    expect(JSON.parse(localStorage.getItem('meliora:settings')!).debugPanelEnabled).toBe(true)

    activateTestPinia()
    const restored = usePlayerStore()
    expect(restored.settings.debugPanelEnabled).toBe(true)
    restored.settings.debugPanelEnabled = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(200)
    expect(JSON.parse(localStorage.getItem('meliora:settings')!).debugPanelEnabled).toBe(false)
  })

  it('flushes and cancels pending saves before replacing a disposed store', async () => {
    vi.useFakeTimers()
    const schedule = vi.spyOn(window, 'setTimeout')
    const cancel = vi.spyOn(window, 'clearTimeout')
    const store = usePlayerStore()
    store.settings.volume = 0.4
    await nextTick()
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 200)
    const pendingSave = schedule.mock.results.at(-1)?.value

    activateTestPinia()
    expect(cancel).toHaveBeenCalledWith(pendingSave)
    const restored = usePlayerStore()
    expect(restored.settings.volume).toBe(0.4)
    restored.settings.volume = 0.8
    await nextTick()
    await vi.advanceTimersByTimeAsync(200)
    expect(JSON.parse(localStorage.getItem('meliora:settings')!).volume).toBe(0.8)
  })

  it('sanitizes invalid persisted settings instead of leaking NaN or out-of-range values', () => {
    const result = migrateSettings({
      volume: Number.NaN,
      playMode: 'bad-mode' as PlayerSettings['playMode'],
      smoothTrackChange: 'yes' as unknown as boolean,
      preloadNextTrack: false,
      dynamicBackground: 'no' as unknown as boolean,
      beatFlash: 'off' as unknown as boolean,
      backgroundBlur: 999,
      backgroundSaturation: Number.POSITIVE_INFINITY,
      beatBrightness: -1,
      beatFlashRate: 9,
      beatVisualDelay: 999,
      lyricFontSize: '22' as unknown as number,
      lyricAnimation: null as unknown as boolean,
      lyricTranslation: null as unknown as boolean,
      progressLyricPreview: true,
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
    expect(result.beatFlash).toBe(true)
    expect(result.backgroundBlur).toBe(130)
    expect(result.backgroundSaturation).toBe(1.15)
    expect(result.beatBrightness).toBe(0)
    expect(result.beatFlashRate).toBe(4)
    expect(result.beatVisualDelay).toBe(300)
    expect(result.lyricScale).toBe(1.1)
    expect(result.lyricAnimation).toBe(true)
    expect(result.lyricTranslation).toBe(true)
    expect(result.progressLyricPreview).toBe(true)
    expect(result.skipOnError).toBe(false)
    expect(result.autoHideChrome).toBe(true)
    expect(result.equalizer).toEqual({
      enabled: true,
      preset: 'flat',
      bands: [12, 0, -12, 0, 3],
    })
    expect(result.settingsVersion).toBe(2)
  })

  it.each([
    [15, 0.75],
    [20, 1],
    [30, 1.5],
    [5, 0.75],
    [100, 1.5],
    [null, 1],
    ['', 1],
    [Number.NaN, 1],
  ])('migrates legacy lyric size %s to scale %s', (lyricFontSize, expected) => {
    expect(migrateSettings({ lyricFontSize }).lyricScale).toBe(expected)
  })

  it.each([
    [0.5, 0.75],
    [2, 1.5],
    [1.25, 1.25],
    ['1.15', 1.15],
    ['', 1],
    [null, 1],
    [true, 1],
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
  ])('sanitizes lyric scale %s and prioritizes it over the old size', (lyricScale, expected) => {
    expect(
      migrateSettings({ lyricScale: lyricScale as number, lyricFontSize: 30 }).lyricScale,
    ).toBe(expected)
  })

  it('persists the migrated scale without retaining a legacy pixel preference', async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      'meliora:settings',
      JSON.stringify({ settingsVersion: 1, lyricFontSize: 25 }),
    )
    const store = usePlayerStore()
    expect(store.settings.lyricScale).toBe(1.25)
    store.settings.volume = 0.5
    await nextTick()
    await vi.advanceTimersByTimeAsync(200)

    const saved = JSON.parse(localStorage.getItem('meliora:settings')!)
    expect(saved.lyricScale).toBe(1.25)
    expect(saved.settingsVersion).toBe(2)
    expect(saved).not.toHaveProperty('lyricFontSize')
    activateTestPinia()
    expect(usePlayerStore().settings.lyricScale).toBe(1.25)
  })

  it('clamps the lyric spring coefficient into the supported range', () => {
    expect(migrateSettings({ lyricSpring: 9 }).lyricSpring).toBe(2)
    expect(migrateSettings({ lyricSpring: 0 }).lyricSpring).toBe(0.5)
    expect(migrateSettings({}).lyricSpring).toBe(1)
  })

  it('resets only the requested settings and leaves the rest alone', () => {
    const store = usePlayerStore()
    store.settings.lyricScale = 1.5
    store.settings.backgroundBlur = 130

    store.resetSettings(['lyricScale'])

    expect(store.settings.lyricScale).toBe(1)
    expect(store.settings.backgroundBlur).toBe(130)
  })

  it('rebuilds the equalizer object when it is reset', () => {
    const store = usePlayerStore()
    store.settings.equalizer.enabled = true
    store.settings.equalizer.preset = 'rock'
    store.settings.equalizer.bands = store.settings.equalizer.bands.map(() => 6)

    store.resetSettings(['equalizer'])

    expect(store.settings.equalizer.enabled).toBe(false)
    expect(store.settings.equalizer.preset).toBe('flat')
    expect(store.settings.equalizer.bands.every((gain) => gain === 0)).toBe(true)
  })
})
