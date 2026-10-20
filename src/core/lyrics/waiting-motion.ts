import type { LyricWaitingInterval } from './interlude'

export interface LyricWaitingMotion {
  opacity: number
  scale: number
  dotOpacities: readonly [number, number, number]
}

const EXIT_SECONDS = 1
const ENTER_SECONDS = 0.18
const DOT_ENTER_SECONDS = 0.75
const DOT_STAGGER_SECONDS = 0.08
const BREATH_SECONDS = 4
const MIN_BREATH_BODY_SECONDS = 3

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function smooth(value: number): number {
  const progress = clamp(value)
  return progress * progress * (3 - 2 * progress)
}

function hidden(): LyricWaitingMotion {
  return { opacity: 0, scale: 1, dotOpacities: [0, 0, 0] }
}

/**
 * 等待点以媒体时间演出，宿主暂停、seek 或恢复可见性后直接求当前帧。
 * 三点依次点亮；长空档伴随整组呼吸，末一秒先蓄力再缩小淡出。
 * 不保存墙钟状态，也不创建定时器；关闭动画时只保留静态等待标记。
 */
export function resolveLyricWaitingMotion(
  timeSeconds: number,
  interval: LyricWaitingInterval,
  animated = true,
): LyricWaitingMotion {
  const duration = interval.end - interval.start
  if (
    !Number.isFinite(timeSeconds) ||
    !Number.isFinite(interval.start) ||
    !Number.isFinite(interval.end) ||
    duration <= 0 ||
    timeSeconds < interval.start ||
    timeSeconds >= interval.end
  )
    return hidden()

  if (!animated) return { opacity: 1, scale: 1, dotOpacities: [0.65, 0.65, 0.65] }

  const elapsed = timeSeconds - interval.start
  // 正常前奏/间奏远长于一秒；短区间仍保留主体，避免退出时长反过来超过整个区间。
  const exitDuration = Math.min(EXIT_SECONDS, duration / 2)
  const bodyDuration = duration - exitDuration
  const breathing = bodyDuration >= MIN_BREATH_BODY_SECONDS
  const segment = (bodyDuration + exitDuration * 0.75) / 3
  const thirdTarget = clamp((bodyDuration - segment * 2) / segment)
  let scale = 1
  let opacity = smooth(elapsed / ENTER_SECONDS)
  let fractions: readonly [number, number, number]

  if (elapsed >= bodyDuration) {
    const exitProgress = (elapsed - bodyDuration) / exitDuration
    // 在主体结束时回到 1，保证呼吸与退出没有尺度跳变。
    scale =
      exitProgress < 0.75
        ? 1 + 0.25 * smooth(exitProgress / 0.75)
        : 1.25 - 0.85 * smooth((exitProgress - 0.75) / 0.25)
    opacity *= 1 - smooth((exitProgress - 0.75) / 0.25)
    fractions = [
      1,
      1,
      breathing ? thirdTarget + (1 - thirdTarget) * smooth(exitProgress / 0.75) : 1,
    ]
  } else if (breathing) {
    const cycles = Math.max(1, Math.floor(bodyDuration / BREATH_SECONDS))
    const phase = (elapsed / bodyDuration) * cycles * Math.PI * 2
    scale = 1 + (1 - Math.cos(phase)) * 0.125
    fractions = [
      smooth(elapsed / segment),
      smooth((elapsed - segment) / segment),
      thirdTarget * smooth((elapsed - segment * 2) / (bodyDuration - segment * 2)),
    ]
  } else {
    // 短前奏保留进入、点亮与退出，不挤入一轮来不及完成的呼吸。
    fractions = [1, 1, 1]
  }

  function dot(index: 0 | 1 | 2): number {
    const enter = clamp((elapsed - index * DOT_STAGGER_SECONDS) / DOT_ENTER_SECONDS)
    return (0.2 + 0.7 * fractions[index]) * enter * enter
  }

  return { opacity, scale, dotOpacities: [dot(0), dot(1), dot(2)] }
}
