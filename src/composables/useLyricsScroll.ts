import { onBeforeUnmount, ref } from 'vue'
import {
  createSpringState,
  isSpringSettled,
  snapSpring,
  springFromDuration,
  stepSpring,
  type SpringConfig,
  type SpringState,
} from '../utils/spring'

// 歌词行的牵引滚动。
//
// 换行时容器的 scrollTop 一次性跳到目标位置,同时给每一行记一个"视觉偏移量",
// 再把偏移量拉回 0——观感上是歌词被拽过去,实际上滚动早已完成。
//
// 牵引感来自两件事,缺一不可:
//   1. **按屏幕位置依次起步**:向下滚时最上面的行先动,往下逐行延迟,拉出一道波。
//      所有行同时起步只是整片匀速平移,没有"被拽"的感觉。
//   2. **方向性滞后**:运动方向后方的行阻尼更低,中途会鼓出来一点再收回。
//
// 位移本身用弹簧而不是关键帧:关键帧被打断后新动画从 0 速度重新起步,每次换行都留下
// 一次速度突变(副歌连续换行时尤其明显);弹簧只改目标不改速度,打断处保持连续。
// 被打断时已在跟踪的行一律立刻起步:连续换行时再把它按住,它与已经就位的相邻行
// 之间的距离会持续拉大,最后交叠在一起。只有新进入窗口的行才排延迟。

export interface LyricsScrollOptions {
  getScroller: () => HTMLElement | null | undefined
  getLineElements: () => readonly (HTMLElement | null | undefined)[]
  /** 是否启用动效。false 时所有位移都瞬时完成 */
  isAnimated: () => boolean
}

export interface ScrollToIndexOptions {
  /** false 时强制瞬移,用于尺寸变化、切歌、关闭动效等不该有过渡的场景 */
  animate?: boolean
  /**
   * 距离下一次换行还剩多少毫秒。牵引波靠逐行延迟产生,而延迟会让相邻行拉开距离:
   * 起步瞬间速度可达数百 px/s,46ms 的起步差就能拉开约 40px,而行距只有 20–40px。
   * 快段落(说唱、密集副歌)必须按剩余时间压缩延迟,否则行与行会叠在一起。
   * 缺省视为时间充足,走完整的波
   */
  budgetMs?: number
}

// 参与位移动画的行范围(相对目标行)。视口外的行跟随 scrollTop 直接就位即可
const WINDOW_BEFORE = 6
const WINDOW_AFTER = 8
// 逐行起步的间隔,以及参与延迟的最大行数
const DELAY_STEP_MS = 46
const MAX_DELAY_ORDER = 8
// 剩余时间达到这个值才走完整的牵引波;不足则按比例压缩逐行延迟。
// 整道波的时间跨度是 MAX_DELAY_ORDER * DELAY_STEP_MS,预算要留出余量给弹簧本身
const FULL_WAVE_BUDGET_MS = 900
// 整道波最多占掉剩余时间的这个比例,防止下一行到来时上一道波还铺在半空
const WAVE_BUDGET_SHARE = 0.45
// 单行的弹簧停顿时长。波浪由延迟产生,各行时长基本一致
const SPRING_DURATION_SECONDS = 0.62
// 运动方向后方(被拽着走的一侧)阻尼更低,中途鼓出来一点再收回
const TRAILING_DAMPING_RATIO = 0.84
const LEADING_DAMPING_RATIO = 0.92
// 位移超过容器高度这么多倍时不做动画:seek / 切歌属于跳转而不是滚动
const SNAP_DISTANCE_RATIO = 3
// 单行视觉偏移的上限(容器高度的倍数)。连续换行时偏移会累加,
// 不封顶的话某一行可能被甩出很远,落回来时与相邻行交叠
const MAX_OFFSET_RATIO = 1.1

interface TrackedLine {
  element: HTMLElement
  state: SpringState
  config: SpringConfig
  /** 起步前的剩余等待时间(毫秒),牵引波就来自这里 */
  delayMs: number
}

export function useLyricsScroll(options: LyricsScrollOptions) {
  const isAnimating = ref(false)
  const tracked = new Map<HTMLElement, TrackedLine>()
  let frame = 0
  let lastFrameAt = 0

  function writeOffset(element: HTMLElement, value: number) {
    if (!element.isConnected) return
    // 0.05px 以下的残差对视觉没有意义,但会让合成层一直无法回收
    if (Math.abs(value) < 0.05) element.style.translate = ''
    else element.style.translate = `0 ${value.toFixed(2)}px`
  }

  function releaseAll() {
    for (const line of tracked.values()) {
      if (line.element.isConnected) line.element.style.translate = ''
    }
    tracked.clear()
  }

  function stopLoop() {
    if (frame) {
      window.cancelAnimationFrame(frame)
      frame = 0
    }
    lastFrameAt = 0
    isAnimating.value = false
  }

  function tick() {
    frame = 0
    const now = performance.now()
    const dt = lastFrameAt ? (now - lastFrameAt) / 1000 : 1 / 60
    lastFrameAt = now

    for (const [element, line] of tracked) {
      if (!element.isConnected) {
        // 行节点被 Vue 回收(切歌 / 列表重建):直接丢弃,不留悬挂引用
        tracked.delete(element)
        continue
      }
      if (line.delayMs > 0) {
        // 还没轮到这一行起步:原地停住,保持它被落在后面的样子
        line.delayMs -= dt * 1000
        writeOffset(element, line.state.value)
        continue
      }
      stepSpring(line.state, 0, line.config, dt)
      if (isSpringSettled(line.state, 0)) {
        snapSpring(line.state, 0)
        element.style.translate = ''
        tracked.delete(element)
        continue
      }
      writeOffset(element, line.state.value)
    }

    if (tracked.size === 0) {
      stopLoop()
      return
    }
    frame = window.requestAnimationFrame(tick)
  }

  function ensureLoop() {
    if (frame || tracked.size === 0) return
    isAnimating.value = true
    lastFrameAt = 0
    frame = window.requestAnimationFrame(tick)
  }

  function clampOffset(value: number, container: HTMLElement): number {
    const limit = Math.max(container.clientHeight * MAX_OFFSET_RATIO, 1)
    return Math.max(-limit, Math.min(limit, value))
  }

  function springConfigFor(trailing: boolean): SpringConfig {
    return springFromDuration(
      SPRING_DURATION_SECONDS,
      trailing ? TRAILING_DAMPING_RATIO : LEADING_DAMPING_RATIO,
    )
  }

  /** 立即结束所有位移,让每一行回到布局位置(用户接管滚动 / 关闭动效 / 卸载) */
  function cancel() {
    stopLoop()
    releaseAll()
  }

  /**
   * 把第 index 行滚到容器中央。返回 true 表示确实发生了位移。
   * 已在动画中时不会重来一遍:新的偏移量叠加到当前弹簧状态上,速度被完整保留。
   */
  function scrollToIndex(index: number, scrollOptions: ScrollToIndexOptions = {}): boolean {
    const container = options.getScroller()
    const elements = options.getLineElements()
    const target = elements[index]
    if (!container || !target || !target.isConnected) return false

    const destination = Math.max(
      0,
      Math.min(
        target.offsetTop - container.clientHeight / 2 + target.clientHeight / 2,
        container.scrollHeight - container.clientHeight,
      ),
    )
    const movement = destination - container.scrollTop
    const animated = scrollOptions.animate !== false && options.isAnimated()

    if (!animated) {
      cancel()
      container.scrollTop = destination
      return Math.abs(movement) >= 1
    }

    // 跳转距离过大(seek / 切歌)时直接就位,牵引整首歌只会是一团模糊
    if (Math.abs(movement) > container.clientHeight * SNAP_DISTANCE_RATIO) {
      cancel()
      container.scrollTop = destination
      return true
    }
    if (Math.abs(movement) < 1 && tracked.size === 0) return false

    // 剩余时间不足时压缩逐行延迟:延迟越小,相邻行的位移差越小,越不会交叠
    const budgetMs = scrollOptions.budgetMs ?? Number.POSITIVE_INFINITY
    const budgetedWaveMs = Math.min(
      MAX_DELAY_ORDER * DELAY_STEP_MS,
      Number.isFinite(budgetMs) ? Math.max(0, budgetMs) * WAVE_BUDGET_SHARE : Infinity,
    )
    const delayScale = Math.min(1, budgetedWaveMs / FULL_WAVE_BUDGET_MS)

    const from = Math.max(0, index - WINDOW_BEFORE)
    const to = Math.min(elements.length - 1, index + WINDOW_AFTER)

    // 第一遍测量拿到当前的视觉位置(进行中的 translate 已经反映在 rect 里)
    const measured: Array<{ element: HTMLElement; before: number }> = []
    for (let cursor = from; cursor <= to; cursor += 1) {
      const element = elements[cursor]
      if (!element || !element.isConnected) continue
      measured.push({ element, before: element.getBoundingClientRect().top })
    }
    if (!measured.length) return false

    container.scrollTop = destination

    // 延迟顺序按屏幕位置排,不按"离当前行多远":向下滚时最上面的行先动,
    // 波沿运动方向传下去。按距离排会让波从当前行往两边扩散,是另一种东西
    measured.sort((left, right) => left.before - right.before)

    // 第二遍测量拿到滚动后的布局位置,差值就是这一帧需要补偿的视觉位移。
    // 纯滚动不触发 reflow,两轮 rect 查询不会引入额外的强制布局
    for (const [position, item] of measured.entries()) {
      const offset = item.before - item.element.getBoundingClientRect().top
      const order = movement > 0 ? position : measured.length - 1 - position
      const delayMs = Math.min(order, MAX_DELAY_ORDER) * DELAY_STEP_MS * delayScale
      const trailing = order > measured.length / 3
      const existing = tracked.get(item.element)

      if (existing) {
        // 打断重定向:两次测量里都含有当前的 translate,差值只等于本次滚动增量,
        // 因此要把它**加到**剩余偏移上而不是覆盖。速度原样保留,运动不出现断点。
        existing.state.value = clampOffset(existing.state.value + offset, container)
        existing.config = springConfigFor(trailing)
        // 已经在跟踪的行一律立刻起步:连续换行时再把它按住,
        // 它与已经就位的相邻行之间的距离会持续拉大,最终交叠
        existing.delayMs = 0
        writeOffset(item.element, existing.state.value)
        continue
      }
      if (Math.abs(offset) < 0.5) continue
      const clamped = clampOffset(offset, container)
      tracked.set(item.element, {
        element: item.element,
        state: createSpringState(clamped, 0),
        config: springConfigFor(trailing),
        delayMs,
      })
      writeOffset(item.element, clamped)
    }

    if (tracked.size === 0) return Math.abs(movement) >= 1
    ensureLoop()
    return true
  }

  onBeforeUnmount(cancel)

  return { scrollToIndex, cancel, isAnimating }
}
