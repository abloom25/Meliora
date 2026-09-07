// 弹簧积分器:歌词滚动、逐字弹跳等"可被随时打断"的动画统一走这里。
//
// 关键帧动画(WAAPI / CSS transition)在被打断时会丢失速度——新动画从 0 速度重新起步,
// 于是每次打断都产生一次可见的速度不连续,视觉上就是顿挫。弹簧只有"当前位置 + 当前速度
// + 目标位置"三个状态,改目标不改速度,因此天然可打断、可重定向,连续性由物理保证。

export interface SpringState {
  value: number
  velocity: number
}

export interface SpringConfig {
  /** 刚度:越大越快到位 */
  stiffness: number
  /** 阻尼:临界阻尼值为 2 * sqrt(stiffness * mass),低于该值会回弹 */
  damping: number
  /** 质量,默认 1 */
  mass?: number
}

// 单步积分的最大时长。dt 超过该值时拆成多个子步,
// 避免低帧率(切后台恢复、长任务)下显式积分发散成剧烈震荡
const MAX_SUB_STEP_SECONDS = 1 / 120
// dt 超过该值视为"这一帧根本没渲染",直接吸附到目标而不是积分整段时长
const MAX_INTEGRATION_SECONDS = 0.25

export function createSpringState(value = 0, velocity = 0): SpringState {
  return { value, velocity }
}

/**
 * 就地推进弹簧一帧。返回同一个 state 对象(避免每帧分配)。
 * dt 单位为秒;超过 MAX_INTEGRATION_SECONDS 时直接吸附,防止后台恢复后飞出去。
 */
export function stepSpring(
  state: SpringState,
  target: number,
  config: SpringConfig,
  dt: number,
): SpringState {
  if (!Number.isFinite(dt) || dt <= 0) return state
  if (dt > MAX_INTEGRATION_SECONDS) {
    state.value = target
    state.velocity = 0
    return state
  }

  const mass = config.mass ?? 1
  const stiffness = config.stiffness
  const damping = config.damping
  let remaining = dt

  // 半隐式欧拉:先更新速度再用新速度更新位置,比显式欧拉稳定得多
  while (remaining > 0) {
    const step = Math.min(remaining, MAX_SUB_STEP_SECONDS)
    remaining -= step
    const acceleration = (-stiffness * (state.value - target) - damping * state.velocity) / mass
    state.velocity += acceleration * step
    state.value += state.velocity * step
  }

  return state
}

/** 位置与速度同时进入阈值内才算静止,只看位置会在过冲顶点误判 */
export function isSpringSettled(
  state: SpringState,
  target: number,
  valueEpsilon = 0.35,
  velocityEpsilon = 0.35,
): boolean {
  return (
    Math.abs(state.value - target) <= valueEpsilon && Math.abs(state.velocity) <= velocityEpsilon
  )
}

/** 直接吸附到目标并清零速度,用于瞬移(减弱动效、用户滚动接管、切歌) */
export function snapSpring(state: SpringState, target: number): SpringState {
  state.value = target
  state.velocity = 0
  return state
}

/**
 * 由"目标停顿时长 + 阻尼比"反推刚度/阻尼,让调参用可理解的量而不是魔法数字。
 * dampingRatio = 1 为临界阻尼(不过冲),< 1 会回弹,> 1 过阻尼。
 */
export function springFromDuration(durationSeconds: number, dampingRatio: number): SpringConfig {
  // 以自然频率 ω = 2π / duration 为基准,duration 近似为一个自由振荡周期
  const omega = (2 * Math.PI) / Math.max(durationSeconds, 0.05)
  return {
    stiffness: omega * omega,
    damping: 2 * dampingRatio * omega,
    mass: 1,
  }
}
