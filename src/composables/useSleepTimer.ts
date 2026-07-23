import { computed, onBeforeUnmount, ref } from 'vue'

export interface UseSleepTimerOptions {
  onPause: () => void
  onShowNotice: (msg: string) => void
}

const sleepTimerOptions = [0, 15, 30, 45, 60, 90] as const

export function useSleepTimer(options: UseSleepTimerOptions) {
  const { onPause, onShowNotice } = options

  const sleepTimerMinutes = ref(0)
  const sleepTimerRemaining = ref(0)
  const sleepTimerDraftMinutes = ref<number | null>(null)
  const sleepTimerDragging = ref(false)

  let sleepTimerId = 0
  let sleepTimerEndsAt = 0

  const sleepTimerDisplayMinutes = computed(
    () =>
      sleepTimerDraftMinutes.value ??
      (sleepTimerMinutes.value ? sleepTimerRemaining.value / 60 : 0),
  )

  const sleepTimerProgress = computed(() =>
    Math.max(0, Math.min(100, (sleepTimerDisplayMinutes.value / 90) * 100)),
  )

  function formatSleepTimerRemaining(seconds: number) {
    if (seconds <= 0) return '关闭'
    return `${Math.ceil(seconds / 60)} 分钟后停止播放`
  }

  function clearSleepTimer() {
    window.clearTimeout(sleepTimerId)
    sleepTimerId = 0
    sleepTimerEndsAt = 0
    sleepTimerRemaining.value = 0
  }

  function tickSleepTimer() {
    if (!sleepTimerEndsAt) return
    const remaining = Math.max(0, Math.ceil((sleepTimerEndsAt - Date.now()) / 1000))
    sleepTimerRemaining.value = remaining
    if (remaining <= 0) {
      clearSleepTimer()
      sleepTimerMinutes.value = 0
      onPause()
      onShowNotice('定时关闭已完成')
      return
    }
    sleepTimerId = window.setTimeout(tickSleepTimer, 1000)
  }

  // 后台标签页里 1s 链式 setTimeout 会被浏览器节流（最长可延迟约 1 分钟），
  // 回到前台时立即校验 endsAt，已过期则直接走 tick 的到期分支，不等下一次 tick。
  function handleVisibilityChange() {
    if (document.hidden || !sleepTimerEndsAt) return
    if (Date.now() >= sleepTimerEndsAt) tickSleepTimer()
  }

  function setSleepTimer(minutes: number) {
    sleepTimerMinutes.value = minutes
    sleepTimerDraftMinutes.value = null
    sleepTimerDragging.value = false
    clearSleepTimer()
    if (!minutes) {
      onShowNotice('定时关闭已关闭')
      return
    }
    sleepTimerEndsAt = Date.now() + minutes * 60 * 1000
    sleepTimerRemaining.value = minutes * 60
    onShowNotice(`将在 ${minutes} 分钟后停止播放`)
    tickSleepTimer()
  }

  function snapSleepTimerMinutes(value: number) {
    return sleepTimerOptions.reduce((closest, option) =>
      Math.abs(option - value) < Math.abs(closest - value) ? option : closest,
    )
  }

  function handleSleepTimerInput(value: number) {
    sleepTimerDragging.value = true
    sleepTimerDraftMinutes.value = value
  }

  function handleSleepTimerChange(value: number) {
    setSleepTimer(snapSleepTimerMinutes(value))
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange)
  }

  onBeforeUnmount(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
    clearSleepTimer()
  })

  return {
    sleepTimerMinutes,
    sleepTimerRemaining,
    sleepTimerDraftMinutes,
    sleepTimerDragging,
    sleepTimerOptions,
    sleepTimerDisplayMinutes,
    sleepTimerProgress,
    formatSleepTimerRemaining,
    clearSleepTimer,
    setSleepTimer,
    snapSleepTimerMinutes,
    handleSleepTimerInput,
    handleSleepTimerChange,
  }
}
