import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { isReducedMotion, onReducedMotionChange } from './reduced-motion'

export interface PlayerLayoutMotionTarget {
  key: string
  element: HTMLElement | null
  /** 仅封面等非文字内容适合缩放；歌词/文字容器只平移，保留真实字体尺寸。 */
  scale?: boolean
  /** 抽屉等独立定位的容器调整真实尺寸，不缩放文字；优先于 scale。 */
  resize?: boolean
  /** 已存在但被布局隐藏的内容恢复时淡入，不接管首次挂载的进入动画。 */
  reveal?: boolean
}

interface PlayerLayoutMotionOptions {
  layoutKey: () => unknown
  getTargets: () => readonly PlayerLayoutMotionTarget[]
}

interface LayoutSnapshot {
  element: HTMLElement
  left: number
  top: number
  width: number
  height: number
  visible: boolean
  scale: boolean
  resize: boolean
  reveal: boolean
  opacity: number
  layoutLeft: number
  layoutTop: number
  borderBox: boolean
  edges: Record<BoxEdgeProperty, number>
}

interface RunningLayoutMotion {
  animation: Animation
  resize: boolean
}

const BOX_EDGE_PROPERTIES = [
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'borderLeftWidth',
  'borderRightWidth',
  'borderTopWidth',
  'borderBottomWidth',
] as const

type BoxEdgeProperty = (typeof BOX_EDGE_PROPERTIES)[number]

function readPixels(value: string, fallback = 0): number {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getCssSize(snapshot: LayoutSnapshot, borderBox: boolean): [number, number] {
  const horizontalEdges =
    snapshot.edges.paddingLeft +
    snapshot.edges.paddingRight +
    snapshot.edges.borderLeftWidth +
    snapshot.edges.borderRightWidth
  const verticalEdges =
    snapshot.edges.paddingTop +
    snapshot.edges.paddingBottom +
    snapshot.edges.borderTopWidth +
    snapshot.edges.borderBottomWidth
  return [
    Math.max(0, snapshot.width - (borderBox ? 0 : horizontalEdges)),
    Math.max(0, snapshot.height - (borderBox ? 0 : verticalEdges)),
  ]
}

/**
 * 只监听离散布局切换。使用外壳的独立 translate/scale 属性，不接管歌词行或 CSS transform。
 * 视口持续缩放时只更新快照；改变排列方式时才从旧视觉位置过渡到新布局。
 */
export function usePlayerLayoutMotion(options: PlayerLayoutMotionOptions): void {
  let ready = false
  let disposed = false
  let pendingLayout = false
  let refreshFrame = 0
  let observer: ResizeObserver | null = null
  let visualViewport: VisualViewport | null = null
  let stopReducedMotion: (() => void) | null = null
  let snapshots = new Map<string, LayoutSnapshot>()
  let beforeLayout = new Map<string, LayoutSnapshot>()
  const running = new Map<string, RunningLayoutMotion>()
  const interruptedByViewport = new Set<Animation>()
  const observed = new Set<HTMLElement>()

  function readTargets(): Map<string, LayoutSnapshot> {
    const result = new Map<string, LayoutSnapshot>()
    for (const target of options.getTargets()) {
      const element = target.element
      if (!element?.isConnected) continue
      const rect = element.getBoundingClientRect()
      const style = window.getComputedStyle(element)
      const opacity = readPixels(style.opacity, 1)
      const edges = {} as Record<BoxEdgeProperty, number>
      for (const property of BOX_EDGE_PROPERTIES) edges[property] = readPixels(style[property])
      result.set(target.key, {
        element,
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          opacity > 0,
        scale: !target.resize && (target.scale ?? false),
        resize: target.resize ?? false,
        reveal: target.reveal ?? false,
        opacity,
        layoutLeft: readPixels(style.left, element.offsetLeft),
        layoutTop: readPixels(style.top, element.offsetTop),
        borderBox: style.boxSizing === 'border-box',
        edges,
      })
    }
    return result
  }

  function syncObserved(targets: Map<string, LayoutSnapshot>): void {
    const current = new Set([...targets.values()].map((target) => target.element))
    for (const element of observed) {
      if (current.has(element)) continue
      observer?.unobserve(element)
      element.removeEventListener('transitionend', onTargetTransitionEnd)
      observed.delete(element)
    }
    for (const element of current) {
      if (observed.has(element)) continue
      observer?.observe(element)
      element.addEventListener('transitionend', onTargetTransitionEnd)
      observed.add(element)
    }
  }

  function refreshSnapshots(): void {
    refreshFrame = 0
    if (!ready || disposed || pendingLayout) return
    // 连续调整视口且模式不变时，固定尺寸不能继续沿用旧终点。
    // ResizeObserver 的动画自身回调不会进入这里的撤销集合。
    for (const [key, motion] of running) {
      if (!interruptedByViewport.has(motion.animation)) continue
      motion.animation.onfinish = null
      motion.animation.oncancel = null
      motion.animation.cancel()
      running.delete(key)
    }
    interruptedByViewport.clear()
    const current = readTargets()
    syncObserved(current)
    for (const [key, snapshot] of current) {
      // 动画中的 bounding rect 含临时位移，不能把它当成下一次布局的静态位置。
      if (!running.has(key)) snapshots.set(key, snapshot)
    }
    for (const key of snapshots.keys()) {
      if (!current.has(key)) snapshots.delete(key)
    }
  }

  function scheduleRefresh(): void {
    if (!refreshFrame && !disposed) refreshFrame = window.requestAnimationFrame(refreshSnapshots)
  }

  function onTargetTransitionEnd(event: Event): void {
    if (event.target === event.currentTarget) scheduleRefresh()
  }

  function onViewportChange(): void {
    for (const motion of running.values()) {
      if (motion.resize) interruptedByViewport.add(motion.animation)
    }
    scheduleRefresh()
  }

  function cancelAnimations(): void {
    for (const { animation } of running.values()) {
      animation.onfinish = null
      animation.oncancel = null
      animation.cancel()
    }
    running.clear()
    interruptedByViewport.clear()
  }

  function captureBeforeLayout(): void {
    if (!ready || disposed) return
    pendingLayout = true
    if (refreshFrame) window.cancelAnimationFrame(refreshFrame)
    refreshFrame = 0
    const current = readTargets()
    beforeLayout = new Map()
    for (const [key, snapshot] of current) {
      const previous = snapshots.get(key)
      // 首次挂载或换歌替换的节点由组件自己的进入动画负责。
      if (previous?.element !== snapshot.element) continue
      // CSS media query 可能已经随 resize 生效。保留上次稳定位置；打断动画时则取屏幕当前位置。
      const usePrevious = !running.has(key) && (previous.visible || snapshot.reveal)
      beforeLayout.set(key, usePrevious ? previous : snapshot)
    }
    cancelAnimations()
  }

  function animateAfterLayout(): void {
    if (!ready || disposed || !pendingLayout) return
    pendingLayout = false
    const current = readTargets()
    syncObserved(current)
    snapshots = current
    if (isReducedMotion()) {
      beforeLayout.clear()
      return
    }

    for (const [key, target] of current) {
      const previous = beforeLayout.get(key)
      if (
        !previous ||
        !target.visible ||
        previous.element !== target.element ||
        typeof target.element.animate !== 'function'
      ) {
        continue
      }
      const revealed = target.reveal && !previous.visible
      if (!previous.visible && !revealed) continue
      const x = revealed ? 0 : previous.left - target.left
      const y = revealed ? 0 : previous.top - target.top
      const scaleX = target.scale && !revealed ? previous.width / target.width : 1
      const scaleY = target.scale && !revealed ? previous.height / target.height : 1
      const moved = Math.abs(x) >= 0.5 || Math.abs(y) >= 0.5
      const resized =
        target.resize && !revealed
          ? Math.abs(previous.width - target.width) >= 0.5 ||
            Math.abs(previous.height - target.height) >= 0.5 ||
            BOX_EDGE_PROPERTIES.some(
              (property) => Math.abs(previous.edges[property] - target.edges[property]) >= 0.5,
            )
          : Math.abs(scaleX - 1) >= 0.002 || Math.abs(scaleY - 1) >= 0.002
      const opacityChanged =
        target.reveal && (revealed || Math.abs(previous.opacity - target.opacity) >= 0.002)
      if (!moved && !resized && !opacityChanged) continue

      // 隐藏时的零尺寸不能参与 FLIP，恢复内容只在新布局中淡入。
      const from: Keyframe = revealed ? {} : { translate: `${x}px ${y}px` }
      const to: Keyframe = revealed ? {} : { translate: '0px 0px' }
      if (opacityChanged) {
        from.opacity = revealed ? 0 : previous.opacity
        to.opacity = target.opacity
      }
      if (target.resize && !revealed) {
        const [previousWidth, previousHeight] = getCssSize(previous, target.borderBox)
        const [width, height] = getCssSize(target, target.borderBox)
        from.width = `${previousWidth}px`
        from.height = `${previousHeight}px`
        to.width = `${width}px`
        to.height = `${height}px`
        // 固定布局坐标，防止 right/bottom 锚定的抽屉在尺寸插值时额外移动。
        // 不覆盖 transform，保留 sheet 的拖动位置和已有进出场动画。
        from.left = to.left = `${target.layoutLeft}px`
        from.top = to.top = `${target.layoutTop}px`
        from.right = to.right = 'auto'
        from.bottom = to.bottom = 'auto'
        // 手机 sheet 底部有延长区；一起过渡内边距，避免它立即把旧外框撑大。
        for (const property of BOX_EDGE_PROPERTIES) {
          from[property] = `${previous.edges[property]}px`
          to[property] = `${target.edges[property]}px`
        }
      } else if (target.scale && !revealed) {
        from.scale = `${scaleX} ${scaleY}`
        to.scale = '1 1'
        from.transformOrigin = to.transformOrigin = '0 0'
      }
      const animation = target.element.animate([from, to], {
        duration: moved || resized ? 380 : 280,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'both',
      })
      running.set(key, { animation, resize: target.resize })
      const finish = () => {
        if (running.get(key)?.animation !== animation) return
        running.delete(key)
        animation.onfinish = null
        animation.oncancel = null
        animation.cancel()
        scheduleRefresh()
      }
      animation.onfinish = finish
      animation.oncancel = finish
    }
    beforeLayout.clear()
  }

  watch(options.layoutKey, captureBeforeLayout, { flush: 'pre' })
  watch(options.layoutKey, animateAfterLayout, { flush: 'post' })

  onMounted(() => {
    if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(scheduleRefresh)
    window.addEventListener('resize', onViewportChange, { passive: true })
    visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', onViewportChange, { passive: true })
    visualViewport?.addEventListener('scroll', onViewportChange, { passive: true })
    stopReducedMotion = onReducedMotionChange((reduced) => {
      if (!reduced) return
      cancelAnimations()
      beforeLayout.clear()
      pendingLayout = false
      scheduleRefresh()
    })
    // 设备检测会在 onMounted 更新模式；首屏先落到正确布局，不播放一次无意义的进入动画。
    void nextTick(() => {
      if (disposed) return
      ready = true
      refreshSnapshots()
    })
  })

  onBeforeUnmount(() => {
    disposed = true
    ready = false
    cancelAnimations()
    if (refreshFrame) window.cancelAnimationFrame(refreshFrame)
    observer?.disconnect()
    for (const element of observed) {
      element.removeEventListener('transitionend', onTargetTransitionEnd)
    }
    observed.clear()
    stopReducedMotion?.()
    window.removeEventListener('resize', onViewportChange)
    visualViewport?.removeEventListener('resize', onViewportChange)
    visualViewport?.removeEventListener('scroll', onViewportChange)
    snapshots.clear()
    beforeLayout.clear()
  })
}
