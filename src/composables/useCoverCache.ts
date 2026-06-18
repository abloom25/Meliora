import { ref, shallowRef, triggerRef } from 'vue'
import type { Ref, ShallowRef } from 'vue'

const loadedCovers = shallowRef(new Set<string>())
const failedCovers = shallowRef(new Set<string>())
// 主封面（now-playing 大图）当前是否已加载完成。
// 单独维护这个状态，避免因为 loadedCovers 是持久 singleton，
// 切到一首已加载过的歌时主封面不再触发 fade-in transition。
const mainCoverReadyTrackId = ref<string | null>(null)

export interface UseCoverCacheReturn {
  loadedCovers: ShallowRef<Set<string>>
  failedCovers: ShallowRef<Set<string>>
  mainCoverReadyTrackId: Ref<string | null>
  markCoverLoaded: (trackId: string) => void
  markCoverFailed: (trackId: string) => void
  markMainCoverReady: (trackId: string) => void
  resetMainCover: () => void
}

export function useCoverCache(): UseCoverCacheReturn {
  function markCoverLoaded(trackId: string) {
    loadedCovers.value.add(trackId)
    triggerRef(loadedCovers)
  }

  function markCoverFailed(trackId: string) {
    failedCovers.value.add(trackId)
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
