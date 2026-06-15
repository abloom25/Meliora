import { onBeforeUnmount, onMounted, ref } from 'vue'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

export function usePwaInstall() {
  const canInstall = ref(false)
  const isInstalled = ref(window.matchMedia('(display-mode: standalone)').matches)
  let deferredPrompt: BeforeInstallPromptEvent | null = null

  function handleInstallPrompt(event: Event) {
    event.preventDefault()
    deferredPrompt = event as BeforeInstallPromptEvent
    canInstall.value = true
  }

  function handleInstalled() {
    deferredPrompt = null
    canInstall.value = false
    isInstalled.value = true
  }

  async function install() {
    if (!deferredPrompt) return false
    await deferredPrompt.prompt()
    const choice = await deferredPrompt.userChoice
    if (choice.outcome === 'accepted') {
      deferredPrompt = null
      canInstall.value = false
    }
    return choice.outcome === 'accepted'
  }

  onMounted(() => {
    window.addEventListener('beforeinstallprompt', handleInstallPrompt)
    window.addEventListener('appinstalled', handleInstalled)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('beforeinstallprompt', handleInstallPrompt)
    window.removeEventListener('appinstalled', handleInstalled)
  })

  return { canInstall, isInstalled, install }
}
