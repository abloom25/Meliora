import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { listenMediaQuery } from '../utils/media-query'

export type PlayerViewportMode = 'desktop' | 'mobile-sheet' | 'phone-landscape'

export function useDeviceDetection() {
  const compactViewport = ref(false)
  const portableDevice = ref(false)
  const phoneDevice = ref(false)
  const lyricsWindowSupported = ref(true)
  const landscapeViewport = ref(false)
  const viewportHeight = ref(0)
  const viewportTop = ref(0)

  let compactViewportQuery: MediaQueryList | undefined
  let stopCompactViewportListener: (() => void) | null = null
  let landscapeQuery: MediaQueryList | undefined
  let stopLandscapeListener: (() => void) | null = null
  let viewportFrame = 0
  let visualViewport: VisualViewport | null = null
  const isPhoneLandscape = computed(() => phoneDevice.value && landscapeViewport.value)

  function supportsDesktopLyricsWindow() {
    const userAgent = navigator.userAgent.toLowerCase()
    const mobileAgent = /android|iphone|ipad|ipod|mobile|tablet|kindle|silk/.test(userAgent)
    const touchMacTablet = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
    const coarseTouchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches
    return !(mobileAgent || touchMacTablet || coarseTouchOnly)
  }

  const viewportMode = computed<PlayerViewportMode>(() => {
    if (isPhoneLandscape.value) return 'phone-landscape'
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

  function updateLandscape(event: MediaQueryListEvent | MediaQueryList): void {
    landscapeViewport.value = event.matches
  }

  function updateViewport(): void {
    viewportFrame = 0
    // 键盘/地址栏只改变可视区域,不以它们缩小后的尺寸判断横竖屏。
    viewportHeight.value = Math.round(visualViewport?.height ?? window.innerHeight)
    viewportTop.value = Math.round(visualViewport?.offsetTop ?? 0)
  }

  function scheduleViewportUpdate(): void {
    if (!viewportFrame) viewportFrame = window.requestAnimationFrame(updateViewport)
  }

  onMounted(() => {
    compactViewportQuery = window.matchMedia('(max-width: 720px)')
    landscapeQuery = window.matchMedia('(orientation: landscape) and (max-height: 600px)')
    lyricsWindowSupported.value = supportsDesktopLyricsWindow()
    updateCompactViewport(compactViewportQuery)
    updateLandscape(landscapeQuery)
    updateDeviceKind()
    stopCompactViewportListener = listenMediaQuery(compactViewportQuery, updateCompactViewport)
    stopLandscapeListener = listenMediaQuery(landscapeQuery, updateLandscape)
    window.addEventListener('resize', updateDeviceKind)
    window.addEventListener('resize', scheduleViewportUpdate, { passive: true })
    visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', scheduleViewportUpdate, { passive: true })
    visualViewport?.addEventListener('scroll', scheduleViewportUpdate, { passive: true })
    updateViewport()
  })

  onBeforeUnmount(() => {
    stopCompactViewportListener?.()
    stopCompactViewportListener = null
    stopLandscapeListener?.()
    stopLandscapeListener = null
    window.removeEventListener('resize', updateDeviceKind)
    window.removeEventListener('resize', scheduleViewportUpdate)
    visualViewport?.removeEventListener('resize', scheduleViewportUpdate)
    visualViewport?.removeEventListener('scroll', scheduleViewportUpdate)
    if (viewportFrame) window.cancelAnimationFrame(viewportFrame)
  })

  return {
    compactViewport,
    portableDevice,
    phoneDevice,
    lyricsWindowSupported,
    viewportMode,
    isMobileSheet,
    isPhoneLandscape,
    viewportHeight,
    viewportTop,
  }
}
