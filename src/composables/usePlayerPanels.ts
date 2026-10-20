import { computed, ref, useTemplateRef, watch, type Ref } from 'vue'
import { isInteractiveElement } from '../platform/web/dom'
import type { HapticStyle } from '../platform/web/useHaptic'
import { useChromeAutoHide } from './useChromeAutoHide'
import { useFocusTrap } from './useFocusTrap'
import { useDrawerSheet } from './useDrawerSheet'

/** 抽屉互斥、手势、焦点和控件自动隐藏统一由这里维护。 */
export function usePlayerPanels(options: {
  compactViewport: Readonly<Ref<boolean>>
  phoneDevice: Readonly<Ref<boolean>>
  isCompactLandscape: Readonly<Ref<boolean>>
  isMobileSheet: Readonly<Ref<boolean>>
  settingsAvailable: Readonly<Ref<boolean>>
  debugAvailable?: Readonly<Ref<boolean>>
  autoHideChrome: () => boolean
  triggerHaptic: (style: HapticStyle) => void
}) {
  const {
    compactViewport,
    phoneDevice,
    isCompactLandscape,
    isMobileSheet,
    settingsAvailable,
    triggerHaptic,
  } = options
  const listOpen = ref(false)
  const settingsOpen = ref(false)
  const debugOpen = ref(false)
  const debugAvailable = computed(
    () => settingsAvailable.value && options.debugAvailable?.value === true,
  )
  const panelsSoftened = ref(false)

  const { chromeHidden, scheduleChromeHide, clearChromeTimer } = useChromeAutoHide({
    listOpen,
    settingsOpen,
    extraOpen: debugOpen,
    autoHideChrome: options.autoHideChrome,
  })

  // 由调用页面同名的 template ref 绑定；焦点管理与拖拽共享这些节点。
  const libraryDrawerRef = useTemplateRef<HTMLElement>('libraryDrawerRef')
  const settingsDrawerRef = useTemplateRef<HTMLElement>('settingsDrawerRef')
  const debugDrawerRef = useTemplateRef<HTMLElement>('debugDrawerRef')
  const libraryHandleRef = useTemplateRef<HTMLElement>('libraryHandleRef')
  const settingsHandleRef = useTemplateRef<HTMLElement>('settingsHandleRef')

  // Focus trap for drawers
  useFocusTrap(libraryDrawerRef, listOpen, closePanelsAnimated, {
    // 手机横屏也不要自动聚焦搜索框,避免打开曲库就弹出键盘挤占可视区域。
    autoFocus: () => !phoneDevice.value && !isMobileSheet.value,
    // 横屏标题栏的关闭按钮排在前面,桌面打开曲库仍优先进入搜索。
    initialFocus: () =>
      libraryDrawerRef.value?.querySelector<HTMLInputElement>('input[type="search"]') ?? null,
  })
  useFocusTrap(settingsDrawerRef, settingsOpen, closePanelsAnimated)
  useFocusTrap(debugDrawerRef, debugOpen, closePanelsAnimated)

  // Pull-to-dismiss gesture (mobile sheet only)
  const usesSheetDrawer = () => isMobileSheet.value
  function getSheetHeight(el: HTMLElement | null): number {
    if (!el) return window.innerHeight
    const h = el.getBoundingClientRect().height
    return h > 0 ? h : window.innerHeight
  }
  function getSheetHalfOffset(el: HTMLElement | null): number {
    if (!el) return window.innerHeight * 0.5
    const rect = el.getBoundingClientRect()
    const visibleHeight = window.innerHeight - rect.top
    return (visibleHeight > 0 ? visibleHeight : window.innerHeight) * 0.5
  }
  const {
    detent: libraryDetent,
    dragging: libraryDragging,
    translateY: libraryTranslateY,
    resetPosition: resetLibraryDrawerPosition,
    dismissAnimated: libraryDismissAnimated,
  } = useDrawerSheet({
    containerRef: libraryDrawerRef,
    handleRef: libraryHandleRef,
    active: listOpen,
    onDismiss: closeLibraryPanel,
    sheetHeight: () => getSheetHeight(libraryDrawerRef.value),
    halfOffset: () => getSheetHalfOffset(libraryDrawerRef.value),
    enabled: usesSheetDrawer,
  })
  const {
    detent: settingsDetent,
    dragging: settingsDragging,
    translateY: settingsTranslateY,
    resetPosition: resetSettingsDrawerPosition,
    dismissAnimated: settingsDismissAnimated,
  } = useDrawerSheet({
    containerRef: settingsDrawerRef,
    handleRef: settingsHandleRef,
    active: settingsOpen,
    onDismiss: closeSettingsPanel,
    sheetHeight: () => getSheetHeight(settingsDrawerRef.value),
    halfOffset: () => getSheetHalfOffset(settingsDrawerRef.value),
    enabled: usesSheetDrawer,
  })
  const libraryDrawerStyle = computed(() => {
    if (!usesSheetDrawer()) return {}
    return {
      transform: `translateY(${libraryTranslateY.value}px)`,
      transition: libraryDragging.value ? 'none' : undefined,
    }
  })
  const settingsDrawerStyle = computed(() => {
    if (!usesSheetDrawer()) return {}
    return {
      transform: `translateY(${settingsTranslateY.value}px)`,
      transition: settingsDragging.value ? 'none' : undefined,
    }
  })
  const anyDrawerHalf = computed(
    () => libraryDetent.value === 'half' || settingsDetent.value === 'half',
  )

  function resetDrawerPositions() {
    resetLibraryDrawerPosition(listOpen.value ? 'full' : 'closed')
    resetSettingsDrawerPosition(settingsOpen.value ? 'full' : 'closed')
  }

  function onTopbarClick(e: MouseEvent) {
    if (!listOpen.value && !settingsOpen.value && !debugOpen.value) return
    if (isInteractiveElement(e.target)) return
    closePanelsAnimated()
  }

  function closePanels() {
    triggerHaptic('light')
    listOpen.value = false
    settingsOpen.value = false
    closeDebugPanel()
  }

  function closeLibraryPanel() {
    listOpen.value = false
  }

  function closeSettingsPanel() {
    settingsOpen.value = false
  }

  function closeDebugPanel() {
    debugOpen.value = false
  }

  function toggleDebug() {
    if (!debugAvailable.value) return
    triggerHaptic('light')
    if (debugOpen.value) {
      closeDebugPanel()
      return
    }
    // 调试始终使用侧边抽屉，立即交接焦点，不等待手机底部抽屉的退出动画。
    listOpen.value = false
    settingsOpen.value = false
    resetDrawerPositions()
    debugOpen.value = true
  }

  function closePanelsAnimated() {
    if (!usesSheetDrawer()) {
      closePanels()
      return
    }
    triggerHaptic('light')
    closeDebugPanel()
    if (listOpen.value) {
      libraryDismissAnimated()
    }
    if (settingsOpen.value) {
      settingsDismissAnimated()
    }
  }

  function toggleLibrary() {
    triggerHaptic('light')
    closeDebugPanel()
    if (listOpen.value) {
      // Closing the currently-open library
      if (usesSheetDrawer()) {
        libraryDismissAnimated()
      } else {
        listOpen.value = false
      }
      return
    }
    listOpen.value = true
    if (settingsOpen.value) {
      if (usesSheetDrawer()) {
        settingsDismissAnimated()
      } else {
        settingsOpen.value = false
      }
    }
  }

  function toggleSettings() {
    if (!settingsAvailable.value) return
    triggerHaptic('light')
    closeDebugPanel()
    if (settingsOpen.value) {
      if (usesSheetDrawer()) {
        settingsDismissAnimated()
      } else {
        settingsOpen.value = false
      }
      return
    }
    settingsOpen.value = true
    if (listOpen.value) {
      if (usesSheetDrawer()) {
        libraryDismissAnimated()
      } else {
        listOpen.value = false
      }
    }
  }

  watch([listOpen, settingsOpen, debugOpen], ([libraryVisible, settingsVisible, debugVisible]) => {
    chromeHidden.value = false
    scheduleChromeHide()
    if (libraryVisible || settingsVisible || debugVisible) {
      panelsSoftened.value = true
      return
    }

    panelsSoftened.value = false
  })
  watch(settingsAvailable, (available) => {
    if (!available && settingsOpen.value) {
      settingsOpen.value = false
    }
  })
  watch(debugAvailable, (available) => {
    if (!available) closeDebugPanel()
  })

  watch([compactViewport, phoneDevice, isCompactLandscape], () => {
    resetDrawerPositions()
  })

  watch(options.autoHideChrome, (enabled) => {
    chromeHidden.value = false
    if (enabled) scheduleChromeHide()
    else clearChromeTimer()
  })

  return {
    listOpen,
    settingsOpen,
    debugOpen,
    panelsSoftened,
    chromeHidden,
    libraryDrawerStyle,
    settingsDrawerStyle,
    libraryDragging,
    settingsDragging,
    anyDrawerHalf,
    onTopbarClick,
    closePanelsAnimated,
    toggleLibrary,
    toggleSettings,
    toggleDebug,
    closeDebugPanel,
  }
}
