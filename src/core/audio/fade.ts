// 淡入淡出的时长与曲线。纯数学,不碰任何播放器。
//
// 交叉淡入淡出在 Web 端是同时改两个 <audio> 的 volume,在桌面端可能是两路原生通道的
// 增益,但"用什么曲线、走多久、两路各自到多少"是同一套规则,所以放在核心层。

/** 切歌交叉淡入淡出的总时长(毫秒)。自动续播的提前量也按它算 */
export const CROSSFADE_DURATION_MS = 650
/** 手动切歌时旧曲目的淡出时长 */
export const FADE_OUT_DURATION_MS = 180
/** 新曲目单独淡入的时长(没有旧曲目可交叉时) */
export const FADE_IN_DURATION_MS = 360

/**
 * smoothstep 缓动。两端斜率为 0,听感上不会有"突然开始/突然停住"的棱角;
 * 线性淡入淡出在交叉处会有明显的音量凹陷
 */
export function fadeEasing(progress: number): number {
  const clamped = progress <= 0 ? 0 : progress >= 1 ? 1 : progress
  return clamped * clamped * (3 - 2 * clamped)
}

/** 动画进度对应的原始比例(0…1)。duration <= 0 时视为已完成 */
export function fadeProgress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1
  const raw = elapsedMs / durationMs
  return raw <= 0 ? 0 : raw >= 1 ? 1 : raw
}

/** 交叉淡入淡出中两路各自的增益。旧的退、新的进,任意时刻两者相加接近 1 */
export function crossfadeGains(progress: number): { outgoing: number; incoming: number } {
  const eased = fadeEasing(progress)
  return { outgoing: 1 - eased, incoming: eased }
}

/** 单路淡入/淡出到目标增益 */
export function fadeGain(from: number, to: number, progress: number): number {
  return from + (to - from) * fadeEasing(progress)
}
