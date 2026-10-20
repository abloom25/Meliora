// 与播放位置有关的规则:跳转、自动交叉淡入淡出的触发时机、"上一首"的语义。
// 都是纯函数,换后端不用重写。

import { CROSSFADE_DURATION_MS } from './fade'

/** 按下「上一首」时,播放位置超过这么久就理解成"重播本曲"而不是"回上一首" */
export const RESTART_INSTEAD_OF_PREVIOUS_SECONDS = 5

export type SeekResolution =
  /** 时长已知,直接落到这个位置 */
  | { kind: 'apply'; time: number }
  /** 时长还不知道,先记下来,等时长可用再落位 */
  | { kind: 'pending'; time: number }
  /** 无效输入,什么都别做 */
  | { kind: 'ignore' }

/**
 * 解析一次跳转请求。
 *
 * 时长未知时不能直接写位置(Web 端 <audio> 在 metadata 就绪前写 currentTime 无效),
 * 但界面要立刻反映用户的意图,所以这里把"记下来"和"落位"分成两种结果。
 */
export function resolveSeek(target: number, duration: number | null): SeekResolution {
  if (!Number.isFinite(target)) return { kind: 'ignore' }
  const time = Math.max(0, target)
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    return { kind: 'pending', time }
  }
  return { kind: 'apply', time: Math.min(time, duration) }
}

export interface AutoCrossfadeContext {
  /** 用户开了「平滑切歌」 */
  smoothTrackChange: boolean
  /** 下一首已经预加载好了。没准备好就别提前切,否则是一段静音 */
  nextTrackReady: boolean
  /** 本曲已经触发过一次,不要重复触发 */
  alreadyStarted: boolean
  /** 平台是否支持同时播两路(iOS 后台安全模式下只有一路) */
  supportsOverlap: boolean
}

/**
 * 是否该现在开始与下一首交叉淡入淡出。
 * 提前量正好是一次交叉淡入淡出的时长,这样淡出结束的时刻就是本曲的自然结尾。
 */
export function shouldStartAutoCrossfade(
  currentTime: number,
  duration: number | null,
  context: AutoCrossfadeContext,
): boolean {
  if (!context.smoothTrackChange || !context.supportsOverlap) return false
  if (!context.nextTrackReady || context.alreadyStarted) return false
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return false
  return duration - currentTime <= CROSSFADE_DURATION_MS / 1000
}

/** 「上一首」到底该重播本曲还是真的回退 */
export function previousMeansRestart(currentTime: number): boolean {
  return currentTime > RESTART_INSTEAD_OF_PREVIOUS_SECONDS
}
