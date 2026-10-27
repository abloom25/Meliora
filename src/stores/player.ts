import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import type { BeatAnalysisMode, PlayMode, PlayerSettings, Track } from '../core/types'
import { settingsStore } from '../platform/settings-store'
import { createDefaultEqualizer, sanitizeEqualizer } from '../core/audio/equalizer'
import { nextPlayMode } from '../core/audio/queue'
import { normalizeTrackId } from '../core/library/track-id'
import { sanitizeBeatFlashRate } from '../core/analysis/beat-envelope'
import {
  PLAYBACK_SESSION_KEY,
  canResumePlayback,
  emptyQueueJourney,
  peekJourneyTrack,
  prepareQueueJourney,
  sanitizePlaybackSession,
  visitQueueTrack,
  type PlaybackSession,
  type QueueJourney,
} from '../core/playback/session'

const SETTINGS_KEY = 'meliora:settings'
const LAST_TRACK_KEY = 'meliora:last-track'

const CURRENT_SETTINGS_VERSION = 2

const defaultSettings: PlayerSettings = {
  volume: 0.72,
  playMode: 'loop',
  smoothTrackChange: true,
  preloadNextTrack: true,
  adaptivePerformance: true,
  tabCoordination: true,
  syncTabPlayback: false,
  dynamicBackground: true,
  beatFlash: true,
  beatAnalysisMode: 'basic',
  backgroundBlur: 90,
  backgroundSaturation: 1.15,
  beatBrightness: 0.28,
  beatFlashRate: 1,
  beatVisualDelay: 0,
  lyricScale: 1,
  lyricAnimation: true,
  lyricSpring: 1,
  lyricTranslation: true,
  lyricRomanization: true,
  lyricWindowScale: null,
  progressLyricPreview: false,
  skipOnError: true,
  autoHideChrome: true,
  debugPanelEnabled: false,
  equalizer: createDefaultEqualizer(),
  settingsVersion: CURRENT_SETTINGS_VERSION,
}

/** 可被「恢复默认」重置的设置项。settingsVersion 是迁移用的内部字段,不参与重置 */
export type ResettableSettingKey = Exclude<keyof PlayerSettings, 'settingsVersion'>

type SavedPlayerSettings = Partial<PlayerSettings> & { lyricFontSize?: unknown }

export function migrateSettings(saved: SavedPlayerSettings): PlayerSettings {
  const input = saved && typeof saved === 'object' ? saved : {}
  return {
    volume: sanitizeNumber(input.volume, defaultSettings.volume, 0, 1),
    playMode: sanitizePlayMode(input.playMode),
    smoothTrackChange: sanitizeBoolean(input.smoothTrackChange, defaultSettings.smoothTrackChange),
    preloadNextTrack: sanitizeBoolean(input.preloadNextTrack, defaultSettings.preloadNextTrack),
    adaptivePerformance: sanitizeBoolean(
      input.adaptivePerformance,
      defaultSettings.adaptivePerformance,
    ),
    tabCoordination: sanitizeBoolean(input.tabCoordination, defaultSettings.tabCoordination),
    syncTabPlayback: sanitizeBoolean(input.syncTabPlayback, defaultSettings.syncTabPlayback),
    dynamicBackground: sanitizeBoolean(input.dynamicBackground, defaultSettings.dynamicBackground),
    beatFlash: sanitizeBoolean(input.beatFlash, defaultSettings.beatFlash),
    beatAnalysisMode: sanitizeBeatAnalysisMode(input.beatAnalysisMode),
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
    lyricScale: migrateLyricScale(input),
    lyricAnimation: sanitizeBoolean(input.lyricAnimation, defaultSettings.lyricAnimation),
    lyricSpring: sanitizeNumber(input.lyricSpring, defaultSettings.lyricSpring, 0.5, 2),
    lyricTranslation: sanitizeBoolean(input.lyricTranslation, defaultSettings.lyricTranslation),
    lyricRomanization: sanitizeBoolean(
      input.lyricRomanization,
      sanitizeBoolean(input.lyricTranslation, defaultSettings.lyricTranslation),
    ),
    lyricWindowScale:
      typeof input.lyricWindowScale === 'number' &&
      Number.isFinite(input.lyricWindowScale) &&
      input.lyricWindowScale >= 0.75 &&
      input.lyricWindowScale <= 1.5
        ? input.lyricWindowScale
        : null,
    progressLyricPreview: sanitizeBoolean(
      input.progressLyricPreview,
      defaultSettings.progressLyricPreview,
    ),
    skipOnError: sanitizeBoolean(input.skipOnError, defaultSettings.skipOnError),
    autoHideChrome: sanitizeBoolean(input.autoHideChrome, defaultSettings.autoHideChrome),
    debugPanelEnabled:
      import.meta.env.DEV &&
      sanitizeBoolean(input.debugPanelEnabled, defaultSettings.debugPanelEnabled),
    equalizer: sanitizeEqualizer(input.equalizer),
    settingsVersion: CURRENT_SETTINGS_VERSION,
  }
}

function migrateLyricScale(input: SavedPlayerSettings): number {
  // 有新字段时以它为准，即使损坏也不恢复旧像素值，避免已调整的偏好倒退。
  const hasScale = Object.prototype.hasOwnProperty.call(input, 'lyricScale')
  const value = hasScale ? input.lyricScale : input.lyricFontSize
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && !value.trim())
  )
    return defaultSettings.lyricScale
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return defaultSettings.lyricScale
  return sanitizeNumber(hasScale ? numeric : numeric / 20, defaultSettings.lyricScale, 0.75, 1.5)
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

function sanitizeBeatAnalysisMode(value: unknown): BeatAnalysisMode {
  if (value === 'beat-this-small' || value === 'beat-this-standard') return value
  return 'basic'
}

function loadSettings(): PlayerSettings {
  try {
    const saved = JSON.parse(settingsStore().getItem(SETTINGS_KEY) || '{}') as SavedPlayerSettings
    return migrateSettings(saved)
  } catch {
    return { ...defaultSettings }
  }
}

export const usePlayerStore = defineStore('player', () => {
  let restored: PlaybackSession | null = null
  try {
    restored = sanitizePlaybackSession(
      JSON.parse(settingsStore().getItem(PLAYBACK_SESSION_KEY) || 'null'),
    )
  } catch {
    /* Invalid local data must not prevent playback. */
  }
  const tracks = ref<Track[]>([])
  const queue = ref<Track[]>([])
  let queueIds = restored?.queueIds ?? []
  let customQueue = restored?.customQueue ?? false
  let journey = restored?.journey ?? emptyQueueJourney()
  const queueVersion = ref(0)
  const currentTrackVersion = ref(0)
  const lastTrackId = settingsStore().getItem(LAST_TRACK_KEY)
  const currentTrackId = ref<string | null>(
    restored?.currentTrackId ?? (lastTrackId ? normalizeTrackId(lastTrackId) : null),
  )
  const isPlaying = ref(false)
  const currentTime = ref(restored?.position ?? 0)
  const resumePosition = ref(restored?.position ?? 0)
  const hasResumePosition = computed(() => resumePosition.value > 0)
  let resumeTrackId = restored?.currentTrackId ?? null
  let resumeSource = restored?.audioUrl ?? ''
  let sessionTimer = 0
  let canPersistSession = (): boolean => true
  function setPlaybackSessionGuard(guard: () => boolean): void {
    canPersistSession = guard
  }
  const duration = ref(0)
  const settings = ref<PlayerSettings>(loadSettings())
  const errorMessage = ref('')
  // A newly opened follower can display metadata before its library finishes loading.
  const syncedTrack = shallowRef<Track | null>(null)
  function setSyncedTrack(track: Track): void {
    const previous = syncedTrack.value
    if (
      !previous ||
      previous.id !== track.id ||
      previous.audioUrl !== track.audioUrl ||
      previous.title !== track.title ||
      previous.artist !== track.artist ||
      previous.cover !== track.cover ||
      previous.album !== track.album
    )
      syncedTrack.value = track
    if (journey.history[journey.historyIndex] !== track.id)
      journey = visitQueueTrack(journey, track.id, 'select')
    currentTrackId.value = track.id
  }

  const trackById = computed(() => new Map(tracks.value.map((track) => [track.id, track])))
  const queueIndexById = computed(
    () => new Map(queue.value.map((track, index) => [track.id, index])),
  )

  const currentTrack = computed(() =>
    currentTrackId.value
      ? (trackById.value.get(currentTrackId.value) ??
        (syncedTrack.value?.id === currentTrackId.value ? syncedTrack.value : null))
      : null,
  )
  const currentIndex = computed(() =>
    currentTrackId.value ? (queueIndexById.value.get(currentTrackId.value) ?? -1) : -1,
  )

  function bumpQueueVersion() {
    queueVersion.value += 1
    scheduleSessionSave()
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

  function setTracks(nextTracks: Track[], options: { complete?: boolean } = {}) {
    const activeTrack = currentTrack.value ?? undefined
    const incomingTracks =
      options.complete === false
        ? [...new Map([...tracks.value, ...nextTracks].map((track) => [track.id, track])).values()]
        : nextTracks
    const mergedTracks = activeTrack
      ? incomingTracks.map((track) => {
          if (track.id !== activeTrack.id) return track
          carryTrackSideData?.(track, activeTrack)
          // 渐进加载会复用当前对象，先复制，避免删除可选字段时连来源一起删掉。
          const nextMetadata = { ...track }
          delete activeTrack.titleVersions
          delete activeTrack.shareAliases
          delete activeTrack.album
          delete activeTrack.cover
          Object.assign(activeTrack, nextMetadata)
          bumpCurrentTrackVersion()
          return activeTrack
        })
      : incomingTracks
    const mergedTrackById = new Map(mergedTracks.map((track) => [track.id, track]))
    if (options.complete !== false) queueIds = queueIds.filter((id) => mergedTrackById.has(id))
    if (!customQueue)
      queueIds = [...new Set([...queueIds, ...mergedTracks.map((track) => track.id)])]
    const syncedQueue = queueIds
      .map((id) => mergedTrackById.get(id))
      .filter((track): track is Track => Boolean(track))

    tracks.value = mergedTracks
    if (queue.value.length || syncedQueue.length) {
      queue.value = syncedQueue
      bumpQueueVersion()
    }
    if (
      options.complete !== false &&
      currentTrackId.value &&
      syncedTrack.value?.id !== currentTrackId.value &&
      !mergedTrackById.has(currentTrackId.value)
    ) {
      currentTrackId.value = null
      clearResume()
      currentTime.value = 0
    }
    pruneJourney()
    if (currentTrack.value && journey.history[journey.historyIndex] !== currentTrack.value.id)
      journey = visitQueueTrack(journey, currentTrack.value.id, 'select')
    if (currentTrack.value) getResumePosition(currentTrack.value)
  }

  function selectTrack(track: Track, sourceQueue: Track[] = tracks.value) {
    queue.value = [...new Map([...sourceQueue, track].map((item) => [item.id, item])).values()]
    queueIds = queue.value.map((item) => item.id)
    customQueue = true
    journey = { ...journey, remaining: [], played: [], priority: [] }
    pruneJourney()
    bumpQueueVersion()
    setCurrentTrack(track, 'select')
  }

  function setCurrentTrack(track: Track, direction: 'next' | 'previous' | 'select') {
    clearResume()
    journey = visitQueueTrack(journey, track.id, direction)
    currentTrackId.value = track.id
    currentTime.value = 0
    duration.value = 0
    errorMessage.value = ''
    scheduleSessionSave()
  }

  function pruneJourney() {
    const allowed = new Set(queueIds)
    const before = journey.history.slice(0, journey.historyIndex + 1)
    journey = {
      history: journey.history.filter((id) => allowed.has(id)),
      historyIndex: before.filter((id) => allowed.has(id)).length - 1,
      remaining: journey.remaining.filter((id) => allowed.has(id)),
      played: journey.played.filter((id) => allowed.has(id)),
      priority: journey.priority.filter((id) => allowed.has(id)),
    }
  }

  function peek(
    direction: 'next' | 'previous',
    manual: boolean,
    unavailable: (id: string) => boolean,
  ): Track | null {
    if (!queue.value.length) return null
    const availableIds = queue.value.map((track) => track.id)
    if (settings.value.playMode === 'shuffle' && direction === 'next') {
      // Keep not-yet-loaded IDs in the round; progressive loading must not redraw it.
      journey = prepareQueueJourney(journey, queueIds, currentTrackId.value, Math.random)
      scheduleSessionSave()
    }
    const readPlannedId = () =>
      peekJourneyTrack(
        journey,
        availableIds,
        currentTrackId.value,
        settings.value.playMode,
        direction,
        manual,
        unavailable,
      )
    let id = readPlannedId()
    if (
      !id &&
      direction === 'next' &&
      settings.value.playMode === 'shuffle' &&
      availableIds.some(
        (candidate) => candidate !== currentTrackId.value && !unavailable(candidate),
      )
    ) {
      // A round whose remaining songs all failed must not stop an otherwise usable queue.
      journey = prepareQueueJourney(
        { ...journey, remaining: [], played: currentTrackId.value ? [currentTrackId.value] : [] },
        queueIds,
        currentTrackId.value,
        Math.random,
      )
      id = readPlannedId()
      scheduleSessionSave()
    }
    return id ? (queue.value.find((track) => track.id === id) ?? null) : null
  }

  function peekNext(
    manual = false,
    unavailable: (id: string) => boolean = () => false,
  ): Track | null {
    return peek('next', manual, unavailable)
  }

  function peekPrevious(unavailable: (id: string) => boolean = () => false): Track | null {
    return peek('previous', true, unavailable)
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
    if (track) setCurrentTrack(track, 'next')
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
    if (track) setCurrentTrack(track, 'previous')
    return track
  }

  function enqueueTrack(track: Track, next = false): void {
    if (!trackById.value.has(track.id)) return
    customQueue = true
    if (next && track.id !== currentTrackId.value) {
      queueIds = queueIds.filter((id) => id !== track.id)
      const after = currentTrackId.value ? queueIds.indexOf(currentTrackId.value) + 1 : 0
      queueIds.splice(Math.max(0, after), 0, track.id)
      journey = {
        ...journey,
        priority: [track.id, ...journey.priority.filter((id) => id !== track.id)],
      }
    } else if (!queueIds.includes(track.id)) queueIds.push(track.id)
    rebuildEditedQueue()
  }

  function rebuildEditedQueue(): void {
    queue.value = queueIds
      .map((id) => trackById.value.get(id))
      .filter((track): track is Track => Boolean(track))
    pruneJourney()
    bumpQueueVersion()
  }

  function removeQueuedTrack(id: string): boolean {
    if (id === currentTrackId.value || !queueIds.includes(id)) return false
    customQueue = true
    queueIds = queueIds.filter((item) => item !== id)
    rebuildEditedQueue()
    return true
  }

  function moveQueuedTrack(fromId: string, toId: string): boolean {
    const from = queueIds.indexOf(fromId)
    const to = queueIds.indexOf(toId)
    if (from < 0 || to < 0 || from === to) return false
    customQueue = true
    queueIds.splice(from, 1)
    queueIds.splice(to, 0, fromId)
    journey = { ...journey, priority: [] }
    rebuildEditedQueue()
    return true
  }

  function selectQueuedTrack(track: Track): void {
    if (!queue.value.some((item) => item.id === track.id)) enqueueTrack(track)
    if (queue.value.some((item) => item.id === track.id)) setCurrentTrack(track, 'select')
  }

  function captureQueueJourney(): QueueJourney {
    return {
      ...journey,
      history: [...journey.history],
      remaining: [...journey.remaining],
      played: [...journey.played],
      priority: [...journey.priority],
    }
  }

  function restoreQueueJourney(saved: QueueJourney, track: Track | null): void {
    journey = saved
    pruneJourney()
    if (track) currentTrackId.value = track.id
    scheduleSessionSave()
  }

  function clearResume(): void {
    resumePosition.value = 0
    resumeTrackId = null
    resumeSource = ''
  }

  function getResumePosition(track: Track): number | null {
    if (!resumePosition.value) return null
    if (!canResumePlayback(resumeTrackId, resumeSource, track)) {
      clearResume()
      currentTime.value = 0
      return null
    }
    return resumePosition.value
  }

  function persistPlaybackSession(): void {
    if (sessionTimer) window.clearTimeout(sessionTimer)
    sessionTimer = 0
    if (!canPersistSession()) return
    const session: PlaybackSession = {
      version: 1,
      queueIds: [...queueIds],
      customQueue,
      currentTrackId: currentTrackId.value,
      audioUrl: currentTrack.value?.audioUrl ?? resumeSource,
      position: Number.isFinite(currentTime.value)
        ? Math.max(0, resumePosition.value || currentTime.value)
        : 0,
      journey: captureQueueJourney(),
    }
    settingsStore().setItem(PLAYBACK_SESSION_KEY, JSON.stringify(session))
    // The mode and its shuffle round must survive the same page-close boundary.
    persistSettings()
  }

  function scheduleSessionSave(): void {
    if (!canPersistSession()) return
    if (!sessionTimer) sessionTimer = window.setTimeout(persistPlaybackSession, 1000)
  }

  watch([currentTime, currentTrackId], scheduleSessionSave)
  watch(isPlaying, (playing) => {
    if (!playing) persistPlaybackSession()
  })
  watch(
    () => settings.value.playMode,
    () => {
      journey = {
        ...journey,
        remaining: [],
        played: currentTrackId.value ? [currentTrackId.value] : [],
      }
      scheduleSessionSave()
    },
    { flush: 'sync' },
  )

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
    persistPlaybackSession()
    if (saveSettingsTimer) {
      window.clearTimeout(saveSettingsTimer)
      saveSettingsTimer = 0
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
    if (!canPersistSession()) return
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
    resumePosition,
    hasResumePosition,
    duration,
    settings,
    errorMessage,
    setTracks,
    setSyncedTrack,
    selectTrack,
    enqueueTrack,
    removeQueuedTrack,
    moveQueuedTrack,
    selectQueuedTrack,
    captureQueueJourney,
    restoreQueueJourney,
    clearResume,
    getResumePosition,
    persistPlaybackSession,
    setPlaybackSessionGuard,
    onTrackReplaced,
    peekNext,
    peekPrevious,
    nextTrack,
    previousTrack,
    cyclePlayMode,
    resetSettings,
  }
})
