import { ref, watch, onMounted, onBeforeUnmount, nextTick, type Ref } from 'vue'
import { getFocusableEdges } from '../utils/dom'

export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  onClose?: () => void,
) {
  const triggerRef = ref<HTMLElement | null>(null)
  let pendingActivation = false
  let focusTimer = 0

  function handleTab(e: KeyboardEvent) {
    if (!containerRef.value || !active.value) return

    const { first, last } = getFocusableEdges(containerRef.value)
    if (!first || !last) return

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && active.value) {
      e.preventDefault()
      if (onClose) {
        onClose()
      }
      return
    }

    if (e.key === 'Tab') {
      handleTab(e)
    }
  }

  function focusFirstFocusable() {
    if (!containerRef.value) return false
    const { first } = getFocusableEdges(containerRef.value)
    if (first) {
      first.focus()
      return document.activeElement === first
    }
    return false
  }

  async function activateTrap() {
    triggerRef.value = document.activeElement as HTMLElement
    pendingActivation = true

    await nextTick()

    if (!pendingActivation) return

    if (focusFirstFocusable()) {
      pendingActivation = false
      return
    }

    await nextTick()
    if (pendingActivation && focusFirstFocusable()) {
      pendingActivation = false
    }
  }

  function deactivateTrap() {
    pendingActivation = false
    if (triggerRef.value && typeof triggerRef.value.focus === 'function') {
      const trigger = triggerRef.value
      focusTimer = window.setTimeout(() => {
        trigger.focus()
        focusTimer = 0
      }, 0)
    }
    triggerRef.value = null
  }

  watch(
    active,
    (isActive) => {
      if (isActive) {
        void activateTrap()
      } else {
        deactivateTrap()
      }
    },
    { immediate: true, flush: 'post' },
  )

  watch(containerRef, (container) => {
    if (!pendingActivation || !active.value) return
    if (container) {
      void nextTick().then(() => {
        if (pendingActivation && focusFirstFocusable()) {
          pendingActivation = false
        }
      })
    }
  })

  onMounted(() => {
    document.addEventListener('keydown', handleKeydown)
    if (active.value && pendingActivation) {
      void nextTick().then(() => {
        if (pendingActivation && focusFirstFocusable()) {
          pendingActivation = false
        }
      })
    }
  })

  onBeforeUnmount(() => {
    pendingActivation = false
    document.removeEventListener('keydown', handleKeydown)
    if (focusTimer) {
      window.clearTimeout(focusTimer)
      focusTimer = 0
    }
  })
}
