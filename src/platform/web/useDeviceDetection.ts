import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  calculatePlayerViewport,
  MOBILE_SHEET_MAX_WIDTH,
  type MinimalMetadataPlacement,
  type PlayerSafeAreaInsets,
} from '../../core/layout/player-viewport'
import { listenMediaQuery } from './media-query'

export type PlayerViewportMode = 'desktop' | 'mobile-sheet' | 'compact-landscape' | 'minimal-player'

export function useDeviceDetection() {
  const compactViewport = ref(false)
  const portableDevice = ref(false)
  const phoneDevice = ref(false)
  const lyricsWindowSupported = ref(true)
  const isCompactLandscape = ref(false)
  const isShortLandscape = ref(false)
  const isMinimalPlayer = ref(false)
  const minimalArtworkVisible = ref(false)
  const minimalMetadataVisible = ref(false)
  const minimalMetadataPlacement = ref<MinimalMetadataPlacement>('hidden')
  const minimalCoverSize = ref(0)
  const minimalArtworkWidth = ref(0)
  const viewportWidth = ref(0)
  const viewportHeight = ref(0)
  const viewportLeft = ref(0)
  const viewportTop = ref(0)
  const landscapeStageHeight = ref(0)
  const landscapeCoverSize = ref(48)
  const safeAreaInsets = ref<PlayerSafeAreaInsets>({ top: 0, right: 0, bottom: 0, left: 0 })

  let compactViewportQuery: MediaQueryList | undefined
  let stopCompactViewportListener: (() => void) | null = null
  let viewportFrame = 0
  let visualViewport: VisualViewport | null = null
  let safeAreaProbe: HTMLDivElement | null = null

  function supportsDesktopLyricsWindow() {
    const userAgent = navigator.userAgent.toLowerCase()
    const mobileAgent = /android|iphone|ipad|ipod|mobile|tablet|kindle|silk/.test(userAgent)
    const touchMacTablet = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
    const coarseTouchOnly = window.matchMedia('(hover: none) and (pointer: coarse)').matches
    return !(mobileAgent || touchMacTablet || coarseTouchOnly)
  }

  const viewportMode = computed<PlayerViewportMode>(() => {
    if (isMinimalPlayer.value) return 'minimal-player'
    if (isCompactLandscape.value) return 'compact-landscape'
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

  function readSafeArea(): PlayerSafeAreaInsets {
    if (!safeAreaProbe) return { top: 0, right: 0, bottom: 0, left: 0 }
    const styles = window.getComputedStyle(safeAreaProbe)
    const inset = (value: string) => Math.max(0, Number.parseFloat(value) || 0)
    return {
      top: inset(styles.paddingTop),
      right: inset(styles.paddingRight),
      bottom: inset(styles.paddingBottom),
      left: inset(styles.paddingLeft),
    }
  }

  function updateViewport(): void {
    viewportFrame = 0
    // 键盘/地址栏只改变可视区域,不以它们缩小后的尺寸判断横竖屏。
    viewportWidth.value = Math.round(visualViewport?.width ?? window.innerWidth)
    viewportHeight.value = Math.round(visualViewport?.height ?? window.innerHeight)
    viewportLeft.value = Math.round(visualViewport?.offsetLeft ?? 0)
    viewportTop.value = Math.round(visualViewport?.offsetTop ?? 0)
    const insets = readSafeArea()
    if (
      Object.entries(insets).some(
        ([edge, value]) => value !== safeAreaInsets.value[edge as keyof PlayerSafeAreaInsets],
      )
    ) {
      safeAreaInsets.value = insets
    }
    const layout = calculatePlayerViewport({
      layoutWidth: window.innerWidth,
      layoutHeight: window.innerHeight,
      viewportWidth: viewportWidth.value,
      viewportHeight: viewportHeight.value,
      safeAreaInsets: insets,
      rootFontSize:
        Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16,
    })
    isCompactLandscape.value = layout.compact
    isShortLandscape.value = layout.shortLandscape
    isMinimalPlayer.value = layout.minimalPlayer
    minimalArtworkVisible.value = layout.minimalArtworkVisible
    minimalMetadataVisible.value = layout.minimalMetadataVisible
    minimalMetadataPlacement.value = layout.minimalMetadataPlacement
    minimalCoverSize.value = layout.minimalCoverSize
    minimalArtworkWidth.value = layout.minimalArtworkWidth
    landscapeStageHeight.value = layout.landscapeStageHeight
    landscapeCoverSize.value = layout.landscapeCoverSize
    updateDeviceKind()
  }

  function scheduleViewportUpdate(): void {
    if (!viewportFrame) viewportFrame = window.requestAnimationFrame(updateViewport)
  }

  onMounted(() => {
    compactViewportQuery = window.matchMedia(`(max-width: ${MOBILE_SHEET_MAX_WIDTH}px)`)
    lyricsWindowSupported.value = supportsDesktopLyricsWindow()
    updateCompactViewport(compactViewportQuery)
    stopCompactViewportListener = listenMediaQuery(compactViewportQuery, updateCompactViewport)
    safeAreaProbe = document.createElement('div')
    safeAreaProbe.setAttribute('aria-hidden', 'true')
    safeAreaProbe.style.cssText =
      'position:fixed;inset:0 auto auto 0;width:0;height:0;visibility:hidden;pointer-events:none;' +
      'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) ' +
      'env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);'
    document.body.appendChild(safeAreaProbe)
    window.addEventListener('resize', scheduleViewportUpdate, { passive: true })
    visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', scheduleViewportUpdate, { passive: true })
    visualViewport?.addEventListener('scroll', scheduleViewportUpdate, { passive: true })
    updateViewport()
  })

  onBeforeUnmount(() => {
    stopCompactViewportListener?.()
    stopCompactViewportListener = null
    window.removeEventListener('resize', scheduleViewportUpdate)
    visualViewport?.removeEventListener('resize', scheduleViewportUpdate)
    visualViewport?.removeEventListener('scroll', scheduleViewportUpdate)
    if (viewportFrame) window.cancelAnimationFrame(viewportFrame)
    safeAreaProbe?.remove()
    safeAreaProbe = null
  })

  return {
    compactViewport,
    portableDevice,
    phoneDevice,
    lyricsWindowSupported,
    viewportMode,
    isMobileSheet,
    isCompactLandscape,
    isShortLandscape,
    isMinimalPlayer,
    minimalArtworkVisible,
    minimalMetadataVisible,
    minimalMetadataPlacement,
    minimalCoverSize,
    minimalArtworkWidth,
    viewportWidth,
    viewportHeight,
    viewportLeft,
    viewportTop,
    landscapeStageHeight,
    landscapeCoverSize,
    safeAreaInsets,
  }
}
