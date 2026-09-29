import { describe, expect, it } from 'vitest'
import {
  PLAY_MODES,
  nextPlayMode,
  selectNextTrack,
  selectPreviousTrack,
  type QueueState,
} from '../core/audio/queue'
import type { PlayMode, Track } from '../core/types'

function makeQueue(count: number): Track[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index}`,
    title: `Track ${index}`,
    artist: 'Meliora',
    audioUrl: `/music/${index}.mp3`,
    kind: 'local' as const,
  }))
}

function state(currentIndex: number, playMode: PlayMode, count = 4): QueueState {
  return { queue: makeQueue(count), currentIndex, playMode }
}

describe('selectNextTrack', () => {
  it('walks forward in every mode that is not single or shuffle', () => {
    expect(selectNextTrack(state(0, 'sequence'), { manual: false })?.id).toBe('t1')
    expect(selectNextTrack(state(0, 'loop'), { manual: false })?.id).toBe('t1')
  })

  it('stops at the end of the queue in sequence mode but wraps in loop mode', () => {
    expect(selectNextTrack(state(3, 'sequence'), { manual: false })).toBeNull()
    expect(selectNextTrack(state(3, 'loop'), { manual: false })?.id).toBe('t0')
  })

  it('repeats the current track only when single mode advances on its own', () => {
    // 自动续播时单曲循环重复本曲,用户手动点下一首则必须真的往后走
    expect(selectNextTrack(state(1, 'single'), { manual: false })?.id).toBe('t1')
    expect(selectNextTrack(state(1, 'single'), { manual: true })?.id).toBe('t2')
  })

  it('never repeats the current track in shuffle mode', () => {
    const values = [0.25, 0.25, 0.9]
    let call = 0
    const picked = selectNextTrack(state(1, 'shuffle'), {
      manual: false,
      random: () => values[call++] ?? 0,
    })
    // 0.25 × 4 = 1 就是当前这首,必须重摇
    expect(picked?.id).toBe('t3')
  })

  it('returns the only track instead of looping forever when shuffle has nothing else', () => {
    expect(selectNextTrack(state(0, 'shuffle', 1), { manual: false })?.id).toBe('t0')
  })

  it('starts from the head when there is no current track', () => {
    expect(selectNextTrack(state(-1, 'sequence'), { manual: false })?.id).toBe('t0')
    expect(selectNextTrack(state(-1, 'single'), { manual: false })?.id).toBe('t0')
  })

  it('has nothing to pick from an empty queue', () => {
    const empty: QueueState = { queue: [], currentIndex: -1, playMode: 'loop' }
    expect(selectNextTrack(empty, { manual: true })).toBeNull()
    expect(selectPreviousTrack(empty)).toBeNull()
  })
})

describe('selectPreviousTrack', () => {
  it('walks backward and wraps to the tail at the head', () => {
    expect(selectPreviousTrack(state(2, 'loop'))?.id).toBe('t1')
    expect(selectPreviousTrack(state(0, 'loop'))?.id).toBe('t3')
  })

  it('lands on the tail when there is no current track', () => {
    // -1 的上一首是队尾,而不是 (-1-1+len)%len 算出来的倒数第二首
    expect(selectPreviousTrack(state(-1, 'loop'))?.id).toBe('t3')
  })
})

describe('nextPlayMode', () => {
  it('cycles through every mode and comes back around', () => {
    const seen = [nextPlayMode('sequence'), nextPlayMode('loop'), nextPlayMode('single')]
    expect(seen).toEqual(['loop', 'single', 'shuffle'])
    expect(nextPlayMode('shuffle')).toBe('sequence')
    expect(new Set(PLAY_MODES).size).toBe(PLAY_MODES.length)
  })
})
