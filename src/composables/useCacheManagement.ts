import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { Track } from '../core/types'
import type { BeatThisModelId } from '../core/analysis/beat-this-models'
import type { LyricsCacheStats } from '../core/platform/lyrics-cache'
import { groupBeatCacheEntries } from '../core/analysis/beat-result-cache'
import { listeningTrackKey } from '../core/playback/listening-stats'
import { beatResultCache } from '../platform/web/beat-result-cache'
import { webLyricsCacheStore } from '../platform/web/lyrics-cache'
import { listeningStatsSummary } from '../platform/web/listening-history'
import { useBeatThisModels } from '../platform/web/useBeatThisModels'
import { usePlayerStore } from '../stores/player'
import { resetWordLyricsCache } from '../services/lyrics-db'
import { resetNativeLyricsCache } from '../services/native-lyrics'
import { resetTrackLyricsCache } from '../services/lyrics'

export function useCacheManagement(currentTrack: Ref<Track | null | undefined>) {
  const models = useBeatThisModels()
  const player = usePlayerStore()
  const loading = ref(true)
  const busy = ref('')
  const error = ref('')
  const lyrics = ref<LyricsCacheStats>({ entries: 0, bytes: 0, storageAvailable: true })
  const modelBytes = ref({ small: 0, standard: 0, runtime: 0 })
  let disposed = false
  let refreshVersion = 0
  const tracks = computed(() =>
    groupBeatCacheEntries(beatResultCache.status.value.entries).map((entry) => {
      const current =
        currentTrack.value && listeningTrackKey(currentTrack.value) === entry.track
          ? currentTrack.value
          : null
      const history = listeningStatsSummary.value.trackedTracks.find(
        (record) => record.key === entry.track,
      )
      const library = player.tracks.find((track) => listeningTrackKey(track) === entry.track)
      return {
        ...entry,
        title: current?.title || library?.title || history?.title || '已缓存歌曲',
        artist: current?.artist || library?.artist || history?.artist || '',
        current: !!current,
      }
    }),
  )
  async function refresh(): Promise<void> {
    const version = ++refreshVersion
    const results = await Promise.allSettled([
      Promise.resolve().then(() => beatResultCache.store.refresh()),
      Promise.resolve().then(() => models.savedBytes()),
      Promise.resolve().then(() => webLyricsCacheStore.stats!()),
    ])
    if (disposed || version !== refreshVersion) return
    if (results[1].status === 'fulfilled') modelBytes.value = results[1].value
    if (results[2].status === 'fulfilled') lyrics.value = results[2].value
    else lyrics.value = { ...lyrics.value, storageAvailable: false }
    if (results.some((result) => result.status === 'rejected') && !error.value)
      error.value = '部分缓存占用暂时无法读取，请稍后重试'
    loading.value = false
  }
  async function perform(key: string, operation: () => Promise<void>): Promise<void> {
    if (busy.value) return
    busy.value = key
    error.value = ''
    try {
      await operation()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '操作未完成，请稍后重试'
    } finally {
      await refresh()
      busy.value = ''
    }
  }
  const clearLyrics = (): Promise<void> =>
    perform('lyrics', async () => {
      // Cancel existing queries before clearing; their captured epochs cannot repopulate IDB.
      resetWordLyricsCache()
      resetNativeLyricsCache()
      resetTrackLyricsCache()
      await webLyricsCacheStore.clear!()
    })
  const removeModel = (id: BeatThisModelId): Promise<void> =>
    perform(id, async () => {
      if (player.settings.beatAnalysisMode === `beat-this-${id}`)
        player.settings.beatAnalysisMode = 'basic'
      await models.remove(id)
      if (models.status.value[id].phase === 'error')
        throw new Error(models.status.value[id].error ?? '模型缓存未能删除，请重试')
    })
  onMounted(() => {
    void Promise.resolve()
      .then(() => models.initialize())
      .catch(() => {
        if (!disposed) error.value = '模型缓存暂时无法读取，请稍后重试'
      })
      .then(refresh)
  })
  // Refresh on completed/cancelled downloads, not for every progress notification.
  watch(
    [() => models.status.value.small.phase, () => models.status.value.standard.phase],
    () => void refresh(),
  )
  onBeforeUnmount(() => {
    disposed = true
  })
  return {
    loading,
    busy,
    error,
    lyrics,
    modelBytes,
    tracks,
    models: models.status,
    beat: beatResultCache.status,
    refresh,
    clearLyrics,
    removeModel,
    clearBeats: (): Promise<void> => perform('beats', () => beatResultCache.store.clear()),
    removeTrack: (track: string): Promise<void> =>
      perform(track, () => beatResultCache.removeTrack(track)),
    pinTrack: (track: string, pinned: boolean): Promise<void> =>
      perform(track, () => beatResultCache.pinTrack(track, pinned)),
    setBudget: (megabytes: number): Promise<void> =>
      perform('budget', () => beatResultCache.setMaxBytes(megabytes * 1024 * 1024)),
  }
}
