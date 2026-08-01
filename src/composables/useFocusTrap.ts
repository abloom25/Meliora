import {
  ref,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
  type Ref,
  type MaybeRefOrGetter,
  toValue,
} from 'vue'
import { getFocusableEdges } from '../utils/dom'

// 模块级 trap 栈:多个 trap 同时 active 时(如叠层抽屉/弹窗),
// 只有最后激活的栈顶 trap 响应 Escape 与 Tab,避免一次按键触发所有 onClose。
const trapStack: symbol[] = []

export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  onClose?: () => void,
  options?: { autoFocus?: MaybeRefOrGetter<boolean> },
) {
  const triggerRef = ref<HTMLElement | null>(null)
  const trapId = Symbol('focus-trap')
  let pendingActivation = false
  let focusTimer = 0

  function isTopTrap(): boolean {
    return trapStack[trapStack.length - 1] === trapId
  }

  function pushTrap() {
    const index = trapStack.indexOf(trapId)
    if (index >= 0) trapStack.splice(index, 1)
    trapStack.push(trapId)
  }

  function removeTrap() {
    const index = trapStack.indexOf(trapId)
    if (index >= 0) trapStack.splice(index, 1)
  }

  function handleTab(e: KeyboardEvent) {
    if (!containerRef.value || !active.value) return

    const { first, last } = getFocusableEdges(containerRef.value)
    if (!first || !last) return

    const activeElement = document.activeElement
    if (!activeElement || !containerRef.value.contains(activeElement)) {
      // focus 落在容器外(既非 first 也非 last):拉回容器,
      // 按 shift 方向决定从头部还是尾部进入
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
      return
    }

    if (e.shiftKey) {
      if (activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    } else {
      if (activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!active.value || !isTopTrap()) return

    if (e.key === 'Escape') {
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
        pushTrap()
        if (toValue(options?.autoFocus) !== false) void activateTrap()
        else pendingActivation = false
      } else {
        removeTrap()
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
    removeTrap()
    document.removeEventListener('keydown', handleKeydown)
    if (focusTimer) {
      window.clearTimeout(focusTimer)
      focusTimer = 0
    }
  })
}
