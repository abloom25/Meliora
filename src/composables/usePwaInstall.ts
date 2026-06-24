import { onBeforeUnmount, onMounted, ref } from 'vue'
import { canShowIosInstallGuide } from '../utils/browser'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

const DISPLAY_MODE_QUERY =
  '(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)'

function detectInstalled(): boolean {
  if (window.matchMedia(DISPLAY_MODE_QUERY).matches) return true
  const nav = navigator as unknown as { standalone?: boolean }
  return nav.standalone === true
}

export function usePwaInstall() {
  const canInstall = ref(false)
  const isInstalled = ref(detectInstalled())
  // iOS Safari 不支持 beforeinstallprompt,需要引导用户通过分享菜单"添加到主屏幕"
  const iosInstallAvailable = ref(canShowIosInstallGuide())
  let deferredPrompt: BeforeInstallPromptEvent | null = null
  let mql: MediaQueryList | null = null

  function handleInstallPrompt(event: Event) {
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    canInstall.value = true
  }

  function handleInstalled() {
    deferredPrompt = null
    canInstall.value = false
    isInstalled.value = true
    iosInstallAvailable.value = false
  }

  function handleDisplayModeChange() {
    isInstalled.value = detectInstalled()
    if (isInstalled.value) {
      iosInstallAvailable.value = false
    }
  }

  async function install() {
    if (!deferredPrompt) return false
    const prompt = deferredPrompt
    try {
      await prompt.prompt()
      const choice = await prompt.userChoice
      return choice.outcome === 'accepted'
    } catch {
      return false
    } finally {
      deferredPrompt = null
      canInstall.value = false
    }
  }

  onMounted(() => {
    mql = window.matchMedia(DISPLAY_MODE_QUERY)
    mql.addEventListener('change', handleDisplayModeChange)
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
  })
  onBeforeUnmount(() => {
    mql?.removeEventListener('change', handleDisplayModeChange)
    window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
    window.removeEventListener('appinstalled', handleInstalled)
  })

  return { canInstall, isInstalled, install, iosInstallAvailable }
}
