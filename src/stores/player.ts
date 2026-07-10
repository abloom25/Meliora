import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { PlayMode, PlayerSettings, Track } from '../types/music'
import { transferTrackLyricsProvider } from '../services/lyrics'
import { safeStorage } from '../utils/storage'
import { createDefaultEqualizer, sanitizeEqualizer } from '../utils/equalizer'

const SETTINGS_KEY = 'meliora:settings'
const LAST_TRACK_KEY = 'meliora:last-track'

const CURRENT_SETTINGS_VERSION = 1

const defaultSettings: PlayerSettings = {
  volume: 0.72,
  playMode: 'loop',
  smoothTrackChange: true,
  preloadNextTrack: true,
  dynamicBackground: true,
  backgroundBlur: 90,
  backgroundSaturation: 1.15,
  beatBrightness: 0.28,
  lyricFontSize: 20,
  lyricAnimation: true,
  lyricTranslation: true,
  progressLyricPreview: false,
  skipOnError: true,
  autoHideChrome: true,
  equalizer: createDefaultEqualizer(),
  settingsVersion: CURRENT_SETTINGS_VERSION,
}

export function migrateSettings(saved: Partial<PlayerSettings>): PlayerSettings {
  const input = saved && typeof saved === 'object' ? saved : {}
  return {
    volume: sanitizeNumber(input.volume, defaultSettings.volume, 0, 1),
    playMode: sanitizePlayMode(input.playMode),
    smoothTrackChange: sanitizeBoolean(input.smoothTrackChange, defaultSettings.smoothTrackChange),
    preloadNextTrack: sanitizeBoolean(input.preloadNextTrack, defaultSettings.preloadNextTrack),
    dynamicBackground: sanitizeBoolean(input.dynamicBackground, defaultSettings.dynamicBackground),
    backgroundBlur: sanitizeNumber(input.backgroundBlur, defaultSettings.backgroundBlur, 45, 130),
    backgroundSaturation: sanitizeNumber(
      input.backgroundSaturation,
      defaultSettings.backgroundSaturation,
      0.65,
      1.8,
    ),
    beatBrightness: sanitizeNumber(input.beatBrightness, defaultSettings.beatBrightness, 0, 0.65),
    lyricFontSize: sanitizeNumber(input.lyricFontSize, defaultSettings.lyricFontSize, 15, 30),
    lyricAnimation: sanitizeBoolean(input.lyricAnimation, defaultSettings.lyricAnimation),
    lyricTranslation: sanitizeBoolean(input.lyricTranslation, defaultSettings.lyricTranslation),
    progressLyricPreview: sanitizeBoolean(
      input.progressLyricPreview,
      defaultSettings.progressLyricPreview,
    ),
    skipOnError: sanitizeBoolean(input.skipOnError, defaultSettings.skipOnError),
    autoHideChrome: sanitizeBoolean(input.autoHideChrome, defaultSettings.autoHideChrome),
    equalizer: sanitizeEqualizer(input.equalizer),
    settingsVersion: CURRENT_SETTINGS_VERSION,
  }
}

function sanitizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, numeric))
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  return fallback
}

function sanitizePlayMode(value: unknown): PlayMode {
  const modes: PlayMode[] = ['sequence', 'loop', 'single', 'shuffle']
  return modes.includes(value as PlayMode) ? (value as PlayMode) : defaultSettings.playMode
}

function loadSettings(): PlayerSettings {
  try {
    const saved = JSON.parse(safeStorage.getItem(SETTINGS_KEY) || '{}') as Partial<PlayerSettings>
    return migrateSettings(saved)
  } catch {
    return { ...defaultSettings }
  }
}

export const usePlayerStore = defineStore('player', () => {
  const tracks = ref<Track[]>([])
  const queue = ref<Track[]>([])
  const queueVersion = ref(0)
  const currentTrackVersion = ref(0)
  const currentTrackId = ref<string | null>(safeStorage.getItem(LAST_TRACK_KEY))
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const settings = ref<PlayerSettings>(loadSettings())
  const errorMessage = ref('')

  const trackById = computed(() => new Map(tracks.value.map((track) => [track.id, track])))
  const queueIndexById = computed(
    () => new Map(queue.value.map((track, index) => [track.id, index])),
  )

  const currentTrack = computed(() =>
    currentTrackId.value ? (trackById.value.get(currentTrackId.value) ?? null) : null,
  )
  const currentIndex = computed(() =>
    currentTrackId.value ? (queueIndexById.value.get(currentTrackId.value) ?? -1) : -1,
  )

  function bumpQueueVersion() {
    queueVersion.value += 1
  }

  function bumpCurrentTrackVersion() {
    currentTrackVersion.value += 1
  }

  function setTracks(nextTracks: Track[]) {
    const activeTrack = currentTrack.value ?? undefined
    const mergedTracks = activeTrack
      ? nextTracks.map((track) => {
          if (track.id !== activeTrack.id) return track
          transferTrackLyricsProvider(track, activeTrack)
          delete activeTrack.titleVersions
          delete activeTrack.shareAliases
          delete activeTrack.album
          delete activeTrack.cover
          Object.assign(activeTrack, track)
          bumpCurrentTrackVersion()
          return activeTrack
        })
      : nextTracks
    const mergedTrackById = new Map(mergedTracks.map((track) => [track.id, track]))
    const queuedIds = new Set<string>()
    const syncedQueue = queue.value
      .map((track) => mergedTrackById.get(track.id))
      .filter((track): track is Track => Boolean(track))
    for (const track of syncedQueue) queuedIds.add(track.id)
    for (const track of mergedTracks) {
      if (!queuedIds.has(track.id)) syncedQueue.push(track)
    }

    tracks.value = mergedTracks
    if (queue.value.length || syncedQueue.length) {
      queue.value = syncedQueue
      bumpQueueVersion()
    }
    if (currentTrackId.value && !mergedTrackById.has(currentTrackId.value)) {
      currentTrackId.value = null
    }
  }

  function selectTrack(track: Track, sourceQueue: Track[] = tracks.value) {
    queue.value = [...sourceQueue]
    bumpQueueVersion()
    setCurrentTrack(track)
  }

  function setCurrentTrack(track: Track) {
    currentTrackId.value = track.id
    currentTime.value = 0
    duration.value = 0
    errorMessage.value = ''
  }

  function peekNext(manual = false): Track | null {
    if (!queue.value.length) return null
    if (settings.value.playMode === 'single' && !manual && currentTrack.value)
      return currentTrack.value
    if (settings.value.playMode === 'shuffle' && queue.value.length > 1) {
      let nextIndex: number
      do {
        nextIndex = Math.floor(Math.random() * queue.value.length)
      } while (nextIndex === currentIndex.value)
      return queue.value[nextIndex] ?? null
    }
    const nextIndex = currentIndex.value + 1
    if (nextIndex >= queue.value.length) {
      if (settings.value.playMode === 'sequence') return null
      return queue.value[0] ?? null
    }
    return queue.value[nextIndex] ?? null
  }

  function peekPrevious(): Track | null {
    if (!queue.value.length) return null
    let previousIndex = currentIndex.value - 1
    if (previousIndex < 0) previousIndex = queue.value.length - 1
    return queue.value[previousIndex] ?? null
  }

  function nextTrack(manual = false, preferredTrackId?: string): Track | null {
    if (!queue.value.length) return null
    if (settings.value.playMode === 'single' && !manual && currentTrack.value)
      return currentTrack.value
    let track: Track | null = null
    if (preferredTrackId) {
      const preferredIndex = queueIndexById.value.get(preferredTrackId) ?? -1
      if (preferredIndex >= 0 && preferredIndex !== currentIndex.value) {
        track = queue.value[preferredIndex] ?? null
      }
    }
    if (!track) track = peekNext(manual)
    if (track) setCurrentTrack(track)
    return track
  }

  function previousTrack(preferredTrackId?: string): Track | null {
    if (!queue.value.length) return null
    let track: Track | null
    if (preferredTrackId) {
      let preferredIndex = queueIndexById.value.get(preferredTrackId) ?? -1
      if (preferredIndex < 0) preferredIndex = queue.value.length - 1
      track = queue.value[preferredIndex] ?? null
    } else {
      track = peekPrevious()
    }
    if (track) setCurrentTrack(track)
    return track
  }

  function cyclePlayMode() {
    const modes: PlayMode[] = ['sequence', 'loop', 'single', 'shuffle']
    const index = modes.indexOf(settings.value.playMode)
    settings.value.playMode = modes[(index + 1) % modes.length] ?? 'loop'
  }

  let saveSettingsTimer = 0
  function persistSettings() {
    safeStorage.setItem(SETTINGS_KEY, JSON.stringify(settings.value))
  }
  watch(
    settings,
    () => {
      if (saveSettingsTimer) window.clearTimeout(saveSettingsTimer)
      saveSettingsTimer = window.setTimeout(persistSettings, 200)
    },
    { deep: true },
  )
  watch(currentTrackId, (value) => {
    if (value) safeStorage.setItem(LAST_TRACK_KEY, value)
    else safeStorage.removeItem(LAST_TRACK_KEY)
  })

  return {
    tracks,
    queue,
    queueVersion,
    currentTrackVersion,
    currentTrackId,
    currentTrack,
    currentIndex,
    isPlaying,
    currentTime,
    duration,
    settings,
    errorMessage,
    setTracks,
    selectTrack,
    peekNext,
    peekPrevious,
    nextTrack,
    previousTrack,
    cyclePlayMode,
  }
})
