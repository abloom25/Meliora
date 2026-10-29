import { onBeforeUnmount } from 'vue'
import type { LyricsEngineDebugSnapshot } from '../core/diagnostics/lyrics-debug'
import {
  createSpringState,
  isSpringSettled,
  snapSpring,
  stepSpring,
  type SpringConfig,
  type SpringState,
} from '../core/motion/spring'
import { VirtualLyricLayout } from '../core/lyrics/virtual-layout'
import { lyricBrowseReturnStiffness } from '../core/lyrics/browse-return'

// 歌词行的位移引擎。
//
// 版面完全由 JS 掌管:每一行绝对定位,纵坐标 = 版面位置 − 当前偏移,写在 translate 上。
// 容器不滚动(overflow: clip),"滚动"只是所有行的目标坐标一起变。这样做的好处是
// 每一行都可以有自己的一根弹簧:换行时各行只改目标不改速度,连续换行、seek 打断都不
// 会出现速度突变;和声行展开/收起时它下面的行被弹开/收拢,也只是目标变了而已,
// 不需要任何版面快照与补偿。
//
// 牵引感来自整个可见区域自上而下错峰起步，不让可变行高反转传播顺序。
// 唱过的行也参与牵引。按可见行数压缩间隔,限制当前行和整道波的等待时间。
// 错峰会让相邻行在运动中短暂靠近,位移越大靠得越近;间隔按本次位移收窄,
// 保证靠近量不超过一个行距,相邻行不会叠在一起。
//
// 主动跳转(拖进度条、点击歌词)同时用柔和弹簧追赶,不再逐行等待;远跳行程封顶在
// 半屏出头,离开的行直接就位(它们早已在视口之外)。尺寸重排则不截断当前位置。

export interface LyricsEngineOptions {
  requestFrame?: (callback: FrameRequestCallback) => number
  cancelFrame?: (handle: number) => void
  getViewport: () => HTMLElement | null | undefined
  getLineElements: () => readonly (HTMLElement | null | undefined)[]
  /** 等待点外层，data-waiting-anchor 必须标明其所属的下一句索引。 */
  getWaitingElement?: () => HTMLElement | null | undefined
  /** Virtual hosts supply global row indices in data-lyric-index. */
  getLineCount?: () => number
  getEstimatedHeight?: (index: number) => number
  onWindowChange?: (indices: readonly number[]) => void
  /** 是否启用动效。false 时所有位移都瞬时完成 */
  isAnimated: () => boolean
  /** 弹簧刚度系数(1 = 默认)。越大越紧绷、越快到位 */
  getSpringScale: () => number
  /** 主行之间与主句—和声之间的间距(像素)。由面板从样式里读出来 */
  getGaps: () => { gap: number; harmonyGap: number }
  debugEnabled?: () => boolean
  /** Invalidates a sampled diagnostic view; callers throttle publication. */
  onDebugUpdate?: () => void
}

export interface LyricsSceneInput {
  /** 各行是否为背景和声 */
  background: readonly boolean[]
  /** 各行的和声展开状态 */
  open?: readonly boolean[]
  /** Preferred sparse snapshot; avoids scanning all rows on each scene change. */
  openHarmonies?: readonly number[]
  /** 锚点行,-1 表示还没开始唱 */
  focus: number
  active?: readonly number[]
  /** 暂停时所有主行恢复原始大小；省略表示正在播放。 */
  playing?: boolean
  /** 在下一句前预留等待点的位置，跟随时让空隙中心落在歌词锚点。 */
  waiting?: { nextAnchor: number }
}

/** spring:正常逐行牵引;seek:同时柔和追赶;none:首次排版、关闭动效或切歌直接就位。 */
export type LyricsTransition = 'spring' | 'seek' | 'none'

export interface SetSceneOptions {
  /**
   * true 时退出浏览模式,让锚点行回到视口锚点位置。
   * 面板在用户没有接管滚动时总是传 true
   */
  follow?: boolean
  /**
   * 距离下一次换行还剩多少毫秒。快段落缩短错峰并适度提速；
   * 不强迫弹簧在极短预算内停住，下一句沿用当前位置和速度继续牵引。
   */
  budgetMs?: number
}

export interface BrowseOptions {
  /** 直接就位,不经过弹簧。手指拖动时必须与手指 1:1 跟随 */
  snap?: boolean
}

export interface LyricsMeasureOptions {
  /** 歌词升级/补测只改变目标，保留视觉位置、速度、剩余错峰和和声开合。 */
  preserveMotion?: boolean
  /** 尺寸、字体或翻译变化：从当前视觉位置同时追向新布局，不重新错峰。 */
  transition?: 'reflow'
}

// 锚点行的中线落在视口这个比例处。Apple Music 把当前行放在偏上一点的位置,
// 下方留给接下来要唱的几句
export const LYRIC_ANCHOR_RATIO = 0.42
// 自然频率 12 rad/s、阻尼比 0.85：主要行程在约半秒内完成，理论过冲小于 0.7%。
// 留下轻微弹性，但避免到锚点后继续上下漂动。
const FOLLOW_STIFFNESS = 144
const FOLLOW_DAMPING_RATIO = 0.85
// 极短歌词只适度提速，不能因剩余预算变成 1ms 就把弹簧拉硬几十倍。
const MAX_BUDGET_FREQUENCY_BOOST = 1.35
// 非法/过大的外部刚度配置仍需有界，避免一帧内完成几乎全部行程。
const MAX_FOLLOW_FREQUENCY = 60
const SEEK_STIFFNESS = 100
const SEEK_DAMPING_RATIO = 1
const INACTIVE_LINE_SCALE = 0.97
const SCALE_POSITION_EPSILON = 0.0001
const SCALE_VELOCITY_EPSILON = 0.001
// 浏览模式(滚轮)的弹簧:临界阻尼、更硬,滚轮的阶跃被平滑掉但不拖沓
const BROWSE_STIFFNESS = 420
const BROWSE_DAMPING_RATIO = 1
// 逐行错峰的最长间隔,当前句与整道可见牵引波的最大等待时间。
const DELAY_STEP_MS = 50
const MAX_FOCUS_DELAY_MS = 160
const MAX_WAVE_DELAY_MS = 420
// 阶跃响应的峰值速度与 ω·位移 的比值(ζ = 0.85 时约 0.409，向上取整留余量)。
// 相邻行的最大靠近量 ≈ 峰值速度 × 起步间隔,用它反推允许的间隔
const PEAK_SPEED_RATIO = 0.42
// 视口上下各留这么多像素:落在这个范围里的行参与动画并保持渲染,之外的行隐藏
const STAGE_MARGIN_PX = 160
// 单次位移的动画行程上限(视口高度的倍数)。超出的部分直接就位,只牵引最后这一段
const JUMP_TRAVEL_RATIO = 0.55
// 触摸惯性:速度按 e^(-t/τ) 衰减,低于阈值停止
const FLING_TAU_SECONDS = 0.38
const FLING_STOP_SPEED = 24
const FLING_MAX_SPEED = 5000

interface LineMotion {
  index: number
  element: HTMLElement
  spring: SpringState
  target: number
  /** 起步前的剩余等待时间(毫秒),牵引波就来自这里 */
  delayMs: number
  /** 弹簧已经起步且尚未停下。重定向时据此决定要不要重新排延迟 */
  moving: boolean
  onstage: boolean
  lastWritten: string
  /** 主行缩放与位移分别保存位置和速度，共享初次起步错峰。 */
  scale: SpringState
  scaleTarget: number
  /** 初次与位移共用错峰；缩放已在运动时不能为新的位移等待而停住。 */
  scaleDelayMs: number
  lastScaleWritten: string
  /**
   * 和声行的展开程度(0…1)与目标。版面按它连续变化,下面的行 1:1 跟随;
   * 同一个值写到 --lyric-harmony 上驱动裁切 / 淡出 / 模糊,视觉与占位永远同步
   */
  open: SpringState
  openTarget: number
  lastOpenWritten: string
}

interface BrowseAnchor {
  index: number
  top: number
}

// 和声开合的弹簧:临界阻尼(裁切一旦过冲就会露出不该露的一截),约 0.35s 完成
const HARMONY_STIFFNESS = 180
const HARMONY_DAMPING_RATIO = 1
const HARMONY_CONFIG: SpringConfig = {
  stiffness: HARMONY_STIFFNESS,
  damping: 2 * HARMONY_DAMPING_RATIO * Math.sqrt(HARMONY_STIFFNESS),
  mass: 1,
}
const SCALE_CONFIG: SpringConfig = {
  stiffness: FOLLOW_STIFFNESS,
  damping: 2 * FOLLOW_DAMPING_RATIO * Math.sqrt(FOLLOW_STIFFNESS),
  mass: 1,
}

function springConfig(stiffness: number, dampingRatio: number, scale: number): SpringConfig {
  const scaled = stiffness * Math.max(0.1, scale)
  return { stiffness: scaled, damping: 2 * dampingRatio * Math.sqrt(scaled), mass: 1 }
}

export function useLyricsEngine(options: LyricsEngineOptions) {
  const requestFrame =
    options.requestFrame ??
    ((callback: FrameRequestCallback) => window.requestAnimationFrame(callback))
  const cancelFrame =
    options.cancelFrame ?? ((handle: number) => window.cancelAnimationFrame(handle))
  let motions: LineMotion[] = []
  let heights: number[] = []
  let gaps = { gap: 0, harmonyGap: 0 }
  let viewportHeight = 0
  let viewportMeasurable = false
  let layout = new VirtualLyricLayout(0)
  let scene: LyricsSceneInput | null = null
  let activeLines = new Set<number>()
  let openHarmonies = new Set<number>()
  let mode: 'follow' | 'browse' = 'follow'
  /** 当前生效的版面偏移:各行 y = tops[i] − offset */
  let offset = 0
  let browseOffset = 0
  let bounds: [number, number] = [0, 0]
  let flingVelocity = 0
  let config = springConfig(FOLLOW_STIFFNESS, FOLLOW_DAMPING_RATIO, 1)
  let frame = 0
  let lastFrameAt: number | null = null
  let publishedWindow = ''
  let mountTransition: LyricsTransition | 'reflow' = 'none'
  let mountDelta = 0
  let waveStartedAt = 0
  let waveStepMs = 0
  // 点与下一句共享行位移；仅对重排改变的间距单独保留位置和速度，避免 resize 先跳半个间距。
  const waitingHalfExtent = createSpringState(0, 0)
  let waitingHalfExtentTarget = 0
  let waitingMotionAnchor: number | null = null
  let waitingElement: HTMLElement | null = null
  let waitingTopWritten = ''
  let waitingVisibilityWritten = ''

  function isOpen(index: number): boolean {
    return scene?.openHarmonies ? openHarmonies.has(index) : Boolean(scene?.open?.[index])
  }

  function scaleFor(index: number): number {
    return scene?.background[index] ||
      scene?.playing === false ||
      mode === 'browse' ||
      activeLines.has(index)
      ? 1
      : INACTIVE_LINE_SCALE
  }

  function scaleSettled(motion: LineMotion): boolean {
    return isSpringSettled(
      motion.scale,
      motion.scaleTarget,
      SCALE_POSITION_EPSILON,
      SCALE_VELOCITY_EPSILON,
    )
  }

  function boundedScale(stiffness: number): number {
    const requested = options.getSpringScale()
    const scale = Number.isFinite(requested) ? Math.max(0.1, requested) : 1
    return Math.min(scale, MAX_FOLLOW_FREQUENCY ** 2 / stiffness)
  }

  function hasMotion(): boolean {
    return (
      flingVelocity !== 0 ||
      !isSpringSettled(waitingHalfExtent, waitingHalfExtentTarget) ||
      motions.some(
        (motion) =>
          motion.delayMs > 0 ||
          motion.scaleDelayMs > 0 ||
          !isSpringSettled(motion.spring, motion.target) ||
          !scaleSettled(motion) ||
          !isSpringSettled(motion.open, motion.openTarget, 0.004, 0.02),
      )
    )
  }

  function beginReflow(): void {
    mountTransition = 'reflow'
    mountDelta = 0
    config = springConfig(FOLLOW_STIFFNESS, 1, boundedScale(FOLLOW_STIFFNESS))
    retargetUniform()
  }

  function ensureHeights(invalidate = false): void {
    const count = options.getLineCount?.() ?? options.getLineElements().length
    if (count === heights.length && !invalidate) return
    heights = Array.from({ length: count }, (_, index) => options.getEstimatedHeight?.(index) ?? 40)
    layout = new VirtualLyricLayout(count)
    rebuildLayout()
  }

  function setLayoutRow(index: number, open: number): void {
    const background = scene?.background[index] ?? false
    layout.set(
      index,
      heights[index] ?? 0,
      background ? gaps.harmonyGap : gaps.gap,
      background ? open : 1,
    )
  }

  function rebuildLayout(): void {
    const mounted = new Map(motions.map((motion) => [motion.index, motion]))
    for (let index = 0; index < heights.length; index += 1) {
      setLayoutRow(index, mounted.get(index)?.open.value ?? (isOpen(index) ? 1 : 0))
    }
  }

  function waitingAnchor(): number | null {
    const index = scene?.waiting?.nextAnchor
    return index !== undefined && Number.isInteger(index) && index >= 0 && index < heights.length
      ? index
      : null
  }

  function waitingExtent(): number {
    return waitingAnchor() === null
      ? 0
      : Math.min(100, Math.max(52, viewportHeight * 0.16, gaps.gap * 2))
  }

  function syncWaitingExtent(): void {
    const anchor = waitingAnchor()
    waitingHalfExtentTarget = waitingExtent() / 2
    if (anchor !== waitingMotionAnchor) {
      waitingMotionAnchor = anchor
      snapSpring(waitingHalfExtent, waitingHalfExtentTarget)
    }
  }

  /** 等待点不是歌词行：在下一句前插入独立空隙，不改变歌词的虚拟索引。 */
  function rowTop(index: number): number {
    const waiting = waitingAnchor()
    return layout.top(index) + (waiting !== null && index >= waiting ? waitingExtent() : 0)
  }

  function rowWindow(from: number, until: number): number[] {
    const waiting = waitingAnchor()
    if (waiting === null) return layout.window(from, until)
    const start = layout.top(waiting)
    const extent = waitingExtent()
    // 查询底层前缀和前去掉虚拟空隙；空隙内部折叠到下一句的原始起点。
    const baseCoordinate = (value: number) => value - Math.min(extent, Math.max(0, value - start))
    return layout.window(baseCoordinate(from), baseCoordinate(until))
  }

  function waitingOffset(): number | null {
    const waiting = waitingAnchor()
    return waiting === null
      ? null
      : layout.top(waiting) + waitingExtent() / 2 - viewportHeight * LYRIC_ANCHOR_RATIO
  }

  function publishWindow(): void {
    if (!options.onWindowChange || !scene) return
    const margin = STAGE_MARGIN_PX + viewportHeight * (1 + JUMP_TRAVEL_RATIO)
    const indices = new Set(rowWindow(offset - margin, offset + viewportHeight + margin))
    for (const index of scene.active ?? [Math.max(0, scene.focus)]) {
      if (index >= 0 && index < heights.length) indices.add(index)
    }
    const waiting = waitingAnchor()
    if (waiting !== null) indices.add(waiting)
    // Retain departing rows until their transition leaves the stage, and never unmount focus.
    for (const motion of motions) {
      if (
        (motion.spring.value + layout.height(motion.index) > -STAGE_MARGIN_PX &&
          motion.spring.value < viewportHeight + STAGE_MARGIN_PX) ||
        motion.element === motion.element.ownerDocument.activeElement
      )
        indices.add(motion.index)
    }
    const sorted = [...indices].sort((left, right) => left - right)
    const key = sorted.join(',')
    if (key === publishedWindow) return
    publishedWindow = key
    options.onWindowChange(sorted)
  }

  function reportDebug() {
    if (options.debugEnabled?.()) options.onDebugUpdate?.()
  }

  function readDebugSnapshot(): LyricsEngineDebugSnapshot | null {
    if (!options.debugEnabled?.()) return null
    let mountedLineCount = 0
    let stagedLineCount = 0
    let visibleLineCount = 0
    let animatingLineCount = 0
    for (const motion of motions) {
      const index = motion.index
      if (!motion.element.isConnected) continue
      mountedLineCount += 1
      const height = layout.height(index)
      const laidOut = scene !== null && viewportHeight > 0
      if (laidOut && motion.onstage && height > 0) stagedLineCount += 1
      if (
        laidOut &&
        height > 0 &&
        motion.spring.value + height > 0 &&
        motion.spring.value < viewportHeight
      )
        visibleLineCount += 1
      if (
        motion.moving ||
        motion.delayMs > 0 ||
        motion.scaleDelayMs > 0 ||
        !scaleSettled(motion) ||
        !isSpringSettled(motion.open, motion.openTarget)
      )
        animatingLineCount += 1
    }
    return {
      mountedLineCount,
      stagedLineCount,
      visibleLineCount,
      animatingLineCount,
      viewportHeight,
      offset,
      browseOffset,
      scrollMode: mode,
      flingVelocity,
      frameScheduled: frame !== 0,
      anchorIndex: scene?.focus ?? -1,
    }
  }

  function write(motion: LineMotion, index: number) {
    const y = motion.spring.value
    const height = layout.height(index)
    // 视口之外的行不渲染。用内联 visibility 而不是 class:行上的 class 由 Vue 整体
    // 重写,这里加的会在下一次打补丁时被抹掉
    const onstage = y + height > -STAGE_MARGIN_PX && y < viewportHeight + STAGE_MARGIN_PX
    if (onstage !== motion.onstage) {
      motion.onstage = onstage
      motion.element.style.visibility = onstage ? '' : 'hidden'
    }
    // 看不见的行不写位置:每次内联样式改动都要重算这个元素的样式,几百行歌词
    // 每次换行全写一遍就是几百毫秒的卡顿。等它进场时再补写(lastWritten 仍是旧值)
    if (!onstage) return
    const value = `0 ${y.toFixed(2)}px`
    if (value !== motion.lastWritten) {
      motion.lastWritten = value
      motion.element.style.translate = value
    }
    const scale = motion.scale.value.toFixed(5)
    if (scale !== motion.lastScaleWritten) {
      motion.lastScaleWritten = scale
      motion.element.style.setProperty('--lyric-line-scale', scale)
    }
    if (scene?.background[index]) {
      const open = motion.open.value.toFixed(3)
      if (open !== motion.lastOpenWritten) {
        motion.lastOpenWritten = open
        motion.element.style.setProperty('--lyric-harmony', open)
      }
    }
  }

  function writeAll() {
    for (const motion of motions) write(motion, motion.index)
    syncWaiting()
    reportDebug()
  }

  /** 挂载后立即写入当前行的视觉位置，不让等待点先出现在最终锚点再等歌词追上。 */
  function syncWaiting(): void {
    const element = options.getWaitingElement?.()
    if (!element?.isConnected) return
    const anchor = waitingAnchor()
    // Vue 尚未替换节点时，旧间奏点保留自己的末帧供 Transition 淡出。
    if (anchor === null || element.dataset.waitingAnchor !== String(anchor)) return
    if (waitingElement !== element) {
      waitingElement = element
      waitingTopWritten = ''
      waitingVisibilityWritten = ''
    }
    const motion = motions.find((entry) => entry.index === anchor)
    const visible =
      viewportMeasurable &&
      viewportHeight > 0 &&
      options.getViewport()?.isConnected &&
      motion?.element.isConnected
    if (visible && motion) {
      const top = `${(motion.spring.value - waitingHalfExtent.value).toFixed(2)}px`
      if (top !== waitingTopWritten) {
        waitingTopWritten = top
        element.style.top = top
      }
    }
    const visibility = visible ? 'visible' : 'hidden'
    if (visibility !== waitingVisibilityWritten) {
      waitingVisibilityWritten = visibility
      element.style.visibility = visibility
    }
  }

  /** 行节点与弹簧一一对应;节点被 Vue 重建时沿用不了旧弹簧,从目标位置重新开始 */
  function syncMotions() {
    const elements = options.getLineElements()
    const previous = new Map(motions.map((motion) => [motion.element, motion]))
    const next: LineMotion[] = []
    for (const [slot, element] of elements.entries()) {
      if (!element) continue
      const index = options.getLineCount ? Number(element.dataset.lyricIndex) : slot
      if (!Number.isInteger(index) || index < 0 || index >= heights.length) continue
      const existing = previous.get(element)
      previous.delete(element)
      const target = rowTop(index) - offset
      const travel = Math.max(viewportHeight * JUMP_TRAVEL_RATIO, 1)
      const start =
        target +
        (mountTransition === 'spring' || mountTransition === 'seek'
          ? Math.max(-travel, Math.min(travel, mountDelta))
          : 0)
      next.push(
        existing ?? {
          index,
          element,
          spring: createSpringState(start, 0),
          target,
          delayMs: 0,
          moving: false,
          onstage: true,
          lastWritten: '',
          scale: createSpringState(scaleFor(index), 0),
          scaleTarget: scaleFor(index),
          scaleDelayMs: 0,
          lastScaleWritten: '',
          open: createSpringState(isOpen(index) ? 1 : 0, 0),
          openTarget: isOpen(index) ? 1 : 0,
          lastOpenWritten: '',
        },
      )
    }
    for (const motion of previous.values()) setLayoutRow(motion.index, motion.openTarget)
    motions = next
  }

  function stopLoop() {
    if (frame) {
      cancelFrame(frame)
      frame = 0
    }
    lastFrameAt = null
  }

  function ensureLoop() {
    if (frame || !hasMotion()) return
    // 从请求这一帧的时刻计时。首帧固定推进 1/60s 会让 120Hz 屏幕起步走双倍距离。
    lastFrameAt = performance.now()
    frame = requestFrame(tick)
  }

  function tick(timestamp: number) {
    frame = 0
    const now = Number.isFinite(timestamp) ? timestamp : performance.now()
    const dt = Math.min(Math.max(0, (now - (lastFrameAt ?? now)) / 1000), 0.25)
    lastFrameAt = now

    if (flingVelocity !== 0) {
      const step = flingVelocity * dt
      flingVelocity *= Math.exp(-dt / FLING_TAU_SECONDS)
      if (Math.abs(flingVelocity) < FLING_STOP_SPEED) flingVelocity = 0
      const before = browseOffset
      shiftBrowse(step, { snap: true })
      // 撞到边界就停,不要在边上抖
      if (browseOffset === before) flingVelocity = 0
    }

    let busy = flingVelocity !== 0
    if (!isSpringSettled(waitingHalfExtent, waitingHalfExtentTarget)) {
      if (dt > 0) stepSpring(waitingHalfExtent, waitingHalfExtentTarget, config, dt)
      if (isSpringSettled(waitingHalfExtent, waitingHalfExtentTarget)) {
        snapSpring(waitingHalfExtent, waitingHalfExtentTarget)
      } else busy = true
    }
    if (stepHarmonies(dt)) busy = true
    for (const motion of motions) {
      const index = motion.index
      let motionDt = dt
      if (motion.delayMs > 0) {
        // 等待只消耗这一帧的一部分，剩余时间立即推进弹簧。
        // 否则短预算也会额外停一整帧，挂载同步还能把刚耗尽的等待重新排满。
        const waiting = Math.min(motion.delayMs / 1000, motionDt)
        motion.delayMs = Math.max(0, motion.delayMs - waiting * 1000)
        motionDt -= waiting
        if (motionDt <= 0) {
          busy = true
        }
      }
      if (!isSpringSettled(motion.spring, motion.target)) {
        if (motionDt > 0) stepSpring(motion.spring, motion.target, config, motionDt)
        if (isSpringSettled(motion.spring, motion.target)) {
          snapSpring(motion.spring, motion.target)
          motion.moving = false
        } else {
          // 相同时间戳/尚未用完等待不代表动画已经结束，也不代表已经起步。
          if (motionDt > 0) motion.moving = true
          busy = true
        }
      } else {
        motion.moving = false
      }
      // Y 可以在等待下一道牵引波，但已开始的缩放必须沿自己的速度继续。
      let scaleDt = dt
      if (motion.scaleDelayMs > 0) {
        const waiting = Math.min(motion.scaleDelayMs / 1000, scaleDt)
        motion.scaleDelayMs = Math.max(0, motion.scaleDelayMs - waiting * 1000)
        scaleDt -= waiting
        if (scaleDt <= 0) busy = true
      }
      if (!scaleSettled(motion)) {
        if (scaleDt > 0) stepSpring(motion.scale, motion.scaleTarget, SCALE_CONFIG, scaleDt)
        if (scaleSettled(motion)) snapSpring(motion.scale, motion.scaleTarget)
        else busy = true
      }
      write(motion, index)
    }
    syncWaiting()

    if (busy) frame = requestFrame(tick)
    else {
      mountTransition = 'none'
      stopLoop()
    }
    publishWindow()
    reportDebug()
  }

  /**
   * 推进和声的开合弹簧。版面随展开程度连续变化,变化量直接加到各行的当前位置上
   * (不经过各行自己的弹簧):这样下面的行与和声的实际占位严格同步,
   * 收回时不会压到还没消失的和声,展开时也不会被揭开的和声顶到
   */
  function stepHarmonies(dt: number): boolean {
    let moved = false
    for (const motion of motions) {
      if (motion.open.value === motion.openTarget && motion.open.velocity === 0) continue
      stepSpring(motion.open, motion.openTarget, HARMONY_CONFIG, dt)
      if (isSpringSettled(motion.open, motion.openTarget, 0.004, 0.02)) {
        snapSpring(motion.open, motion.openTarget)
      }
      setLayoutRow(motion.index, motion.open.value)
      moved = true
    }
    if (!moved) return false
    const before = motions.map((motion) => motion.target)
    computeTargets()
    for (const [slot, motion] of motions.entries()) {
      const index = motion.index
      const shift = motion.target - (before[slot] ?? motion.target)
      if (shift !== 0) motion.spring.value += shift
      // 被顶动的行多半是静止的,主循环不会再写它们,这里就地写
      if (shift !== 0 || scene?.background[index]) write(motion, index)
    }
    return true
  }

  function offsetFor(index: number): number {
    const target = index >= 0 && index < heights.length ? index : 0
    return rowTop(target) + layout.height(target) / 2 - viewportHeight * LYRIC_ANCHOR_RATIO
  }

  function clampBrowse(value: number): number {
    return Math.max(bounds[0], Math.min(bounds[1], value))
  }

  function captureBrowseAnchor(): BrowseAnchor | null {
    if (mode !== 'browse' || !scene || viewportHeight <= 0) return null
    const index = rowWindow(offset, offset + viewportHeight)[0]
    return index === undefined ? null : { index, top: rowTop(index) - offset }
  }

  function restoreBrowseAnchor(anchor: BrowseAnchor | null): void {
    if (anchor && anchor.index < heights.length) {
      browseOffset = rowTop(anchor.index) - anchor.top
    }
  }

  /** 重新排版并算出各行的目标坐标。返回偏移量的变化(正 = 内容上移) */
  function computeTargets(): number {
    const previous = offset
    if (!scene) return 0
    syncWaitingExtent()
    bounds = [offsetFor(0), offsetFor(heights.length - 1)]
    if (bounds[1] < bounds[0]) bounds = [bounds[0], bounds[0]]
    const waiting = waitingOffset()
    if (waiting !== null) {
      bounds = [Math.min(bounds[0], waiting), Math.max(bounds[1], waiting)]
    }
    if (mode === 'follow') {
      offset = waiting ?? offsetFor(scene.focus)
    } else {
      browseOffset = clampBrowse(browseOffset)
      offset = browseOffset
    }
    for (const motion of motions) {
      motion.target = rowTop(motion.index) - offset
    }
    publishWindow()
    return offset - previous
  }

  function snapAll() {
    snapSpring(waitingHalfExtent, waitingHalfExtentTarget)
    for (const motion of motions) {
      snapSpring(motion.spring, motion.target)
      snapSpring(motion.scale, motion.scaleTarget)
      motion.delayMs = 0
      motion.scaleDelayMs = 0
      motion.moving = false
    }
    writeAll()
  }

  function assignScaleTargets(animated: boolean): void {
    for (const motion of motions) {
      motion.scaleTarget = scaleFor(motion.index)
      if (!animated) snapSpring(motion.scale, motion.scaleTarget)
      if (!animated || scene?.playing === false || mode === 'browse' || scaleSettled(motion))
        motion.scaleDelayMs = 0
    }
  }

  /** 把场景里的和声开合状态交给弹簧;瞬时模式下直接就位并重新排版 */
  function assignHarmonyTargets(animated: boolean) {
    if (!scene) return
    let snapped = false
    for (const motion of motions) {
      const index = motion.index
      motion.openTarget = scene.background[index] && isOpen(index) ? 1 : 0
      if (animated || motion.open.value === motion.openTarget) continue
      snapSpring(motion.open, motion.openTarget)
      setLayoutRow(index, motion.openTarget)
      snapped = true
    }
    if (snapped) computeTargets()
  }

  function retargetUniform() {
    for (const motion of motions) {
      motion.delayMs = 0
      motion.scaleDelayMs = 0
    }
    writeAll()
    ensureLoop()
  }

  function retargetRows(budgetMs = Number.POSITIVE_INFINITY, retained?: ReadonlySet<LineMotion>) {
    const travel = Math.max(viewportHeight * JUMP_TRAVEL_RATIO, 1)
    const animated: Array<{ motion: LineMotion; fresh: boolean; ordered: boolean }> = []
    let maxShift = 0

    const onstage = (y: number, height: number, extra = 0) =>
      y + height > -STAGE_MARGIN_PX - extra && y < viewportHeight + STAGE_MARGIN_PX + extra
    const visible = (y: number, height: number) => y + height > 0 && y < viewportHeight

    for (const motion of motions) {
      const height = layout.height(motion.index)
      // 行程封顶:跳得太远的行从视口边缘之外重新起步,速度归零。
      // 先封顶再分类 —— 正在离开的可见行封顶后已经在舞台外,不该再占错峰的序号
      const shift = motion.spring.value - motion.target
      let fresh = false
      if (!retained?.has(motion) && Math.abs(shift) > travel) {
        motion.spring.value = motion.target + Math.sign(shift) * travel
        motion.spring.velocity = 0
        motion.moving = false
        fresh = true
      }
      const start = motion.spring.value
      // 起点或终点在舞台内的行才会被看到,它们构成牵引波
      // 参与错峰排序的只有真正会被看到的行(起点或终点在视口内);舞台边缘
      // 那一圈跟着相邻的可见行同步起步,不占序号 —— 否则视口上方看不见的几行
      // 会把可见行的起步全部往后推
      const ordered = visible(start, height) || visible(motion.target, height)
      const staged = onstage(start, height) || onstage(motion.target, height)
      // 舞台边缘再往外一个行程的行也要跟着动:封顶后的起点在目标之外一个行程,
      // 若边缘外的行直接就位,进场的行会从它们身上穿过去 —— 平时在视口外看不见,
      // 但动画没完就滚滚轮会把那片推进视口。这一圈行不参与错峰排序,跟相邻的可见行同步起步
      if (!staged && !onstage(motion.target, height, travel)) {
        if (!retained?.has(motion)) {
          snapSpring(motion.spring, motion.target)
          motion.delayMs = 0
          motion.scaleDelayMs = 0
          motion.moving = false
        }
        continue
      }
      const remaining = Math.abs(start - motion.target)
      if (remaining < 0.5 && !motion.moving && motion.delayMs <= 0 && scaleSettled(motion)) {
        if (!retained?.has(motion)) snapSpring(motion.spring, motion.target)
        continue
      }
      maxShift = Math.max(maxShift, remaining)
      animated.push({ motion, fresh, ordered })
    }

    // 整个可见区域保持连续相位,不能把当前句之前的行全部归零成同步移动的一块。
    // 隐藏的舞台边缘行不占序号；focus 尚未挂载时也按它的插入位置限制等待。
    animated.sort((left, right) => left.motion.index - right.motion.index)
    const ordered = animated.filter((entry) => entry.ordered)
    const focus = Math.max(0, scene?.focus ?? 0)
    const focusOrder = ordered.filter(({ motion }) => motion.index < focus).length
    const lastOrder = Math.max(0, ordered.length - 1)

    // 错峰间隔:相邻行的最大靠近量 ≈ 峰值速度 × 间隔,不得超过一个行距
    const omega = Math.sqrt(config.stiffness / (config.mass ?? 1))
    const peakSpeed = PEAK_SPEED_RATIO * omega * maxShift
    const allowance = Math.max(gaps.gap, 8)
    let stepMs =
      peakSpeed > 0 ? Math.min(DELAY_STEP_MS, (allowance / peakSpeed) * 1000) : DELAY_STEP_MS
    if (focusOrder > 0) stepMs = Math.min(stepMs, MAX_FOCUS_DELAY_MS / focusOrder)
    if (lastOrder > 0) stepMs = Math.min(stepMs, MAX_WAVE_DELAY_MS / lastOrder)
    // 快句继续压缩整道波,在下一次换行之前的一半时间内全部起步。
    if (Number.isFinite(budgetMs) && budgetMs > 0) {
      stepMs = Math.min(stepMs, (budgetMs * 0.5) / Math.max(1, lastOrder))
    }
    if (mountTransition === 'seek') stepMs = 0
    if (retained) stepMs = waveStepMs
    else {
      waveStartedAt = performance.now()
      waveStepMs = stepMs
    }
    const elapsed = retained ? Math.max(0, performance.now() - waveStartedAt) : 0

    const delays = new Map<LineMotion, number>()
    for (const [position, entry] of ordered.entries()) {
      delays.set(entry.motion, Math.max(0, position * stepMs - elapsed))
    }
    // 舞台外那一圈:上方的跟最上面的可见行,下方的跟最下面的可见行
    const firstDelay = ordered.length ? delays.get(ordered[0]!.motion)! : 0
    const lastDelay = ordered.length ? delays.get(ordered[ordered.length - 1]!.motion)! : 0
    let passedOrdered = false
    for (const entry of animated) {
      if (entry.ordered) passedOrdered = true
      // 虚拟窗口更新只让新行加入动画；旧行的速度和剩余等待不重新编排。
      if (retained?.has(entry.motion)) continue
      const delayMs = delays.get(entry.motion) ?? (passedOrdered ? lastDelay : firstDelay)
      // 已经起步的行保持起步:连续换行时再把它按住,它会卡在半空。
      // 还在等的行按本批次的顺序重新排延迟,一批之内等待时间严格随行序递增
      if (!entry.fresh && entry.motion.moving) {
        entry.motion.delayMs = 0
      } else {
        // 还在等的行只会等得更短，不能在连续换句时无限期重新排满。
        entry.motion.delayMs =
          entry.fresh || entry.motion.delayMs <= 0
            ? delayMs
            : Math.min(entry.motion.delayMs, delayMs)
      }
    }
    // A lower row may still be moving from the previous phrase. Never pause it;
    // instead let preceding settled rows join now, so a fresh upper row cannot start later.
    // Newly mounted rows also inherit the elapsed wave instead of restarting a full delay.
    let latestStart = Number.POSITIVE_INFINITY
    for (let index = animated.length - 1; index >= 0; index -= 1) {
      const entry = animated[index]!
      if (!retained?.has(entry.motion)) {
        entry.motion.delayMs = Math.min(entry.motion.delayMs, latestStart)
      }
      latestStart = Math.min(latestStart, entry.motion.delayMs)
      if (retained?.has(entry.motion)) continue
      if (
        scaleSettled(entry.motion) ||
        Math.abs(entry.motion.scale.velocity) > SCALE_VELOCITY_EPSILON
      ) {
        entry.motion.scaleDelayMs = 0
      } else {
        // 新的缩放跟随该行的初次位移等待；已经在动的缩放不豁免 Y 的新错峰。
        entry.motion.scaleDelayMs =
          entry.motion.scaleDelayMs > 0
            ? Math.min(entry.motion.scaleDelayMs, entry.motion.delayMs)
            : entry.motion.delayMs
      }
    }

    writeAll()
    if (animated.length) ensureLoop()
  }

  function apply(
    transition: LyricsTransition,
    budgetMs = Number.POSITIVE_INFINITY,
    redirect = true,
  ) {
    const animated = transition !== 'none' && options.isAnimated()
    const delta = computeTargets()
    assignHarmonyTargets(animated)
    assignScaleTargets(animated)
    if (!animated) {
      mountTransition = 'none'
      mountDelta = 0
      snapAll()
      return
    }
    // active / 和声状态变化不等于换行；浏览期间的播放推进也不能接管滚轮弹簧。
    // 保留上一道牵引波的刚度、方向和延迟，只推进可能变化的和声开合。
    if ((!redirect && transition !== 'seek') || mode === 'browse') {
      ensureLoop()
      return
    }
    mountTransition = transition
    mountDelta = delta
    if (transition === 'seek') {
      config = springConfig(SEEK_STIFFNESS, SEEK_DAMPING_RATIO, boundedScale(SEEK_STIFFNESS))
      retargetRows()
      ensureLoop()
      return
    }
    // 快段落只温和缩短响应；时间戳密集或较晚采样不代表应该突然改变手感。
    // 尚未走完的行程由下一句连同当前速度接管，而不是为赶预算一帧跳到终点。
    const requestedScale = options.getSpringScale()
    let frequency = Math.sqrt(
      FOLLOW_STIFFNESS * (Number.isFinite(requestedScale) ? Math.max(0.1, requestedScale) : 1),
    )
    if (Number.isFinite(budgetMs) && budgetMs > 0) {
      const needed = 4 / (FOLLOW_DAMPING_RATIO * (budgetMs / 1000))
      frequency = Math.min(Math.max(frequency, needed), frequency * MAX_BUDGET_FREQUENCY_BOOST)
    }
    const scale = Math.min(frequency, MAX_FOLLOW_FREQUENCY) ** 2 / FOLLOW_STIFFNESS
    config = springConfig(FOLLOW_STIFFNESS, FOLLOW_DAMPING_RATIO, scale)
    retargetRows(budgetMs)
    ensureLoop()
  }

  function shiftBrowse(delta: number, browseOptions: BrowseOptions) {
    mountTransition = browseOptions.snap || !options.isAnimated() ? 'none' : 'spring'
    if (mode !== 'browse') {
      mode = 'browse'
      browseOffset = offset
    }
    browseOffset = clampBrowse(browseOffset + delta)
    mountDelta = computeTargets()
    assignScaleTargets(!browseOptions.snap && options.isAnimated())
    if (browseOptions.snap || !options.isAnimated()) {
      snapAll()
      return
    }
    config = springConfig(BROWSE_STIFFNESS, BROWSE_DAMPING_RATIO, 1)
    retargetUniform()
  }

  // ---- 对外接口 ----

  /** 首次/恢复时瞬时排版；常规尺寸更新可以保留已开始的动画。 */
  function remeasure(invalidate = false, measureOptions: LyricsMeasureOptions = {}) {
    const viewport = options.getViewport()
    if (!viewport) {
      viewportMeasurable = false
      syncWaiting()
      return
    }
    const measuredViewportHeight = viewport.clientHeight
    viewportMeasurable = measuredViewportHeight > 0
    // 隐藏时保留已有布局；首次零高仍要发布估计窗口，引导虚拟行挂载后再测量。
    if (measuredViewportHeight <= 0 && viewportHeight > 0) {
      syncWaiting()
      return
    }
    const browseAnchor = captureBrowseAnchor()
    ensureHeights(invalidate)
    syncMotions()
    const beforeTargets = motions.map((motion) => motion.target)
    const beforeWaitingExtent = waitingHalfExtentTarget
    const preserveMotion =
      (measureOptions.preserveMotion || measureOptions.transition === 'reflow') &&
      options.isAnimated()
    viewportHeight = measuredViewportHeight
    gaps = options.getGaps()
    for (const motion of motions) {
      const measured = motion.element.offsetHeight
      if (measured > 0) heights[motion.index] = measured
      if (scene) {
        motion.openTarget = scene.background[motion.index] && isOpen(motion.index) ? 1 : 0
        // 瞬时重排必须先完成和声，再恢复浏览锚点，避免随后 apply('none') 二次挤动。
        if (!preserveMotion) snapSpring(motion.open, motion.openTarget)
      }
    }
    rebuildLayout()
    restoreBrowseAnchor(browseAnchor)
    if (!scene) return
    if (!preserveMotion) {
      apply('none')
      return
    }
    // 更新目标而不平移当前位置：字体/换行变化不应把整行先瞬移 targetDelta。
    // 补测保留已有速度和等待；主动重排让所有行同时从当前视觉位置追新布局。
    computeTargets()
    assignScaleTargets(true)
    const targetsChanged = motions.some(
      (motion, slot) => Math.abs(motion.target - beforeTargets[slot]!) > 0.001,
    )
    if (
      measureOptions.transition === 'reflow' &&
      (targetsChanged || beforeWaitingExtent !== waitingHalfExtentTarget)
    ) {
      beginReflow()
      return
    }
    writeAll()
    if (hasMotion()) {
      if (mountTransition === 'none') {
        mountTransition = 'reflow'
        mountDelta = 0
      }
      ensureLoop()
    }
  }

  /** Newly mounted rows are measured in one read batch without stopping existing springs. */
  function syncMounted(): void {
    ensureHeights()
    const retained = new Set(motions)
    syncMotions()
    const anchor = motions.find((motion) => motion.target + layout.height(motion.index) > 0)
    const beforeAnchor = anchor ? rowTop(anchor.index) : 0
    const measurements = motions.map((motion) => motion.element.offsetHeight)
    for (const [slot, motion] of motions.entries()) {
      if (measurements[slot]! > 0) heights[motion.index] = measurements[slot]!
      setLayoutRow(motion.index, motion.open.value)
    }
    if (mode === 'browse' && anchor) browseOffset += rowTop(anchor.index) - beforeAnchor
    computeTargets()
    assignScaleTargets(options.isAnimated())
    if (options.isAnimated() && retained.size > 0) {
      if (
        mode === 'follow' &&
        (mountTransition === 'spring' || mountTransition === 'seek') &&
        motions.some((motion) => !retained.has(motion))
      ) {
        retargetRows(Number.POSITIVE_INFINITY, retained)
      } else if (mountTransition === 'none' && hasMotion()) {
        beginReflow()
      } else {
        writeAll()
        if (hasMotion()) ensureLoop()
      }
    } else snapAll()
    publishWindow()
  }

  function setScene(
    next: LyricsSceneInput,
    transition: LyricsTransition,
    sceneOptions: SetSceneOptions = {},
  ) {
    const previous = scene
    const previousOpen = openHarmonies
    const wasBrowsing = mode === 'browse'
    const waitingChanged = previous?.waiting?.nextAnchor !== next.waiting?.nextAnchor
    const browseAnchor = waitingChanged ? captureBrowseAnchor() : null
    scene = next
    activeLines = new Set(next.active ?? [next.focus])
    openHarmonies = new Set(next.openHarmonies)
    ensureHeights()
    if (sceneOptions.follow) {
      mode = 'follow'
      flingVelocity = 0
    }
    syncMotions()
    if (
      !previous ||
      previous.background !== next.background ||
      !previous.openHarmonies ||
      !next.openHarmonies
    ) {
      rebuildLayout()
    } else {
      const mounted = new Set(motions.map((motion) => motion.index))
      // Mounted harmony rows retain their current spring value; only offscreen
      // changed rows jump directly to the new extent. Primary rows never change.
      for (const index of previousOpen) {
        if (!openHarmonies.has(index) && !mounted.has(index)) setLayoutRow(index, 0)
      }
      for (const index of openHarmonies) {
        if (!previousOpen.has(index) && !mounted.has(index)) setLayoutRow(index, 1)
      }
    }
    if (mode === 'browse') restoreBrowseAnchor(browseAnchor)
    // 还没量过(第一次就绪)或行数对不上(列表重建):先补一次测量,这一次瞬时就位
    if (!viewportHeight) {
      remeasure()
      return
    }
    if (waitingChanged && transition === 'spring' && options.isAnimated()) {
      // 等待空间开合是布局变化，保留当前位置和速度；不把它当作新句级联或远跳。
      apply(transition, sceneOptions.budgetMs, false)
      if (mode === 'follow') beginReflow()
      else retargetUniform()
      return
    }
    apply(
      transition,
      sceneOptions.budgetMs,
      previous?.focus !== next.focus || (wasBrowsing && mode === 'follow'),
    )
  }

  /** 退出浏览模式,锚点行回到视口锚点位置 */
  function follow(transition: LyricsTransition = 'spring', adaptive = false) {
    if (!scene) return
    const distance = browseState().distanceScreens
    mode = 'follow'
    flingVelocity = 0
    apply(transition)
    if (adaptive && options.isAnimated()) {
      config = springConfig(lyricBrowseReturnStiffness(distance), SEEK_DAMPING_RATIO, 1)
    }
  }

  function browseState(): { distanceScreens: number; coasting: boolean } {
    const target = scene ? (waitingOffset() ?? offsetFor(scene.focus)) : offset
    return {
      distanceScreens: Math.abs(browseOffset - target) / Math.max(1, viewportHeight),
      coasting: flingVelocity !== 0,
    }
  }

  /** 用户滚动:内容按 delta 像素上移(负数下移) */
  function browseBy(delta: number, browseOptions: BrowseOptions = {}) {
    if (!scene) return
    flingVelocity = 0
    shiftBrowse(delta, browseOptions)
  }

  /** 手指松开后的惯性滚动,速度单位 px/s,正数表示内容上移 */
  function fling(velocity: number) {
    if (!scene || !Number.isFinite(velocity)) return
    const capped = Math.max(-FLING_MAX_SPEED, Math.min(FLING_MAX_SPEED, velocity))
    // 速度为 0 也是合法调用:手指重新按下时用它刹住正在进行的惯性
    if (Math.abs(capped) < FLING_STOP_SPEED || !options.isAnimated()) {
      flingVelocity = 0
      return
    }
    if (mode !== 'browse') {
      mode = 'browse'
      browseOffset = offset
    }
    flingVelocity = capped
    ensureLoop()
  }

  /**
   * 让第 index 行进入视口(键盘焦点落在视口外的行上时)。
   * 返回 true 表示确实滚动了,面板据此进入浏览态
   */
  function reveal(index: number): boolean {
    if (index < 0 || index >= heights.length || !scene) return false
    const target = rowTop(index) - offset
    const height = layout.height(index)
    const top = viewportHeight * 0.12
    const bottom = viewportHeight * 0.88
    let delta = 0
    if (target < top) delta = target - top
    else if (target + height > bottom) delta = target + height - bottom
    if (Math.abs(delta) < 1) return false
    browseBy(delta)
    return true
  }

  /** 立即结束所有位移,各行回到目标位置(关闭动效 / 切歌 / 卸载) */
  function cancel() {
    stopLoop()
    flingVelocity = 0
    for (const motion of motions) {
      snapSpring(motion.open, motion.openTarget)
      setLayoutRow(motion.index, motion.openTarget)
    }
    if (scene) computeTargets()
    snapSpring(waitingHalfExtent, waitingHalfExtentTarget)
    for (const motion of motions) {
      if (!motion.element.isConnected) continue
      snapSpring(motion.spring, motion.target)
      snapSpring(motion.scale, motion.scaleTarget)
      motion.delayMs = 0
      motion.scaleDelayMs = 0
      motion.moving = false
    }
    writeAll()
  }

  /**
   * 忘掉所有行(歌词列表整体更换)。不清内联样式:旧行还要带着自己的位置淡出,
   * 清掉 translate 会让它们全堆到顶上叠在一起
   */
  function reset() {
    stopLoop()
    flingVelocity = 0
    motions = []
    heights = []
    layout = new VirtualLyricLayout(0)
    viewportHeight = 0
    viewportMeasurable = false
    bounds = [0, 0]
    scene = null
    activeLines.clear()
    openHarmonies.clear()
    mode = 'follow'
    offset = 0
    browseOffset = 0
    publishedWindow = ''
    mountTransition = 'none'
    mountDelta = 0
    waitingMotionAnchor = null
    waitingHalfExtentTarget = 0
    snapSpring(waitingHalfExtent, 0)
    for (const element of [waitingElement, options.getWaitingElement?.()]) {
      if (element?.isConnected) element.style.visibility = 'hidden'
    }
    waitingElement = null
    waitingTopWritten = ''
    waitingVisibilityWritten = ''
    options.onWindowChange?.([])
    reportDebug()
  }

  function isBrowsing(): boolean {
    return mode === 'browse'
  }

  /** 真实视口可见性，按当前动画位置计算；不把 overscan 当作已经进入视口。 */
  function isRowVisible(index: number): boolean {
    const motion = motions.find((entry) => entry.index === index)
    if (!motion || viewportHeight <= 0) return false
    const height = layout.height(index)
    return height > 0 && motion.spring.value + height > 0 && motion.spring.value < viewportHeight
  }

  /** 当前各行的目标纵坐标(测试与调试用) */
  function targets(): number[] {
    return motions.map((motion) => motion.target)
  }

  onBeforeUnmount(() => {
    stopLoop()
  })

  return {
    remeasure,
    syncMounted,
    syncWaiting,
    setScene,
    follow,
    browseBy,
    fling,
    reveal,
    cancel,
    reset,
    isBrowsing,
    browseState,
    isRowVisible,
    targets,
    readDebugSnapshot,
  }
}
