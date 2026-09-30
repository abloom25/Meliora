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
  isPhoneLandscape: Readonly<Ref<boolean>>
  isMobileSheet: Readonly<Ref<boolean>>
  settingsAvailable: Readonly<Ref<boolean>>
  autoHideChrome: () => boolean
  triggerHaptic: (style: HapticStyle) => void
}) {
  const {
    compactViewport,
    phoneDevice,
    isPhoneLandscape,
    isMobileSheet,
    settingsAvailable,
    triggerHaptic,
  } = options
  const listOpen = ref(false)
  const settingsOpen = ref(false)
  const panelsSoftened = ref(false)

  const { chromeHidden, scheduleChromeHide, clearChromeTimer } = useChromeAutoHide({
    listOpen,
    settingsOpen,
    autoHideChrome: options.autoHideChrome,
  })

  // 由调用页面同名的 template ref 绑定；焦点管理与拖拽共享这些节点。
  const libraryDrawerRef = useTemplateRef<HTMLElement>('libraryDrawerRef')
  const settingsDrawerRef = useTemplateRef<HTMLElement>('settingsDrawerRef')
  const libraryHandleRef = useTemplateRef<HTMLElement>('libraryHandleRef')
  const settingsHandleRef = useTemplateRef<HTMLElement>('settingsHandleRef')

  // Focus trap for drawers
  useFocusTrap(libraryDrawerRef, listOpen, closePanelsAnimated, {
    autoFocus: () => !isMobileSheet.value,
  })
  useFocusTrap(settingsDrawerRef, settingsOpen, closePanelsAnimated)

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
    if (!listOpen.value && !settingsOpen.value) return
    if (isInteractiveElement(e.target)) return
    closePanelsAnimated()
  }

  function closePanels() {
    triggerHaptic('light')
    listOpen.value = false
    settingsOpen.value = false
  }

  function closeLibraryPanel() {
    listOpen.value = false
  }

  function closeSettingsPanel() {
    settingsOpen.value = false
  }

  function closePanelsAnimated() {
    if (!usesSheetDrawer()) {
      closePanels()
      return
    }
    triggerHaptic('light')
    if (listOpen.value) {
      libraryDismissAnimated()
    }
    if (settingsOpen.value) {
      settingsDismissAnimated()
    }
  }

  function toggleLibrary() {
    triggerHaptic('light')
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

  watch([listOpen, settingsOpen], ([libraryVisible, settingsVisible]) => {
    chromeHidden.value = false
    scheduleChromeHide()
    if (libraryVisible || settingsVisible) {
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

  watch([compactViewport, phoneDevice, isPhoneLandscape], () => {
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
  }
}
