import { ref, computed, watch, onBeforeUnmount, type Ref } from 'vue'
import { isEditableElement } from '../utils/dom'

export type DrawerDetent = 'full' | 'half' | 'closed'

interface DrawerSheetOptions {
  containerRef: Ref<HTMLElement | null>
  handleRef?: Ref<HTMLElement | null>
  active: Ref<boolean>
  onDismiss: () => void
  /** Sheet height in CSS pixels at the "full" detent. Used to compute half / closed offsets. */
  sheetHeight: () => number
  /** Half-detent target offset (CSS pixels from full position). Default = sheetHeight * 0.5. */
  halfOffset?: () => number
  /** Velocity threshold (px/ms). */
  velocityThreshold?: number
  /** Whether container-level (anywhere) drag is allowed. */
  enabled?: () => boolean
}

interface DragState {
  pointerId: number
  startY: number
  startX: number
  startDetent: DrawerDetent
  startOffsetForDetent: number
  startTime: number
  lastY: number
  lastTime: number
  velocity: number
  decided: boolean
  dragging: boolean
  scrollEl: HTMLElement | null
  source: 'container' | 'handle'
}

const SCROLL_LOCK_SELECTOR =
  '.scrollable, [data-scrollable], input[type="range"], .range, .setting-range'

export function useDrawerSheet({
  containerRef,
  handleRef,
  active,
  onDismiss,
  sheetHeight,
  halfOffset,
  velocityThreshold = 0.55,
  enabled,
}: DrawerSheetOptions) {
  const detent = ref<DrawerDetent>('closed')
  const dragOffset = ref(0)
  const dragging = ref(false)

  let state: DragState | null = null
  let dismissTimer = 0
  let openRaf1 = 0
  let openRaf2 = 0

  function detentOffset(d: DrawerDetent) {
    if (d === 'full') return 0
    if (d === 'half') {
      return halfOffset ? halfOffset() : sheetHeight() * 0.5
    }
    return sheetHeight()
  }

  /** Snap target to the nearest detent based on offset and velocity. */
  function pickDetent(
    currentOffset: number,
    velocity: number,
    startDetent: DrawerDetent,
    gestureOffset: number,
  ): DrawerDetent {
    const half = detentOffset('half')
    const closed = detentOffset('closed')

    // iOS-style sheet behavior: a fast downward fling from fullscreen dismisses,
    // while a slower pull can still settle at the half detent.
    if (startDetent === 'full') {
      if (gestureOffset <= 36) return 'full'

      const projectedOffset = currentOffset + velocity * 360
      const quickFling = velocity >= Math.max(1.05, velocityThreshold * 1.9)
      const projectedClose =
        velocity >= Math.max(0.78, velocityThreshold * 1.35) && projectedOffset >= closed * 0.72
      if (quickFling || projectedClose) {
        return 'closed'
      }

      return 'half'
    }

    // Strong downward velocity dismisses
    if (velocity > velocityThreshold * 1.5) {
      if (currentOffset > half * 0.5) return 'closed'
      return 'half'
    }
    // Strong upward velocity opens fully
    if (velocity < -velocityThreshold) {
      return 'full'
    }
    // Snap by nearest distance
    const fullDist = Math.abs(currentOffset - 0)
    const halfDist = Math.abs(currentOffset - half)
    const closedDist = Math.abs(currentOffset - closed)
    if (fullDist <= halfDist && fullDist <= closedDist) return 'full'
    if (halfDist <= closedDist) return 'half'
    return 'closed'
  }

  function findScrollableAncestor(target: EventTarget | null, container: HTMLElement) {
    let node = target as HTMLElement | null
    while (node && node !== container) {
      if (node.closest(SCROLL_LOCK_SELECTOR)) return node
      const overflowY = window.getComputedStyle(node).overflowY
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight
      ) {
        return node
      }
      node = node.parentElement
    }
    return null
  }

  function startDrag(e: PointerEvent, source: 'container' | 'handle') {
    if (!active.value) return
    if (!containerRef.value) return
    if (isEditableElement(e.target)) return

    const now = performance.now()
    const baseState = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startX: e.clientX,
      startDetent: detent.value,
      startOffsetForDetent: detentOffset(detent.value),
      startTime: now,
      lastY: e.clientY,
      lastTime: now,
      velocity: 0,
      decided: false,
      dragging: false,
      scrollEl: null as HTMLElement | null,
      source,
    }

    if (source === 'container') {
      if (enabled && !enabled()) return
      if (e.pointerType === 'mouse') return
      const scrollEl = findScrollableAncestor(e.target, containerRef.value)
      // If user is scrolling content and not at the top, do not capture
      if (scrollEl && scrollEl.scrollTop > 0) return
      // Half-detent: full content area can also drive the sheet
      state = { ...baseState, scrollEl }
      return
    }

    state = { ...baseState, decided: true, dragging: true }
    dragging.value = true
    if (handleRef?.value && typeof handleRef.value.setPointerCapture === 'function') {
      try {
        handleRef.value.setPointerCapture(e.pointerId)
      } catch {
        /* noop */
      }
    }
    e.preventDefault()
  }

  function handleContainerPointerDown(e: PointerEvent) {
    startDrag(e, 'container')
  }
  function handleHandlePointerDown(e: PointerEvent) {
    startDrag(e, 'handle')
  }

  function handlePointerMove(e: PointerEvent) {
    if (!state || e.pointerId !== state.pointerId) return
    // handle 发起的拖拽不需要 container 的 move 事件再处理一次
    if (state.source === 'handle' && e.currentTarget === attachedContainer) return
    const dy = e.clientY - state.startY
    const dx = e.clientX - state.startX
    const now = performance.now()
    const dt = now - state.lastTime
    if (dt > 0) {
      state.velocity = (e.clientY - state.lastY) / dt
    }
    state.lastY = e.clientY
    state.lastTime = now

    if (!state.decided) {
      if (Math.abs(dy) < 6 && Math.abs(dx) < 6) return
      if (Math.abs(dy) <= Math.abs(dx)) {
        state = null
        return
      }
      state.decided = true
      state.dragging = true
      dragging.value = true
    }

    if (state.dragging) {
      if (e.cancelable) e.preventDefault()
      // Allowed range: [0 (full), sheetHeight (closed)]
      const max = sheetHeight()
      const proposed = state.startOffsetForDetent + dy
      // Light rubber band when going above full
      let next = proposed
      if (next < 0) {
        next = next * 0.35
      } else if (next > max) {
        next = max + (next - max) * 0.35
      }
      dragOffset.value = next - detentOffset(detent.value)
    }
  }

  function dismissAnimated() {
    dragging.value = false
    state = null
    const previous = detent.value
    if (previous === 'closed') {
      onDismiss()
      return
    }
    detent.value = 'closed'
    dragOffset.value = 0
    const wait = previous === 'full' ? 360 : 280
    dismissTimer = window.setTimeout(() => {
      onDismiss()
      dismissTimer = 0
    }, wait)
  }

  function settleTo(target: DrawerDetent) {
    dragging.value = false
    state = null

    if (target === 'closed') {
      dismissAnimated()
      return
    }

    if (target !== detent.value) {
      detent.value = target
    }
    dragOffset.value = 0
  }

  function handlePointerUp(e: PointerEvent) {
    if (!state || e.pointerId !== state.pointerId) return
    if (!state.dragging) {
      state = null
      return
    }
    const startOffset = state.startOffsetForDetent
    const currentOffset = startOffset + dragOffset.value
    const elapsed = Math.max(1, performance.now() - state.startTime)
    const gestureOffset = Math.max(0, currentOffset - startOffset)
    const averageVelocity = gestureOffset / elapsed
    const velocity = Math.max(state.velocity, averageVelocity)
    const target = pickDetent(currentOffset, velocity, state.startDetent, gestureOffset)
    settleTo(target)
  }

  function handlePointerCancel(e: PointerEvent) {
    if (!state || e.pointerId !== state.pointerId) return
    state = null
    dragging.value = false
    dragOffset.value = 0
  }

  let attachedContainer: HTMLElement | null = null
  let attachedHandle: HTMLElement | null = null

  function attachContainer(el: HTMLElement) {
    el.addEventListener('pointerdown', handleContainerPointerDown, { passive: true })
    el.addEventListener('pointermove', handlePointerMove, { passive: false })
    el.addEventListener('pointerup', handlePointerUp, { passive: true })
    el.addEventListener('pointercancel', handlePointerCancel, { passive: true })
    attachedContainer = el
  }
  function detachContainer() {
    if (!attachedContainer) return
    attachedContainer.removeEventListener('pointerdown', handleContainerPointerDown)
    attachedContainer.removeEventListener('pointermove', handlePointerMove)
    attachedContainer.removeEventListener('pointerup', handlePointerUp)
    attachedContainer.removeEventListener('pointercancel', handlePointerCancel)
    attachedContainer = null
  }
  function attachHandle(el: HTMLElement) {
    el.addEventListener('pointerdown', handleHandlePointerDown, { passive: false })
    el.addEventListener('pointermove', handlePointerMove, { passive: false })
    el.addEventListener('pointerup', handlePointerUp, { passive: true })
    el.addEventListener('pointercancel', handlePointerCancel, { passive: true })
    attachedHandle = el
  }
  function detachHandle() {
    if (!attachedHandle) return
    attachedHandle.removeEventListener('pointerdown', handleHandlePointerDown)
    attachedHandle.removeEventListener('pointermove', handlePointerMove)
    attachedHandle.removeEventListener('pointerup', handlePointerUp)
    attachedHandle.removeEventListener('pointercancel', handlePointerCancel)
    attachedHandle = null
  }

  watch(
    () => containerRef.value,
    (el) => {
      detachContainer()
      if (el) attachContainer(el)
    },
  )
  if (handleRef) {
    watch(
      () => handleRef.value,
      (el) => {
        detachHandle()
        if (el) attachHandle(el)
      },
    )
  }

  watch(
    active,
    (isActive) => {
      if (isActive) {
        // Start from closed (off-screen) so the transform transition animates the slide-in
        detent.value = 'closed'
        dragOffset.value = 0
        // Then snap to full on the next frame
        openRaf1 = requestAnimationFrame(() => {
          openRaf1 = 0
          openRaf2 = requestAnimationFrame(() => {
            openRaf2 = 0
            if (active.value) {
              detent.value = 'full'
            }
          })
        })
      } else {
        detent.value = 'closed'
        dragOffset.value = 0
        state = null
        dragging.value = false
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    detachContainer()
    detachHandle()
    state = null
    if (dismissTimer) {
      window.clearTimeout(dismissTimer)
      dismissTimer = 0
    }
    if (openRaf1) {
      window.cancelAnimationFrame(openRaf1)
      openRaf1 = 0
    }
    if (openRaf2) {
      window.cancelAnimationFrame(openRaf2)
      openRaf2 = 0
    }
  })

  /** Total Y translation (px) from the fully-open position. */
  const translateY = computed(() => detentOffset(detent.value) + dragOffset.value)

  function snapTo(target: DrawerDetent) {
    if (target === 'closed') {
      onDismiss()
      return
    }
    detent.value = target
    dragOffset.value = 0
  }

  function resetPosition(target: DrawerDetent = active.value ? 'full' : 'closed') {
    state = null
    dragging.value = false
    detent.value = target
    dragOffset.value = 0
  }

  return {
    detent,
    dragging,
    translateY,
    snapTo,
    resetPosition,
    dismissAnimated,
  }
}
