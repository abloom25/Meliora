import { onBeforeUnmount } from 'vue'
import {
  createSpringState,
  isSpringSettled,
  snapSpring,
  stepSpring,
  type SpringConfig,
  type SpringState,
} from '../core/motion/spring'
import { layoutLyricLines, lyricFocusOffset, type LyricLayout } from '../core/lyrics'

// 歌词行的位移引擎。
//
// 版面完全由 JS 掌管:每一行绝对定位,纵坐标 = 版面位置 − 当前偏移,写在 translate 上。
// 容器不滚动(overflow: clip),"滚动"只是所有行的目标坐标一起变。这样做的好处是
// 每一行都可以有自己的一根弹簧:换行时各行只改目标不改速度,连续换行、seek 打断都不
// 会出现速度突变;和声行展开/收起时它下面的行被弹开/收拢,也只是目标变了而已,
// 不需要任何版面快照与补偿。
//
// 牵引感(Apple Music 的那种"被拽过去")来自逐行错峰起步:沿运动方向最靠前的行先动,
// 往后每一行多等一个固定间隔。所有行同时起步只是整片匀速平移。
// 错峰会让相邻行在运动中短暂靠近,位移越大靠得越近;间隔按本次位移收窄,
// 保证靠近量不超过一个行距,相邻行不会叠在一起。
//
// 跳转(拖进度条、点击很远的一行)不会拖着整首歌飞过去:行程封顶在半屏出头,
// 新位置的行从视口边缘之外级联进场,离开的行直接就位(它们早已在视口之外)。

export interface LyricsEngineOptions {
  getViewport: () => HTMLElement | null | undefined
  getLineElements: () => readonly (HTMLElement | null | undefined)[]
  /** 是否启用动效。false 时所有位移都瞬时完成 */
  isAnimated: () => boolean
  /** 弹簧刚度系数(1 = 默认)。越大越紧绷、越快到位 */
  getSpringScale: () => number
  /** 主行之间与主句—和声之间的间距(像素)。由面板从样式里读出来 */
  getGaps: () => { gap: number; harmonyGap: number }
}

export interface LyricsSceneInput {
  /** 各行是否为背景和声 */
  background: readonly boolean[]
  /** 各行的和声展开状态 */
  open: readonly boolean[]
  /** 锚点行,-1 表示还没开始唱 */
  focus: number
}

/** spring:带错峰的弹簧位移;none:瞬时就位(尺寸变化、关闭动效、切歌) */
export type LyricsTransition = 'spring' | 'none'

export interface SetSceneOptions {
  /**
   * true 时退出浏览模式,让锚点行回到视口锚点位置。
   * 面板在用户没有接管滚动时总是传 true
   */
  follow?: boolean
  /**
   * 距离下一次换行还剩多少毫秒。快段落(说唱、滚动字幕)里整道牵引波必须压进
   * 这段时间的一半,否则下一行到来时上一道波还没起步,活跃行永远追不到锚点
   */
  budgetMs?: number
}

export interface BrowseOptions {
  /** 直接就位,不经过弹簧。手指拖动时必须与手指 1:1 跟随 */
  snap?: boolean
}

// 锚点行的中线落在视口这个比例处。Apple Music 把当前行放在偏上一点的位置,
// 下方留给接下来要唱的几句
export const LYRIC_ANCHOR_RATIO = 0.42
// 跟随模式的弹簧:自然频率 10 rad/s、阻尼比 0.75,约半秒到位,有一点点过冲
const FOLLOW_STIFFNESS = 100
const FOLLOW_DAMPING_RATIO = 0.75
// 浏览模式(滚轮)的弹簧:临界阻尼、更硬,滚轮的阶跃被平滑掉但不拖沓
const BROWSE_STIFFNESS = 420
const BROWSE_DAMPING_RATIO = 1
// 逐行错峰的间隔,以及参与错峰的最大行数
const DELAY_STEP_MS = 48
const MAX_DELAY_ORDER = 10
// 阶跃响应的峰值速度与 ω·位移 的比值(ζ = 0.75 时约 0.44)。
// 相邻行的最大靠近量 ≈ 峰值速度 × 起步间隔,用它反推允许的间隔
const PEAK_SPEED_RATIO = 0.44
// 视口上下各留这么多像素:落在这个范围里的行参与动画并保持渲染,之外的行隐藏
const STAGE_MARGIN_PX = 160
// 单次位移的动画行程上限(视口高度的倍数)。超出的部分直接就位,只牵引最后这一段
const JUMP_TRAVEL_RATIO = 0.55
// 触摸惯性:速度按 e^(-t/τ) 衰减,低于阈值停止
const FLING_TAU_SECONDS = 0.38
const FLING_STOP_SPEED = 24
const FLING_MAX_SPEED = 5000

interface LineMotion {
  element: HTMLElement
  spring: SpringState
  target: number
  /** 起步前的剩余等待时间(毫秒),牵引波就来自这里 */
  delayMs: number
  /** 弹簧已经起步且尚未停下。重定向时据此决定要不要重新排延迟 */
  moving: boolean
  onstage: boolean
  lastWritten: string
  /**
   * 和声行的展开程度(0…1)与目标。版面按它连续变化,下面的行 1:1 跟随;
   * 同一个值写到 --lyric-harmony 上驱动裁切 / 淡出 / 模糊,视觉与占位永远同步
   */
  open: SpringState
  openTarget: number
  lastOpenWritten: string
}

// 和声开合的弹簧:临界阻尼(裁切一旦过冲就会露出不该露的一截),约 0.35s 完成
const HARMONY_STIFFNESS = 180
const HARMONY_DAMPING_RATIO = 1
const HARMONY_CONFIG: SpringConfig = {
  stiffness: HARMONY_STIFFNESS,
  damping: 2 * HARMONY_DAMPING_RATIO * Math.sqrt(HARMONY_STIFFNESS),
  mass: 1,
}

function springConfig(stiffness: number, dampingRatio: number, scale: number): SpringConfig {
  const scaled = stiffness * Math.max(0.1, scale)
  return { stiffness: scaled, damping: 2 * dampingRatio * Math.sqrt(scaled), mass: 1 }
}

export function useLyricsEngine(options: LyricsEngineOptions) {
  let motions: LineMotion[] = []
  let heights: number[] = []
  let gaps = { gap: 0, harmonyGap: 0 }
  let viewportHeight = 0
  let layout: LyricLayout = { tops: [], heights: [], total: 0 }
  let scene: LyricsSceneInput | null = null
  let mode: 'follow' | 'browse' = 'follow'
  /** 当前生效的版面偏移:各行 y = tops[i] − offset */
  let offset = 0
  let browseOffset = 0
  let bounds: [number, number] = [0, 0]
  let flingVelocity = 0
  let config = springConfig(FOLLOW_STIFFNESS, FOLLOW_DAMPING_RATIO, 1)
  let frame = 0
  let lastFrameAt = 0

  function write(motion: LineMotion, index: number) {
    const y = motion.spring.value
    const height = layout.heights[index] ?? heights[index] ?? 0
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
    if (scene?.background[index]) {
      const open = motion.open.value.toFixed(3)
      if (open !== motion.lastOpenWritten) {
        motion.lastOpenWritten = open
        motion.element.style.setProperty('--lyric-harmony', open)
      }
    }
  }

  function writeAll() {
    for (const [index, motion] of motions.entries()) write(motion, index)
  }

  /** 行节点与弹簧一一对应;节点被 Vue 重建时沿用不了旧弹簧,从目标位置重新开始 */
  function syncMotions() {
    const elements = options.getLineElements()
    const previous = new Map(motions.map((motion) => [motion.element, motion]))
    const next: LineMotion[] = []
    for (const element of elements) {
      if (!element) continue
      const existing = previous.get(element)
      next.push(
        existing ?? {
          element,
          spring: createSpringState(0, 0),
          target: 0,
          delayMs: 0,
          moving: false,
          onstage: true,
          lastWritten: '',
          open: createSpringState(0, 0),
          openTarget: 0,
          lastOpenWritten: '',
        },
      )
    }
    motions = next
  }

  function stopLoop() {
    if (frame) {
      window.cancelAnimationFrame(frame)
      frame = 0
    }
    lastFrameAt = 0
  }

  function ensureLoop() {
    if (frame) return
    lastFrameAt = 0
    frame = window.requestAnimationFrame(tick)
  }

  function tick() {
    frame = 0
    const now = performance.now()
    const dt = lastFrameAt ? Math.min((now - lastFrameAt) / 1000, 0.25) : 1 / 60
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
    if (stepHarmonies(dt)) busy = true
    for (const [index, motion] of motions.entries()) {
      if (motion.delayMs > 0) {
        // 还没轮到这一行起步:原地停住,保持它被落在后面的样子
        motion.delayMs -= dt * 1000
        busy = true
        continue
      }
      if (isSpringSettled(motion.spring, motion.target)) {
        motion.moving = false
        continue
      }
      stepSpring(motion.spring, motion.target, config, dt)
      if (isSpringSettled(motion.spring, motion.target)) {
        snapSpring(motion.spring, motion.target)
        motion.moving = false
      } else {
        motion.moving = true
        busy = true
      }
      write(motion, index)
    }

    if (busy) frame = window.requestAnimationFrame(tick)
    else stopLoop()
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
      moved = true
    }
    if (!moved) return false
    const before = motions.map((motion) => motion.target)
    computeTargets()
    for (const [index, motion] of motions.entries()) {
      const shift = motion.target - (before[index] ?? motion.target)
      if (shift !== 0) motion.spring.value += shift
      // 被顶动的行多半是静止的,主循环不会再写它们,这里就地写
      if (shift !== 0 || scene?.background[index]) write(motion, index)
    }
    return true
  }

  function offsetFor(index: number): number {
    return lyricFocusOffset(layout, index, viewportHeight, LYRIC_ANCHOR_RATIO)
  }

  function clampBrowse(value: number): number {
    return Math.max(bounds[0], Math.min(bounds[1], value))
  }

  /** 重新排版并算出各行的目标坐标。返回偏移量的变化(正 = 内容上移) */
  function computeTargets(): number {
    const previous = offset
    if (!scene) return 0
    layout = layoutLyricLines({
      heights,
      background: scene.background,
      open: motions.map((motion) => motion.open.value),
      gap: gaps.gap,
      harmonyGap: gaps.harmonyGap,
    })
    bounds = [offsetFor(0), offsetFor(layout.tops.length - 1)]
    if (bounds[1] < bounds[0]) bounds = [bounds[0], bounds[0]]
    if (mode === 'follow') {
      offset = offsetFor(scene.focus)
    } else {
      browseOffset = clampBrowse(browseOffset)
      offset = browseOffset
    }
    for (const [index, motion] of motions.entries()) {
      motion.target = (layout.tops[index] ?? 0) - offset
    }
    return offset - previous
  }

  function snapAll() {
    for (const motion of motions) {
      snapSpring(motion.spring, motion.target)
      motion.delayMs = 0
      motion.moving = false
    }
    writeAll()
  }

  /** 把场景里的和声开合状态交给弹簧;瞬时模式下直接就位并重新排版 */
  function assignHarmonyTargets(animated: boolean) {
    if (!scene) return
    let snapped = false
    for (const [index, motion] of motions.entries()) {
      motion.openTarget = scene.background[index] && scene.open[index] ? 1 : 0
      if (animated || motion.open.value === motion.openTarget) continue
      snapSpring(motion.open, motion.openTarget)
      snapped = true
    }
    if (snapped) computeTargets()
  }

  function retargetUniform() {
    for (const motion of motions) motion.delayMs = 0
    writeAll()
    ensureLoop()
  }

  function retargetStaggered(delta: number, budgetMs = Number.POSITIVE_INFINITY) {
    const travel = Math.max(viewportHeight * JUMP_TRAVEL_RATIO, 1)
    const animated: Array<{ motion: LineMotion; fresh: boolean; ordered: boolean }> = []
    let maxShift = 0

    const onstage = (y: number, height: number, extra = 0) =>
      y + height > -STAGE_MARGIN_PX - extra && y < viewportHeight + STAGE_MARGIN_PX + extra
    const visible = (y: number, height: number) => y + height > 0 && y < viewportHeight

    for (const [index, motion] of motions.entries()) {
      const height = layout.heights[index] ?? 0
      // 行程封顶:跳得太远的行从视口边缘之外重新起步,速度归零。
      // 先封顶再分类 —— 正在离开的可见行封顶后已经在舞台外,不该再占错峰的序号
      const shift = motion.spring.value - motion.target
      let fresh = false
      if (Math.abs(shift) > travel) {
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
        snapSpring(motion.spring, motion.target)
        motion.delayMs = 0
        motion.moving = false
        continue
      }
      const remaining = Math.abs(start - motion.target)
      if (remaining < 0.5 && !motion.moving && motion.delayMs <= 0) {
        snapSpring(motion.spring, motion.target)
        continue
      }
      maxShift = Math.max(maxShift, remaining)
      animated.push({ motion, fresh, ordered })
    }

    // 错峰间隔:相邻行的最大靠近量 ≈ 峰值速度 × 间隔,不得超过一个行距
    const omega = Math.sqrt(config.stiffness / (config.mass ?? 1))
    const peakSpeed = PEAK_SPEED_RATIO * omega * maxShift
    const allowance = Math.max(gaps.gap, 8)
    let stepMs =
      peakSpeed > 0 ? Math.min(DELAY_STEP_MS, (allowance / peakSpeed) * 1000) : DELAY_STEP_MS
    // 整道波(最多 MAX_DELAY_ORDER 级)要在下一次换行之前的一半时间内全部起步
    if (Number.isFinite(budgetMs) && budgetMs > 0) {
      stepMs = Math.min(stepMs, (budgetMs * 0.5) / MAX_DELAY_ORDER)
    }

    // 内容上移(delta ≥ 0,包括和声展开把下面的行往下顶)时最上面的行先动;
    // 内容下移时最下面的行先动。animated 本身就是版面自上而下的顺序
    const topFirst = delta >= 0
    const ordered = animated.filter((entry) => entry.ordered)
    const delays = new Map<LineMotion, number>()
    for (const [position, entry] of ordered.entries()) {
      const order = topFirst ? position : ordered.length - 1 - position
      delays.set(entry.motion, Math.min(order, MAX_DELAY_ORDER) * stepMs)
    }
    // 舞台外那一圈:上方的跟最上面的可见行,下方的跟最下面的可见行
    const firstDelay = ordered.length ? delays.get(ordered[0]!.motion)! : 0
    const lastDelay = ordered.length ? delays.get(ordered[ordered.length - 1]!.motion)! : 0
    let passedOrdered = false
    for (const entry of animated) {
      if (entry.ordered) passedOrdered = true
      const delayMs = delays.get(entry.motion) ?? (passedOrdered ? lastDelay : firstDelay)
      // 已经起步的行保持起步:连续换行时再把它按住,它会卡在半空。
      // 还在等的行按本批次的顺序重新排延迟,一批之内等待时间严格随行序递增
      if (!entry.fresh && entry.motion.moving) continue
      // 还在等的行只会等得更短:连续换行时每次都重排满延迟,它会被无限期推迟,
      // 表现就是活跃行一直追不到锚点
      entry.motion.delayMs =
        entry.fresh || entry.motion.delayMs <= 0 ? delayMs : Math.min(entry.motion.delayMs, delayMs)
    }

    writeAll()
    if (animated.length) ensureLoop()
  }

  function apply(transition: LyricsTransition, budgetMs = Number.POSITIVE_INFINITY) {
    const animated = transition !== 'none' && options.isAnimated()
    const delta = computeTargets()
    assignHarmonyTargets(animated)
    if (!animated) {
      snapAll()
      return
    }
    // 快段落里弹簧本身也要跟得上:收敛时间(约 4 / (ζω))不能超过到下一行的间隔,
    // 否则每行只走到一半就被下一行接管,活跃行永远停在锚点下方追不上来
    let scale = options.getSpringScale()
    if (Number.isFinite(budgetMs) && budgetMs > 0) {
      const omega = Math.sqrt(FOLLOW_STIFFNESS * scale)
      const needed = 4 / (FOLLOW_DAMPING_RATIO * (budgetMs / 1000))
      if (needed > omega) scale *= (needed / omega) ** 2
    }
    config = springConfig(FOLLOW_STIFFNESS, FOLLOW_DAMPING_RATIO, scale)
    retargetStaggered(delta, budgetMs)
    ensureLoop()
  }

  function shiftBrowse(delta: number, browseOptions: BrowseOptions) {
    if (mode !== 'browse') {
      mode = 'browse'
      browseOffset = offset
    }
    browseOffset = clampBrowse(browseOffset + delta)
    computeTargets()
    if (browseOptions.snap || !options.isAnimated()) {
      snapAll()
      return
    }
    config = springConfig(BROWSE_STIFFNESS, BROWSE_DAMPING_RATIO, 1)
    retargetUniform()
  }

  // ---- 对外接口 ----

  /** 重新测量视口与各行高度、读取间距,然后按当前场景瞬时就位 */
  function remeasure() {
    const viewport = options.getViewport()
    if (!viewport) return
    syncMotions()
    viewportHeight = viewport.clientHeight
    gaps = options.getGaps()
    heights = motions.map((motion) => motion.element.offsetHeight)
    if (scene) apply('none')
  }

  function setScene(
    next: LyricsSceneInput,
    transition: LyricsTransition,
    sceneOptions: SetSceneOptions = {},
  ) {
    scene = next
    if (sceneOptions.follow) {
      mode = 'follow'
      flingVelocity = 0
    }
    syncMotions()
    // 还没量过(第一次就绪)或行数对不上(列表重建):先补一次测量,这一次瞬时就位
    if (!viewportHeight || heights.length !== motions.length) {
      remeasure()
      return
    }
    apply(transition, sceneOptions.budgetMs)
  }

  /** 退出浏览模式,锚点行回到视口锚点位置 */
  function follow(transition: LyricsTransition = 'spring') {
    if (!scene) return
    mode = 'follow'
    flingVelocity = 0
    apply(transition)
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
    const motion = motions[index]
    if (!motion || !scene) return false
    const height = layout.heights[index] ?? 0
    const top = viewportHeight * 0.12
    const bottom = viewportHeight * 0.88
    let delta = 0
    if (motion.target < top) delta = motion.target - top
    else if (motion.target + height > bottom) delta = motion.target + height - bottom
    if (Math.abs(delta) < 1) return false
    browseBy(delta)
    return true
  }

  /** 立即结束所有位移,各行回到目标位置(关闭动效 / 切歌 / 卸载) */
  function cancel() {
    stopLoop()
    flingVelocity = 0
    for (const motion of motions) snapSpring(motion.open, motion.openTarget)
    if (scene) computeTargets()
    for (const motion of motions) {
      if (!motion.element.isConnected) continue
      snapSpring(motion.spring, motion.target)
      motion.delayMs = 0
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
    layout = { tops: [], heights: [], total: 0 }
    scene = null
    mode = 'follow'
    offset = 0
    browseOffset = 0
  }

  function isBrowsing(): boolean {
    return mode === 'browse'
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
    setScene,
    follow,
    browseBy,
    fling,
    reveal,
    cancel,
    reset,
    isBrowsing,
    targets,
  }
}
