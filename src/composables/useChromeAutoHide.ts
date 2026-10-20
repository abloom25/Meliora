import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

const CHROME_IDLE_DELAY = 30000

export interface UseChromeAutoHideOptions {
  listOpen: Ref<boolean>
  settingsOpen: Ref<boolean>
  extraOpen?: Readonly<Ref<boolean>>
  autoHideChrome: () => boolean
}

export function useChromeAutoHide(options: UseChromeAutoHideOptions) {
  const { listOpen, settingsOpen, extraOpen, autoHideChrome } = options
  const anyPanelOpen = () => listOpen.value || settingsOpen.value || extraOpen?.value === true

  const chromeHidden = ref(false)
  let chromeIdleTimer = 0

  function scheduleChromeHide() {
    window.clearTimeout(chromeIdleTimer)
    if (!autoHideChrome() || anyPanelOpen()) {
      chromeHidden.value = false
      return
    }
    chromeIdleTimer = window.setTimeout(() => {
      if (autoHideChrome() && !anyPanelOpen()) {
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
    if (autoHideChrome() && !anyPanelOpen()) {
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
