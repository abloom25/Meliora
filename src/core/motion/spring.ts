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
  const frequencySquared = config.stiffness / mass
  const decayRate = config.damping / (2 * mass)
  const displacement = state.value - target
  const velocity = state.velocity
  const discriminant = decayRate * decayRate - frequencySquared

  // 在这一帧内目标与参数不变，直接求阻尼振子的闭式解。
  // Euler 子步会在不同刷新率下产生不同的额外阻尼，且第一步位移偏大；
  // 闭式解只依赖真实经过的时间，掉帧或 60/120Hz 切换时仍沿同一条轨迹。
  if (Math.abs(discriminant) <= frequencySquared * 1e-8) {
    const decay = Math.exp(-decayRate * dt)
    const coefficient = velocity + decayRate * displacement
    state.value = target + decay * (displacement + coefficient * dt)
    state.velocity = decay * (velocity - decayRate * coefficient * dt)
  } else if (discriminant < 0) {
    const frequency = Math.sqrt(-discriminant)
    const decay = Math.exp(-decayRate * dt)
    const sine = Math.sin(frequency * dt) / frequency
    const cosine = Math.cos(frequency * dt)
    state.value =
      target + decay * (displacement * cosine + (velocity + decayRate * displacement) * sine)
    state.velocity =
      decay * (velocity * cosine - (decayRate * velocity + frequencySquared * displacement) * sine)
  } else {
    const root = Math.sqrt(discriminant)
    // 用乘积关系求慢根，避免高阻尼下两个近似相等的数相减丢失精度。
    const fastRate = -decayRate - root
    const slowRate = frequencySquared / fastRate
    const slow = (velocity - fastRate * displacement) / (slowRate - fastRate)
    const fast = displacement - slow
    const slowDecay = slow * Math.exp(slowRate * dt)
    const fastDecay = fast * Math.exp(fastRate * dt)
    state.value = target + slowDecay + fastDecay
    state.velocity = slowRate * slowDecay + fastRate * fastDecay
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
