import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

const CHROME_IDLE_DELAY = 30000

export interface UseChromeAutoHideOptions {
  listOpen: Ref<boolean>
  settingsOpen: Ref<boolean>
  autoHideChrome: () => boolean
}

export function useChromeAutoHide(options: UseChromeAutoHideOptions) {
  const { listOpen, settingsOpen, autoHideChrome } = options

  const chromeHidden = ref(false)
  let chromeIdleTimer = 0

  function scheduleChromeHide() {
    window.clearTimeout(chromeIdleTimer)
    if (!autoHideChrome() || listOpen.value || settingsOpen.value) {
      chromeHidden.value = false
      return
    }
    chromeIdleTimer = window.setTimeout(() => {
      if (autoHideChrome() && !listOpen.value && !settingsOpen.value) {
        chromeHidden.value = true
      }
    }, CHROME_IDLE_DELAY)
  }

  function revealChrome() {
    chromeHidden.value = false
    scheduleChromeHide()
  }

  function clearChromeTimer() {
    window.clearTimeout(chromeIdleTimer)
  }

  function handleActivity() {
    if (autoHideChrome() && !listOpen.value && !settingsOpen.value) {
      revealChrome()
    }
  }

  function handleVisibilityChange() {
    if (!document.hidden) {
      revealChrome()
    }
  }

  onMounted(() => {
    window.addEventListener('mousemove', handleActivity, { passive: true })
    window.addEventListener('keydown', handleActivity, { passive: true })
    window.addEventListener('touchstart', handleActivity, { passive: true })
    document.addEventListener('visibilitychange', handleVisibilityChange)
  })

  onBeforeUnmount(() => {
    clearChromeTimer()
    window.removeEventListener('mousemove', handleActivity)
    window.removeEventListener('keydown', handleActivity)
    window.removeEventListener('touchstart', handleActivity)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
  })

  return {
    chromeHidden,
    scheduleChromeHide,
    revealChrome,
    clearChromeTimer,
  }
}
