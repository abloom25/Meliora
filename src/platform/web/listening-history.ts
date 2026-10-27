import { computed, shallowRef } from 'vue'
import type { Track } from '../../core/types'
import {
  isFrequentlyPlayed,
  listeningTrackKey,
  sanitizeListeningRecords,
  LISTENING_HISTORY_LIMIT,
  type ListeningRecord,
} from '../../core/playback/listening-stats'
import { beatResultCache } from './beat-result-cache'
import { settingsStore } from '../settings-store'

const STORAGE_KEY = 'meliora:listening-history:v1'
const records = shallowRef<readonly ListeningRecord[]>([])
const available = shallowRef(true)
const clearing = shallowRef(false)
let initialized = false
let dirty = false
let lastSavedAt = 0
let generation = 0
const pending = new Map<string, ListeningRecord>()

function readSavedRecords(): ListeningRecord[] {
  const raw = settingsStore().getItem(STORAGE_KEY)
  const value: unknown = raw ? JSON.parse(raw) : null
  return value &&
    typeof value === 'object' &&
    'version' in value &&
    value.version === 1 &&
    'records' in value
    ? sanitizeListeningRecords(value.records)
    : []
}

export function refreshListeningHistory(): void {
  initializeListeningHistory()
  saveListeningHistory(true)
  try {
    records.value = readSavedRecords()
  } catch {
    available.value = false
  }
}

export function initializeListeningHistory(): void {
  if (initialized) return
  initialized = true
  try {
    const raw = settingsStore().getItem(STORAGE_KEY)
    const value: unknown = raw ? JSON.parse(raw) : null
    if (
      value &&
      typeof value === 'object' &&
      'version' in value &&
      value.version === 1 &&
      'records' in value
    )
      records.value = sanitizeListeningRecords(value.records)
  } catch {
    available.value = false
  }
  void beatResultCache.store.refresh()
}

export function saveListeningHistory(force = false): void {
  if (!dirty || (!force && Date.now() - lastSavedAt < 5000)) return
  try {
    // Merge this tab's increments with the latest saved totals, never its stale snapshot.
    const merged = new Map(readSavedRecords().map((record) => [record.key, record]))
    for (const [key, delta] of pending) {
      const saved = merged.get(key)
      merged.set(key, {
        ...delta,
        qualifiedPlays: Math.min(
          Number.MAX_SAFE_INTEGER,
          (saved?.qualifiedPlays ?? 0) + delta.qualifiedPlays,
        ),
        listenedSeconds: (saved?.listenedSeconds ?? 0) + delta.listenedSeconds,
        lastPlayedAt: Math.max(saved?.lastPlayedAt ?? 0, delta.lastPlayedAt),
      })
    }
    const updated = [...merged.values()]
      .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt)
      .slice(0, LISTENING_HISTORY_LIMIT)
    const serialized = JSON.stringify({ version: 1, records: updated })
    settingsStore().setItem(STORAGE_KEY, serialized)
    available.value = settingsStore().getItem(STORAGE_KEY) === serialized
    if (available.value) {
      records.value = updated
      pending.clear()
      dirty = false
    }
    lastSavedAt = Date.now()
  } catch {
    available.value = false
  }
}

export function recordListening(track: Track, seconds: number, qualified: boolean): void {
  initializeListeningHistory()
  if (!Number.isFinite(seconds) || seconds <= 0) return
  const key = listeningTrackKey(track)
  const existing = records.value.find((record) => record.key === key)
  const next: ListeningRecord = {
    key,
    title: track.title.slice(0, 512),
    artist: track.artist.slice(0, 512),
    qualifiedPlays: (existing?.qualifiedPlays ?? 0) + Number(qualified),
    listenedSeconds: (existing?.listenedSeconds ?? 0) + seconds,
    lastPlayedAt: Date.now(),
  }
  records.value = [next, ...records.value.filter((record) => record.key !== key)].slice(
    0,
    LISTENING_HISTORY_LIMIT,
  )
  const delta = pending.get(key)
  pending.set(key, {
    ...next,
    qualifiedPlays: (delta?.qualifiedPlays ?? 0) + Number(qualified),
    listenedSeconds: (delta?.listenedSeconds ?? 0) + seconds,
  })
  while (pending.size > LISTENING_HISTORY_LIMIT) pending.delete(pending.keys().next().value!)
  dirty = true
  saveListeningHistory(qualified)
}

export function isFrequentListeningTrack(key: string): boolean {
  initializeListeningHistory()
  if (clearing.value) return false
  return (
    isFrequentlyPlayed(records.value.find((record) => record.key === key)) ||
    beatResultCache.status.value.entries.some((entry) => entry.track === key && entry.pinned)
  )
}

export function listeningHistoryGeneration(): number {
  return generation
}

export async function clearListeningHistory(): Promise<void> {
  clearing.value = true
  try {
    // Statistics and cached analysis are independently owned user data.
    settingsStore().removeItem(STORAGE_KEY)
    available.value = settingsStore().getItem(STORAGE_KEY) === null
    if (!available.value) throw new Error('无法清除本机听歌统计，请检查浏览器存储权限后重试')
    generation += 1
    records.value = []
    dirty = false
    pending.clear()
  } finally {
    clearing.value = false
  }
}

export const listeningStatsSummary = computed(() => {
  const trackedTracks = records.value.map((record) => ({
    ...record,
    frequent: isFrequentlyPlayed(record),
  }))
  return {
    totalListenedSeconds: trackedTracks.reduce((sum, record) => sum + record.listenedSeconds, 0),
    totalQualifiedPlays: trackedTracks.reduce((sum, record) => sum + record.qualifiedPlays, 0),
    frequentTracks: trackedTracks.filter((record) => record.frequent).length,
    trackedTracks,
    cachedTracks: beatResultCache.status.value.cachedTracks,
    cacheBytes: beatResultCache.status.value.cacheBytes,
    storageAvailable: available.value,
  }
})
export type ListeningStatsSummary = typeof listeningStatsSummary.value
