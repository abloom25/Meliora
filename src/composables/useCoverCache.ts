import { ref, shallowRef, triggerRef } from 'vue'
import type { Ref, ShallowRef } from 'vue'

const loadedCovers = shallowRef(new Set<string>())
const failedCovers = shallowRef(new Set<string>())
const COVER_STATE_LIMIT = 512
const COVER_FAILURE_RETRY_MS = 5 * 60 * 1000
const failureTimers = new Map<string, ReturnType<typeof setTimeout>>()
// 主封面（now-playing 大图）当前是否已加载完成。
// 单独维护这个状态，避免因为 loadedCovers 是持久 singleton，
// 切到一首已加载过的歌时主封面不再触发 fade-in transition。
const mainCoverReadyTrackId = ref<string | null>(null)

export interface UseCoverCacheReturn {
  loadedCovers: ShallowRef<Set<string>>
  failedCovers: ShallowRef<Set<string>>
  mainCoverReadyTrackId: Ref<string | null>
  markCoverLoaded: (trackId: string, coverUrl?: string) => void
  markCoverFailed: (trackId: string, coverUrl?: string) => void
  markMainCoverReady: (trackId: string) => void
  resetMainCover: () => void
}

export function useCoverCache(): UseCoverCacheReturn {
  function rememberTrackId(cache: Set<string>, trackId: string) {
    if (cache.has(trackId)) cache.delete(trackId)
    cache.add(trackId)
    while (cache.size > COVER_STATE_LIMIT) {
      const oldest = cache.values().next().value
      if (!oldest) break
      cache.delete(oldest)
    }
  }

  function markCoverLoaded(trackId: string, coverUrl?: string) {
    const key = coverUrl ?? trackId
    clearTimeout(failureTimers.get(key))
    failureTimers.delete(key)
    if (failedCovers.value.delete(key)) triggerRef(failedCovers)
    rememberTrackId(loadedCovers.value, key)
    triggerRef(loadedCovers)
  }

  function markCoverFailed(trackId: string, coverUrl?: string) {
    const key = coverUrl ?? trackId
    clearTimeout(failureTimers.get(key))
    if (loadedCovers.value.delete(key)) triggerRef(loadedCovers)
    rememberTrackId(failedCovers.value, key)
    // 失败只对当前 URL 生效；瞬时网络故障在重试窗口后自动放行。
    failureTimers.set(
      key,
      setTimeout(() => {
        failureTimers.delete(key)
        if (failedCovers.value.delete(key)) triggerRef(failedCovers)
      }, COVER_FAILURE_RETRY_MS),
    )
    for (const [cachedKey, timer] of failureTimers) {
      if (failedCovers.value.has(cachedKey)) continue
      clearTimeout(timer)
      failureTimers.delete(cachedKey)
    }
    triggerRef(failedCovers)
  }

  function markMainCoverReady(trackId: string) {
    mainCoverReadyTrackId.value = trackId
  }

  function resetMainCover() {
    mainCoverReadyTrackId.value = null
  }

  return {
    loadedCovers,
    failedCovers,
    mainCoverReadyTrackId,
    markCoverLoaded,
    markCoverFailed,
    markMainCoverReady,
    resetMainCover,
  }
}
