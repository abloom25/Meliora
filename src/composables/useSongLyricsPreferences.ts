import { computed, onScopeDispose, shallowRef, type Ref } from 'vue'
import type { LyricProviderSource, Track } from '../core/types'
import type { KeyValueStore } from '../core/platform/storage'
import { listeningTrackKey, normalizeListeningKey } from '../core/playback/listening-stats'
import { settingsStore } from '../platform/settings-store'
import { invalidateTrackLyrics, type LyricsSourceSelection } from '../services/lyrics'

const STORAGE_KEY = 'meliora.song-lyrics.v1'
const SOURCES: LyricsSourceSelection[] = ['auto', 'amll', 'netease', 'qq', 'meting', 'local']
const MAX_RECORDS = 256
const MAX_OFFSET_MS = 30000

interface SongLyricsPreference {
  source: LyricsSourceSelection
  offsets: Partial<Record<LyricProviderSource, number>>
  updatedAt: number
}

const preferences = shallowRef<Record<string, SongLyricsPreference>>({})
const resolvedSources = shallowRef<Record<string, LyricProviderSource | null>>({})
const refreshVersions = shallowRef<Record<string, number>>({})
let loadedStore: KeyValueStore | null = null
let saveTimer: ReturnType<typeof setTimeout> | undefined
let subscribers = 0

export function songLyricsPreferenceKey(track: Track | null): string {
  return track ? listeningTrackKey(track) : ''
}

function remember<T>(entries: Record<string, T>, key: string, value: T): Record<string, T> {
  return Object.fromEntries(
    [
      ...Object.entries(entries).filter(([item]) => item !== key),
      [key, value] as [string, T],
    ].slice(-MAX_RECORDS),
  )
}

function save(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  loadedStore?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, songs: preferences.value }))
}

function ensureLoaded(): void {
  const storage = settingsStore()
  if (loadedStore === storage) return
  if (saveTimer) save()
  loadedStore = storage
  preferences.value = {}
  resolvedSources.value = {}
  refreshVersions.value = {}
  try {
    const stored: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    if (!stored || typeof stored !== 'object') return
    const data = stored as { version?: number; songs?: unknown }
    if (data.version !== 1 || !data.songs || typeof data.songs !== 'object') return
    const restored: Record<string, SongLyricsPreference> = {}
    for (const [key, value] of Object.entries(data.songs).slice(-MAX_RECORDS)) {
      if (!value || typeof value !== 'object') continue
      const item = value as Partial<SongLyricsPreference>
      if (!item.source || !SOURCES.includes(item.source)) continue
      const offsets: SongLyricsPreference['offsets'] = {}
      for (const source of SOURCES) {
        if (source === 'auto') continue
        const offset = item.offsets?.[source]
        if (typeof offset === 'number' && Number.isFinite(offset))
          offsets[source] =
            Math.round(Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, offset)) / 100) * 100
      }
      const normalizedKey = normalizeListeningKey(key)
      const updatedAt = Number.isFinite(item.updatedAt) ? item.updatedAt! : 0
      if (restored[normalizedKey] && restored[normalizedKey]!.updatedAt > updatedAt) continue
      restored[normalizedKey] = {
        source: item.source,
        offsets,
        updatedAt,
      }
    }
    preferences.value = restored
  } catch {
    // 损坏或不支持的记录只丢弃本地偏好，不影响歌词加载。
  }
}

export function useSongLyricsPreferences(track: Readonly<Ref<Track | null>>) {
  ensureLoaded()
  subscribers += 1
  onScopeDispose(() => {
    subscribers -= 1
    if (!subscribers && saveTimer) save()
  })
  const key = computed(() => songLyricsPreferenceKey(track.value))
  const preference = computed(() => preferences.value[key.value])
  const selection = computed(() => preference.value?.source ?? 'auto')
  const resolvedSource = computed(() => resolvedSources.value[key.value] ?? null)
  const revision = computed(() => refreshVersions.value[key.value] ?? 0)
  const offsetMs = computed(() => getOffset(resolvedSource.value))

  function update(patch: Partial<SongLyricsPreference>): void {
    if (!key.value) return
    const entries = { ...preferences.value }
    entries[key.value] = {
      ...(preference.value ?? { source: 'auto', offsets: {}, updatedAt: 0 }),
      ...patch,
      updatedAt: Date.now(),
    }
    const ordered = Object.entries(entries).sort(
      (left, right) => right[1].updatedAt - left[1].updatedAt,
    )
    preferences.value = Object.fromEntries(ordered.slice(0, MAX_RECORDS))
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 200)
  }

  function getOffset(source: LyricProviderSource | null): number {
    return source ? (preference.value?.offsets[source] ?? 0) : 0
  }

  function setSource(source: LyricsSourceSelection): void {
    if (SOURCES.includes(source)) update({ source })
  }

  function reportSource(source: LyricProviderSource | null): void {
    if (!key.value || resolvedSource.value === source) return
    resolvedSources.value = remember(resolvedSources.value, key.value, source)
  }

  function setOffset(milliseconds: number): void {
    const source = resolvedSource.value
    if (!source || !Number.isFinite(milliseconds)) return
    const offset =
      Math.round(Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, milliseconds)) / 100) * 100
    update({ offsets: { ...preference.value?.offsets, [source]: offset } })
  }

  async function refresh(): Promise<void> {
    const current = track.value
    const currentKey = key.value
    if (!current || !currentKey) return
    await invalidateTrackLyrics(current)
    refreshVersions.value = remember(
      refreshVersions.value,
      currentKey,
      (refreshVersions.value[currentKey] ?? 0) + 1,
    )
  }

  return {
    selection,
    resolvedSource,
    revision,
    offsetMs,
    getOffset,
    setSource,
    reportSource,
    setOffset,
    refresh,
  }
}
