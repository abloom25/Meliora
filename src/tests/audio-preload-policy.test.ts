import { describe, expect, it } from 'vitest'
import {
  FAILED_TRACK_RETRY_MS,
  createTrackFailureLog,
  predictPreloadTrack,
} from '../core/audio/preload'
import type { QueueState } from '../core/audio/queue'
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

function state(currentIndex: number, playMode: PlayMode, count = 5): QueueState {
  return { queue: makeQueue(count), currentIndex, playMode }
}

const never = () => false

describe('track failure log', () => {
  it('remembers a failure and lets the track retry after the window', () => {
    let now = 1000
    const log = createTrackFailureLog({ now: () => now })

    log.mark('t1')
    expect(log.isFailed('t1')).toBe(true)
    expect(log.size).toBe(1)

    now += FAILED_TRACK_RETRY_MS + 1
    // 过了重试窗口放行一次,免得一次网络抖动把曲目拉黑整场
    expect(log.isFailed('t1')).toBe(false)
    expect(log.size).toBe(0)
  })

  it('restarts the window when the track fails again', () => {
    let now = 0
    const log = createTrackFailureLog({ retryAfterMs: 100, now: () => now })
    log.mark('t1')
    now = 150
    expect(log.isFailed('t1')).toBe(false)
    log.mark('t1')
    now = 200
    expect(log.isFailed('t1')).toBe(true)
  })

  it('forgets one track or all of them on demand', () => {
    const log = createTrackFailureLog()
    log.mark('a')
    log.mark('b')
    log.clear('a')
    expect(log.isFailed('a')).toBe(false)
    expect(log.isFailed('b')).toBe(true)
    log.clearAll()
    expect(log.isFailed('b')).toBe(false)
  })
})

describe('preload prediction', () => {
  it('follows the same rules the real track change will follow', () => {
    expect(
      predictPreloadTrack(state(1, 'loop'), 't1', 'next', { manual: false, isFailed: never })?.id,
    ).toBe('t2')
    expect(
      predictPreloadTrack(state(1, 'loop'), 't1', 'previous', { manual: false, isFailed: never })
        ?.id,
    ).toBe('t0')
  })

  it('reuses whatever the slot already holds', () => {
    const cached = makeQueue(5)[4]!
    const picked = predictPreloadTrack(state(1, 'loop'), 't1', 'next', {
      manual: false,
      isFailed: never,
      cachedTrack: cached,
    })
    expect(picked?.id).toBe('t4')
  })

  it('ignores a cached slot holding the current track or a failed one', () => {
    const queue = makeQueue(5)
    // 缓存的就是当前这首:没有意义,重新预测
    expect(
      predictPreloadTrack(state(1, 'loop'), 't1', 'next', {
        manual: false,
        isFailed: never,
        cachedTrack: queue[1]!,
      })?.id,
    ).toBe('t2')
    expect(
      predictPreloadTrack(state(1, 'loop'), 't1', 'next', {
        manual: false,
        isFailed: (id) => id === 't4',
        cachedTrack: queue[4]!,
      })?.id,
    ).toBe('t2')
  })

  it('walks past failed tracks to the next usable one', () => {
    const picked = predictPreloadTrack(state(0, 'loop'), 't0', 'next', {
      manual: false,
      isFailed: (id) => id === 't1' || id === 't2',
    })
    expect(picked?.id).toBe('t3')
  })

  it('stops at the end of the queue in sequence mode rather than wrapping', () => {
    const picked = predictPreloadTrack(state(3, 'sequence'), 't3', 'next', {
      manual: false,
      isFailed: (id) => id === 't4',
    })
    expect(picked).toBeNull()
  })

  it('repeats the current track for single mode auto-advance and gives up if it failed', () => {
    expect(
      predictPreloadTrack(state(2, 'single'), 't2', 'next', { manual: false, isFailed: never })?.id,
    ).toBe('t2')
    expect(
      predictPreloadTrack(state(2, 'single'), 't2', 'next', {
        manual: false,
        isFailed: (id) => id === 't2',
      }),
    ).toBeNull()
  })

  it('picks any healthy track other than the current one in shuffle mode', () => {
    const picked = predictPreloadTrack(state(0, 'shuffle'), 't0', 'next', {
      manual: false,
      // 先让抽到的那首算作失败,逼它走兜底
      isFailed: (id) => id !== 't3' && id !== 't0',
      random: () => 0.4,
    })
    expect(picked?.id).toBe('t3')
  })

  it('starts from the first healthy track when nothing is playing yet', () => {
    const picked = predictPreloadTrack(state(-1, 'loop'), null, 'next', {
      manual: false,
      isFailed: (id) => id === 't0',
    })
    expect(picked?.id).toBe('t1')
  })

  it('has nothing to predict from an empty queue', () => {
    const empty: QueueState = { queue: [], currentIndex: -1, playMode: 'loop' }
    expect(predictPreloadTrack(empty, null, 'next', { manual: false, isFailed: never })).toBeNull()
  })
})
