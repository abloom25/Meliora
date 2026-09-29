import { computed, onScopeDispose, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { PlayMode, PlayerSettings, Track } from '../core/types'
import { settingsStore } from '../platform/settings-store'
import { createDefaultEqualizer, sanitizeEqualizer } from '../core/audio/equalizer'
import {
  nextPlayMode,
  selectNextTrack,
  selectPreviousTrack,
  type QueueState,
} from '../core/audio/queue'
import { sanitizeBeatFlashRate } from '../core/analysis/beat-envelope'

const SETTINGS_KEY = 'meliora:settings'
const LAST_TRACK_KEY = 'meliora:last-track'

const CURRENT_SETTINGS_VERSION = 1

const defaultSettings: PlayerSettings = {
  volume: 0.72,
  playMode: 'loop',
  smoothTrackChange: true,
  preloadNextTrack: true,
  dynamicBackground: true,
  beatFlash: true,
  backgroundBlur: 90,
  backgroundSaturation: 1.15,
  beatBrightness: 0.28,
  beatFlashRate: 1,
  beatVisualDelay: 0,
  lyricFontSize: 20,
  lyricAnimation: true,
  lyricSpring: 1,
  lyricTranslation: true,
  progressLyricPreview: false,
  skipOnError: true,
  autoHideChrome: true,
  equalizer: createDefaultEqualizer(),
  settingsVersion: CURRENT_SETTINGS_VERSION,
}

/** 可被「恢复默认」重置的设置项。settingsVersion 是迁移用的内部字段,不参与重置 */
export type ResettableSettingKey = Exclude<keyof PlayerSettings, 'settingsVersion'>

export function migrateSettings(saved: Partial<PlayerSettings>): PlayerSettings {
  const input = saved && typeof saved === 'object' ? saved : {}
  return {
    volume: sanitizeNumber(input.volume, defaultSettings.volume, 0, 1),
    playMode: sanitizePlayMode(input.playMode),
    smoothTrackChange: sanitizeBoolean(input.smoothTrackChange, defaultSettings.smoothTrackChange),
    preloadNextTrack: sanitizeBoolean(input.preloadNextTrack, defaultSettings.preloadNextTrack),
    dynamicBackground: sanitizeBoolean(input.dynamicBackground, defaultSettings.dynamicBackground),
    beatFlash: sanitizeBoolean(input.beatFlash, defaultSettings.beatFlash),
    backgroundBlur: sanitizeNumber(input.backgroundBlur, defaultSettings.backgroundBlur, 45, 130),
    backgroundSaturation: sanitizeNumber(
      input.backgroundSaturation,
      defaultSettings.backgroundSaturation,
      0.65,
      1.8,
    ),
    beatBrightness: sanitizeNumber(input.beatBrightness, defaultSettings.beatBrightness, 0, 0.65),
    beatFlashRate: sanitizeBeatFlashRate(input.beatFlashRate),
    beatVisualDelay: sanitizeNumber(
      input.beatVisualDelay,
      defaultSettings.beatVisualDelay,
      -100,
      300,
    ),
    lyricFontSize: sanitizeNumber(input.lyricFontSize, defaultSettings.lyricFontSize, 15, 30),
    lyricAnimation: sanitizeBoolean(input.lyricAnimation, defaultSettings.lyricAnimation),
    lyricSpring: sanitizeNumber(input.lyricSpring, defaultSettings.lyricSpring, 0.5, 2),
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
    const saved = JSON.parse(
      settingsStore().getItem(SETTINGS_KEY) || '{}',
    ) as Partial<PlayerSettings>
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
  const currentTrackId = ref<string | null>(settingsStore().getItem(LAST_TRACK_KEY))
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

  // 曲目对象被换新时,挂在旧对象上的东西(比如已解析的歌词来源)需要转移过去。
  // 状态层不该知道"歌词是怎么取的",所以只留一个可注册的搬运钩子,由服务层在启动时装上
  let carryTrackSideData: ((from: Track, to: Track) => void) | null = null

  function onTrackReplaced(handler: ((from: Track, to: Track) => void) | null) {
    carryTrackSideData = handler
  }

  function setTracks(nextTracks: Track[]) {
    const activeTrack = currentTrack.value ?? undefined
    const mergedTracks = activeTrack
      ? nextTracks.map((track) => {
          if (track.id !== activeTrack.id) return track
          carryTrackSideData?.(track, activeTrack)
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

  // 选曲规则本身是纯的,放在 core/audio/queue;这里只负责把当前状态喂进去
  function queueState(): QueueState {
    return {
      queue: queue.value,
      currentIndex: currentIndex.value,
      playMode: settings.value.playMode,
    }
  }

  function peekNext(manual = false): Track | null {
    return selectNextTrack(queueState(), { manual })
  }

  function peekPrevious(): Track | null {
    return selectPreviousTrack(queueState())
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
    settings.value.playMode = nextPlayMode(settings.value.playMode)
  }

  let saveSettingsTimer = 0
  function persistSettings() {
    settingsStore().setItem(SETTINGS_KEY, JSON.stringify(settings.value))
  }
  // store 被 dispose(其 effect scope 销毁)时清理挂起的防抖定时器,
  // 并立即落盘尚未写入的设置,避免丢失最后一次修改。
  onScopeDispose(() => {
    if (saveSettingsTimer) {
      window.clearTimeout(saveSettingsTimer)
      saveSettingsTimer = 0
      persistSettings()
    }
  })
  watch(
    settings,
    () => {
      if (saveSettingsTimer) window.clearTimeout(saveSettingsTimer)
      saveSettingsTimer = window.setTimeout(persistSettings, 200)
    },
    { deep: true },
  )
  watch(currentTrackId, (value) => {
    if (value) settingsStore().setItem(LAST_TRACK_KEY, value)
    else settingsStore().removeItem(LAST_TRACK_KEY)
  })

  // 把指定设置项恢复默认:置为 undefined 后交给 migrateSettings 走既有的兜底链路,
  // 不必在这里重复一份默认值,也顺带保证重置后的值一定通过校验
  function resetSettings(keys: readonly ResettableSettingKey[]) {
    if (!keys.length) return
    const overrides = Object.fromEntries(
      keys.map((key) => [key, undefined]),
    ) as Partial<PlayerSettings>
    settings.value = migrateSettings({ ...settings.value, ...overrides })
  }

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
    onTrackReplaced,
    peekNext,
    peekPrevious,
    nextTrack,
    previousTrack,
    cyclePlayMode,
    resetSettings,
  }
})
