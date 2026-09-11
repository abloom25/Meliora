// 预加载的**策略**:预测下一首/上一首该提前准备哪一首,以及哪些曲目暂时不能用。
//
// "怎么预加载"是平台的事(Web 端把 src 挂到备用 <audio> 上等 canplay,
// 桌面端可能是让原生后端预热解码),"预加载谁"则完全由队列、播放模式和失败记录决定,
// 所以放在核心层。

import type { Track } from '../types'
import { selectNextTrack, selectPreviousTrack, type QueueState } from './queue'

/** 失败标记的重试窗口:超过后放行一次,免得一次瞬时网络抖动把曲目拉黑整个会话 */
export const FAILED_TRACK_RETRY_MS = 5 * 60 * 1000

export interface TrackFailureLog {
  mark(id: string): void
  clear(id: string): void
  clearAll(): void
  isFailed(id: string): boolean
  readonly size: number
}

export interface TrackFailureLogOptions {
  retryAfterMs?: number
  /** 时间源,便于测试。缺省 Date.now */
  now?: () => number
}

export function createTrackFailureLog(options: TrackFailureLogOptions = {}): TrackFailureLog {
  const retryAfterMs = options.retryAfterMs ?? FAILED_TRACK_RETRY_MS
  const now = options.now ?? Date.now
  const failedAt = new Map<string, number>()

  return {
    mark(id) {
      failedAt.set(id, now())
    },
    clear(id) {
      failedAt.delete(id)
    },
    clearAll() {
      failedAt.clear()
    },
    isFailed(id) {
      const at = failedAt.get(id)
      if (at === undefined) return false
      if (now() - at > retryAfterMs) {
        // 过了重试窗口就放行一次;若再次失败会由 mark 重新计时
        failedAt.delete(id)
        return false
      }
      return true
    },
    get size() {
      return failedAt.size
    },
  }
}

export type PreloadDirection = 'previous' | 'next'

export interface PredictPreloadOptions {
  /** 用户手动切歌。影响单曲循环:自动续播重复本曲,手动则往后走 */
  manual: boolean
  isFailed: (id: string) => boolean
  /** 该方向的槽位里已经准备好的曲目,命中就不必重新预测 */
  cachedTrack?: Track | null
  random?: () => number
}

function isUsableCache(
  cached: Track | null | undefined,
  currentTrackId: string | null,
  isFailed: (id: string) => boolean,
): cached is Track {
  if (!cached) return false
  return cached.id !== currentTrackId && !isFailed(cached.id)
}

/**
 * 按顺序往一个方向找第一首还能用的曲目。
 * 顺序播放模式不绕回;其余模式绕回队列另一端
 */
function scanForUsableTrack(
  state: QueueState,
  direction: PreloadDirection,
  options: PredictPreloadOptions,
): Track | null {
  const { queue, currentIndex, playMode } = state
  if (!queue.length) return null
  if (currentIndex < 0) return queue.find((track) => !options.isFailed(track.id)) ?? null

  // 单曲循环的自动续播就是重复本曲;它自己也失败了就没得放了
  if (direction === 'next' && playMode === 'single' && !options.manual) {
    const current = queue[currentIndex]
    return current && !options.isFailed(current.id) ? current : null
  }

  const step = direction === 'next' ? 1 : -1
  const wraps = playMode !== 'sequence'
  for (let offset = 1; offset <= queue.length; offset += 1) {
    const raw = currentIndex + step * offset
    if (!wraps && (raw < 0 || raw >= queue.length)) return null
    const index = ((raw % queue.length) + queue.length) % queue.length
    const candidate = queue[index]
    if (candidate && !options.isFailed(candidate.id)) return candidate
  }
  return null
}

/** 预测失败后的兜底。随机模式下任取一首不是当前、也没失败的 */
function fallbackTrack(
  state: QueueState,
  direction: PreloadDirection,
  currentTrackId: string | null,
  options: PredictPreloadOptions,
): Track | null {
  if (state.playMode === 'shuffle') {
    return (
      state.queue.find((track) => track.id !== currentTrackId && !options.isFailed(track.id)) ??
      null
    )
  }
  return scanForUsableTrack(state, direction, options)
}

/**
 * 该方向上应当提前准备哪一首。
 *
 * 与真正切歌时的选曲走同一套规则(core/audio/queue),否则预加载的和实际播的会对不上 ——
 * 随机模式下尤其明显:两次独立抽样几乎必然抽到不同的曲目,预加载就白做了。
 */
export function predictPreloadTrack(
  state: QueueState,
  currentTrackId: string | null,
  direction: PreloadDirection,
  options: PredictPreloadOptions,
): Track | null {
  if (!state.queue.length) return null

  // 槽位里已经准备好的那首优先复用,免得每次都重新预测
  if (isUsableCache(options.cachedTrack, currentTrackId, options.isFailed)) {
    return options.cachedTrack
  }

  const predicted =
    direction === 'next'
      ? selectNextTrack(state, { manual: options.manual, random: options.random })
      : selectPreviousTrack(state)
  if (!predicted) return null
  if (!options.isFailed(predicted.id)) return predicted
  return fallbackTrack(state, direction, currentTrackId, options)
}
