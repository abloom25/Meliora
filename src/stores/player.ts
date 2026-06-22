import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { PlayMode, PlayerSettings, Track } from '../types/music'
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
  skipOnError: true,
  autoHideChrome: true,
  equalizer: createDefaultEqualizer(),
  settingsVersion: CURRENT_SETTINGS_VERSION,
}

export function migrateSettings(saved: Partial<PlayerSettings>): PlayerSettings {
  const result: PlayerSettings = { ...defaultSettings, ...saved }
  result.equalizer = sanitizeEqualizer(saved?.equalizer)
  result.settingsVersion = CURRENT_SETTINGS_VERSION
  return result
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
  const currentTrackId = ref<string | null>(safeStorage.getItem(LAST_TRACK_KEY))
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const settings = ref<PlayerSettings>(loadSettings())
  const errorMessage = ref('')

  const currentTrack = computed(
    () => tracks.value.find((track) => track.id === currentTrackId.value) ?? null,
  )
  const currentIndex = computed(() =>
    queue.value.findIndex((track) => track.id === currentTrackId.value),
  )

  function bumpQueueVersion() {
    queueVersion.value += 1
  }

  function setTracks(nextTracks: Track[]) {
    const activeTrack = currentTrackId.value
      ? tracks.value.find((track) => track.id === currentTrackId.value)
      : undefined
    tracks.value = activeTrack
      ? nextTracks.map((track) => (track.id === activeTrack.id ? activeTrack : track))
      : nextTracks
    if (!queue.value.length) {
      queue.value = [...nextTracks]
      bumpQueueVersion()
    }
    if (currentTrackId.value && !nextTracks.some((track) => track.id === currentTrackId.value)) {
      currentTrackId.value = null
    }
  }

  function selectTrack(track: Track, sourceQueue: Track[] = tracks.value) {
    queue.value = [...sourceQueue]
    bumpQueueVersion()
    currentTrackId.value = track.id
    currentTime.value = 0
    duration.value = 0
    errorMessage.value = ''
  }

  function nextTrack(manual = false, preferredTrackId?: string): Track | null {
    if (!queue.value.length) return null
    if (settings.value.playMode === 'single' && !manual && currentTrack.value)
      return currentTrack.value

    let nextIndex: number
    const preferredIndex = preferredTrackId
      ? queue.value.findIndex((track) => track.id === preferredTrackId)
      : -1
    if (preferredIndex >= 0 && preferredIndex !== currentIndex.value) {
      nextIndex = preferredIndex
    } else if (settings.value.playMode === 'shuffle' && queue.value.length > 1) {
      do {
        nextIndex = Math.floor(Math.random() * queue.value.length)
      } while (nextIndex === currentIndex.value)
    } else {
      nextIndex = currentIndex.value + 1
      if (nextIndex >= queue.value.length) {
        if (settings.value.playMode === 'sequence') return null
        nextIndex = 0
      }
    }

    const track = queue.value[nextIndex] ?? queue.value[0] ?? null
    if (track) selectTrack(track, queue.value)
    return track
  }

  function previousTrack(preferredTrackId?: string): Track | null {
    if (!queue.value.length) return null
    let previousIndex = preferredTrackId
      ? queue.value.findIndex((track) => track.id === preferredTrackId)
      : currentIndex.value - 1
    if (previousIndex < 0) previousIndex = queue.value.length - 1
    const track = queue.value[previousIndex] ?? null
    if (track) selectTrack(track, queue.value)
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
    nextTrack,
    previousTrack,
    cyclePlayMode,
  }
})
