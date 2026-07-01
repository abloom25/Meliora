import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export type PlayerViewportMode = 'desktop' | 'mobile-sheet'

export function useDeviceDetection() {
  const compactViewport = ref(false)
  const portableDevice = ref(false)
  const phoneDevice = ref(false)
  const lyricsWindowSupported = ref(true)

  let compactViewportQuery: MediaQueryList | undefined

  function supportsDesktopLyricsWindow() {
    const userAgent = navigator.userAgent.toLowerCase()
    const mobileAgent = /android|iphone|ipad|ipod|mobile|tablet|kindle|silk/.test(userAgent)
    const touchMacTablet = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
    const coarseTouchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches
    return !(mobileAgent || touchMacTablet || coarseTouchOnly)
  }

  const viewportMode = computed<PlayerViewportMode>(() => {
    if (phoneDevice.value || compactViewport.value) return 'mobile-sheet'
    return 'desktop'
  })
  const isMobileSheet = computed(() => viewportMode.value === 'mobile-sheet')

  function updateCompactViewport(event: MediaQueryListEvent | MediaQueryList) {
    compactViewport.value = event.matches
  }

  function updateDeviceKind() {
    const userAgent = navigator.userAgent
    const platform = navigator.platform
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches
    const touchPoints = navigator.maxTouchPoints || 0
    const iPadDesktopMode = platform === 'MacIntel' && touchPoints > 1
    const phoneLike =
      /iPhone|iPod|Windows Phone/i.test(userAgent) ||
      /Android.*Mobile/i.test(userAgent) ||
      (coarsePointer &&
        touchPoints > 0 &&
        Math.min(window.screen.width, window.screen.height) <= 520)
    portableDevice.value =
      iPadDesktopMode ||
      /Android|iPhone|iPad|iPod|Mobile|Tablet|Windows Phone/i.test(userAgent) ||
      (coarsePointer && touchPoints > 0)
    phoneDevice.value = !iPadDesktopMode && phoneLike
  }

  onMounted(() => {
    compactViewportQuery = window.matchMedia('(max-width: 720px)')
    lyricsWindowSupported.value = supportsDesktopLyricsWindow()
    updateCompactViewport(compactViewportQuery)
    updateDeviceKind()
    compactViewportQuery.addEventListener('change', updateCompactViewport)
    window.addEventListener('resize', updateDeviceKind)
  })

  onBeforeUnmount(() => {
    compactViewportQuery?.removeEventListener('change', updateCompactViewport)
    window.removeEventListener('resize', updateDeviceKind)
  })

  return {
    compactViewport,
    portableDevice,
    phoneDevice,
    lyricsWindowSupported,
    viewportMode,
    isMobileSheet,
  }
}
