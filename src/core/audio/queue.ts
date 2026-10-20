// 播放队列的选曲规则:下一首 / 上一首是谁,完全由队列、当前位置与播放模式决定。
//
// 这里是纯函数,不碰状态、不碰播放器 —— 桌面端换成原生音频后端后,这套规则原样复用,
// 只有"怎么播"要重写,"播哪首"不用。随机数从外面传进来,便于测试固定序列。

import type { PlayMode, Track } from '../types'

export interface QueueState {
  queue: readonly Track[]
  /** 当前曲目在队列里的下标;不在队列中(或没有当前曲目)时为 -1 */
  currentIndex: number
  playMode: PlayMode
}

export interface NextTrackOptions {
  /** 用户手动切歌。单曲循环只在**自动**续播时才重复当前这首,手动下一首要真的往后走 */
  manual: boolean
  /** 随机源,缺省用 Math.random。范围 [0, 1) */
  random?: () => number
}

export const PLAY_MODES: readonly PlayMode[] = ['sequence', 'loop', 'single', 'shuffle']

/** 播放模式的循环顺序,用于「切换播放模式」按钮 */
export function nextPlayMode(mode: PlayMode): PlayMode {
  const index = PLAY_MODES.indexOf(mode)
  return PLAY_MODES[(index + 1) % PLAY_MODES.length] ?? 'loop'
}

function currentTrackOf(state: QueueState): Track | null {
  if (state.currentIndex < 0) return null
  return state.queue[state.currentIndex] ?? null
}

/**
 * 随机模式下的下一首:避开当前这首。
 * 队列只有一首时没得挑,直接返回它,否则这里会死循环
 */
function pickShuffled(state: QueueState, random: () => number): Track | null {
  const total = state.queue.length
  if (total <= 1) return state.queue[0] ?? null
  let index = state.currentIndex
  while (index === state.currentIndex) index = Math.floor(random() * total)
  return state.queue[index] ?? null
}

export function selectNextTrack(state: QueueState, options: NextTrackOptions): Track | null {
  if (!state.queue.length) return null
  const current = currentTrackOf(state)
  if (state.playMode === 'single' && !options.manual && current) return current
  if (state.playMode === 'shuffle') return pickShuffled(state, options.random ?? Math.random)

  const index = state.currentIndex + 1
  if (index < state.queue.length) return state.queue[index] ?? null
  // 走到队尾:顺序播放就此停下,其余模式回到开头
  if (state.playMode === 'sequence') return null
  return state.queue[0] ?? null
}

/** 上一首。走到队首则绕回队尾;没有当前曲目时(-1)同样落在队尾 */
export function selectPreviousTrack(state: QueueState): Track | null {
  if (!state.queue.length) return null
  const index = state.currentIndex - 1
  return state.queue[index < 0 ? state.queue.length - 1 : index] ?? null
}
