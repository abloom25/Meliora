import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { PlayMode, PlayerSettings, Track } from '../types/music'

const SETTINGS_KEY = 'meliora:settings'
const LAST_TRACK_KEY = 'meliora:last-track'

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
}

function loadSettings(): PlayerSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') as Partial<PlayerSettings>
    return { ...defaultSettings, ...saved }
  } catch {
    return { ...defaultSettings }
  }
}

export const usePlayerStore = defineStore('player', () => {
  const tracks = ref<Track[]>([])
  const queue = ref<Track[]>([])
  const currentTrackId = ref<string | null>(localStorage.getItem(LAST_TRACK_KEY))
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

  function setTracks(nextTracks: Track[]) {
    const activeTrack = currentTrackId.value
      ? tracks.value.find((track) => track.id === currentTrackId.value)
      : undefined
    tracks.value = activeTrack
      ? nextTracks.map((track) => (track.id === activeTrack.id ? activeTrack : track))
      : nextTracks
    if (!queue.value.length) queue.value = [...nextTracks]
    if (currentTrackId.value && !nextTracks.some((track) => track.id === currentTrackId.value)) {
      currentTrackId.value = null
    }
  }

  function selectTrack(track: Track, sourceQueue: Track[] = tracks.value) {
    queue.value = [...sourceQueue]
    currentTrackId.value = track.id
    currentTime.value = 0
    duration.value = 0
    errorMessage.value = ''
  }

  function nextTrack(manual = false, preferredTrackId?: string): Track | null {
    if (!queue.value.length) return null
    if (settings.value.playMode === 'single' && !manual && currentTrack.value) return currentTrack.value

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

  watch(
    settings,
    (value) => localStorage.setItem(SETTINGS_KEY, JSON.stringify(value)),
    { deep: true },
  )
  watch(currentTrackId, (value) => {
    if (value) localStorage.setItem(LAST_TRACK_KEY, value)
    else localStorage.removeItem(LAST_TRACK_KEY)
  })

  return {
    tracks,
    queue,
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
