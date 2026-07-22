import { readonly, ref } from 'vue'

const activeFileStageCount = ref(0)

export function useFileStagingState() {
  function beginFileStaging(): () => void {
    activeFileStageCount.value += 1
    let finished = false

    return () => {
      if (finished) return
      finished = true
      activeFileStageCount.value = Math.max(0, activeFileStageCount.value - 1)
    }
  }

  return {
    activeFileStageCount: readonly(activeFileStageCount),
    beginFileStaging,
  }
}
