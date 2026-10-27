import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Track } from '../core/types'
import { listeningTrackKey } from '../core/playback/listening-stats'
import { sanitizeFavoriteKeys } from '../core/library/personal-library'
import { settingsStore } from '../platform/settings-store'

const FAVORITES_KEY = 'meliora:favorite-tracks'

export const useLibraryStore = defineStore('library', () => {
  let saved: unknown
  try {
    saved = JSON.parse(settingsStore().getItem(FAVORITES_KEY) || '[]')
  } catch {
    saved = []
  }
  const favoriteKeys = ref(sanitizeFavoriteKeys(saved))
  const favorites = computed<ReadonlySet<string>>(() => new Set(favoriteKeys.value))

  function isFavorite(track: Track): boolean {
    return favorites.value.has(listeningTrackKey(track))
  }

  function toggleFavorite(track: Track): boolean {
    const key = listeningTrackKey(track)
    const selected = !favorites.value.has(key)
    favoriteKeys.value = selected
      ? [key, ...favoriteKeys.value].slice(0, 5000)
      : favoriteKeys.value.filter((existing) => existing !== key)
    settingsStore().setItem(FAVORITES_KEY, JSON.stringify(favoriteKeys.value))
    return selected
  }

  return { favorites, isFavorite, toggleFavorite }
})
