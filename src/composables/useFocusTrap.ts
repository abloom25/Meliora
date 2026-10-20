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
import { getFocusableEdges } from '../platform/web/dom'

// 模块级 trap 栈:多个 trap 同时 active 时(如叠层抽屉/弹窗),
// 只有最后激活的栈顶 trap 响应 Escape 与 Tab,避免一次按键触发所有 onClose。
const trapStack: { id: symbol; container: Ref<HTMLElement | null> }[] = []

export function useFocusTrap(
  containerRef: Ref<HTMLElement | null>,
  active: Ref<boolean>,
  onClose?: () => void,
  options?: {
    autoFocus?: MaybeRefOrGetter<boolean>
    initialFocus?: () => HTMLElement | null
  },
) {
  const triggerRef = ref<HTMLElement | null>(null)
  const trapId = Symbol('focus-trap')
  let pendingActivation = false
  let focusTimer = 0

  function isTopTrap(): boolean {
    return trapStack[trapStack.length - 1]?.id === trapId
  }

  function pushTrap() {
    const index = trapStack.findIndex((entry) => entry.id === trapId)
    if (index >= 0) trapStack.splice(index, 1)
    trapStack.push({ id: trapId, container: containerRef })
  }

  function removeTrap() {
    const index = trapStack.findIndex((entry) => entry.id === trapId)
    if (index >= 0) trapStack.splice(index, 1)
  }

  function handleTab(e: KeyboardEvent) {
    if (!containerRef.value || !active.value) return

    const { first, last } = getFocusableEdges(containerRef.value)
    if (!first || !last) {
      e.preventDefault()
      containerRef.value.focus()
      return
    }

    const activeElement = document.activeElement
    if (
      !activeElement ||
      activeElement === containerRef.value ||
      !containerRef.value.contains(activeElement)
    ) {
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

  function focusInitialElement() {
    if (!containerRef.value) return false
    const preferred = options?.initialFocus?.()
    if (preferred && containerRef.value.contains(preferred)) {
      preferred.focus()
      if (document.activeElement === preferred) return true
    }
    const { first } = getFocusableEdges(containerRef.value)
    if (first) {
      first.focus()
      return document.activeElement === first
    }
    if (containerRef.value.hasAttribute('tabindex')) {
      containerRef.value.focus()
      return document.activeElement === containerRef.value
    }
    return false
  }

  async function activateTrap() {
    pendingActivation = true

    await nextTick()

    if (!pendingActivation) return

    if (focusInitialElement()) {
      pendingActivation = false
      return
    }

    await nextTick()
    if (pendingActivation && focusInitialElement()) {
      pendingActivation = false
    }
  }

  function deactivateTrap() {
    pendingActivation = false
    if (triggerRef.value && typeof triggerRef.value.focus === 'function') {
      const trigger = triggerRef.value
      focusTimer = window.setTimeout(() => {
        // 切换抽屉时，新抽屉已经接管焦点；嵌套弹层关闭仍可回到下层抽屉内部。
        const currentTrap = trapStack[trapStack.length - 1]
        if (
          trigger.isConnected &&
          (!currentTrap || currentTrap.container.value?.contains(trigger))
        ) {
          trigger.focus()
        }
        focusTimer = 0
      }, 0)
    }
    triggerRef.value = null
  }

  watch(
    active,
    (isActive) => {
      if (isActive) {
        // 关闭时恢复焦点与是否自动入焦无关；触屏抽屉仍可在打开后通过 Tab 进入。
        triggerRef.value = document.activeElement as HTMLElement
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
        if (pendingActivation && focusInitialElement()) {
          pendingActivation = false
        }
      })
    }
  })

  onMounted(() => {
    document.addEventListener('keydown', handleKeydown)
    if (active.value && pendingActivation) {
      void nextTick().then(() => {
        if (pendingActivation && focusInitialElement()) {
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
