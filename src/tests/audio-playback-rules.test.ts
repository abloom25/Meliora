import { describe, expect, it } from 'vitest'
import {
  CROSSFADE_DURATION_MS,
  crossfadeGains,
  fadeEasing,
  fadeGain,
  fadeProgress,
} from '../core/audio/fade'
import {
  SKIP_NOTICE,
  describePlaybackFailure,
  resolveFailureAction,
  type PlaybackFailureReason,
} from '../core/audio/failure'
import { previousMeansRestart, resolveSeek, shouldStartAutoCrossfade } from '../core/audio/timeline'

describe('fade curve', () => {
  it('starts and ends flat so the fade has no audible corners', () => {
    expect(fadeEasing(0)).toBe(0)
    expect(fadeEasing(1)).toBe(1)
    expect(fadeEasing(0.5)).toBeCloseTo(0.5, 6)
    // 两端斜率为 0:靠近端点时变化量远小于中段
    const nearStart = fadeEasing(0.05) - fadeEasing(0)
    const middle = fadeEasing(0.55) - fadeEasing(0.5)
    expect(nearStart).toBeLessThan(middle / 4)
  })

  it('clamps progress outside the animation window', () => {
    expect(fadeEasing(-1)).toBe(0)
    expect(fadeEasing(2)).toBe(1)
    expect(fadeProgress(-10, 500)).toBe(0)
    expect(fadeProgress(900, 500)).toBe(1)
    expect(fadeProgress(250, 500)).toBeCloseTo(0.5, 6)
    // 时长为 0 视为已完成,不能除出 Infinity
    expect(fadeProgress(0, 0)).toBe(1)
  })

  it('keeps the two crossfaded channels summing to about one', () => {
    for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
      const { outgoing, incoming } = crossfadeGains(progress)
      expect(outgoing + incoming).toBeCloseTo(1, 6)
    }
    expect(crossfadeGains(0).outgoing).toBe(1)
    expect(crossfadeGains(1).incoming).toBe(1)
  })

  it('walks a single channel from one gain to another', () => {
    expect(fadeGain(0.4, 0, 0)).toBeCloseTo(0.4, 6)
    expect(fadeGain(0.4, 0, 1)).toBeCloseTo(0, 6)
    expect(fadeGain(0, 1, 0.5)).toBeCloseTo(0.5, 6)
  })
})

describe('playback failure', () => {
  it('says nothing when playback was merely cancelled', () => {
    expect(describePlaybackFailure('aborted')).toBe('')
  })

  it('gives a distinct message for every other reason', () => {
    const reasons: PlaybackFailureReason[] = [
      'not-allowed',
      'missing-source',
      'network',
      'decode',
      'unsupported',
      'unknown',
    ]
    const messages = reasons.map(describePlaybackFailure)
    expect(messages.every((message) => message.length > 0)).toBe(true)
    expect(new Set(messages).size).toBe(messages.length)
  })

  it('skips to the next track when one actually exists', () => {
    expect(
      resolveFailureAction('network', { skipOnError: true, hasNextTrack: true, canFallBack: true }),
    ).toEqual({ kind: 'skip', notice: SKIP_NOTICE })
  })

  it('never promises to keep playing when there is no next track', () => {
    // 顺序播放到队尾、单曲循环里当前这首刚被拉黑,都属于"没有后继":
    // 此时提示"正在继续播放"就会与实际停止的行为对不上
    const action = resolveFailureAction('decode', {
      skipOnError: true,
      hasNextTrack: false,
      canFallBack: true,
    })
    expect(action.kind).toBe('fall-back')
    expect(action.kind === 'fall-back' && action.notice).toBe(describePlaybackFailure('decode'))
  })

  it('stops when skipping is off, whatever else is available', () => {
    expect(
      resolveFailureAction('network', {
        skipOnError: false,
        hasNextTrack: true,
        canFallBack: true,
      }),
    ).toEqual({ kind: 'stop' })
  })

  it('stops when there is neither a next track nor anything to fall back to', () => {
    expect(
      resolveFailureAction('unknown', {
        skipOnError: true,
        hasNextTrack: false,
        canFallBack: false,
      }),
    ).toEqual({ kind: 'stop' })
  })
})

describe('seek resolution', () => {
  it('applies the position once the duration is known', () => {
    expect(resolveSeek(30, 200)).toEqual({ kind: 'apply', time: 30 })
    expect(resolveSeek(-5, 200)).toEqual({ kind: 'apply', time: 0 })
    expect(resolveSeek(500, 200)).toEqual({ kind: 'apply', time: 200 })
  })

  it('defers the position while the duration is still unknown', () => {
    // 时长未知时写 currentTime 不生效,得先记下来
    expect(resolveSeek(30, null)).toEqual({ kind: 'pending', time: 30 })
    expect(resolveSeek(30, 0)).toEqual({ kind: 'pending', time: 30 })
    expect(resolveSeek(30, Number.NaN)).toEqual({ kind: 'pending', time: 30 })
  })

  it('ignores values that are not real numbers', () => {
    expect(resolveSeek(Number.NaN, 200)).toEqual({ kind: 'ignore' })
    expect(resolveSeek(Number.POSITIVE_INFINITY, 200)).toEqual({ kind: 'ignore' })
  })
})

describe('auto crossfade trigger', () => {
  const ready = {
    smoothTrackChange: true,
    nextTrackReady: true,
    alreadyStarted: false,
    supportsOverlap: true,
  }
  const duration = 200
  const atTrigger = duration - CROSSFADE_DURATION_MS / 1000

  it('fires about one crossfade duration before the end', () => {
    expect(shouldStartAutoCrossfade(atTrigger - 0.1, duration, ready)).toBe(false)
    expect(shouldStartAutoCrossfade(atTrigger + 0.01, duration, ready)).toBe(true)
    expect(shouldStartAutoCrossfade(duration, duration, ready)).toBe(true)
  })

  it('stays put unless everything it needs is in place', () => {
    expect(
      shouldStartAutoCrossfade(atTrigger, duration, { ...ready, smoothTrackChange: false }),
    ).toBe(false)
    // 下一首没准备好就提前切,换来的是一段静音
    expect(shouldStartAutoCrossfade(atTrigger, duration, { ...ready, nextTrackReady: false })).toBe(
      false,
    )
    expect(shouldStartAutoCrossfade(atTrigger, duration, { ...ready, alreadyStarted: true })).toBe(
      false,
    )
    // iOS 后台安全模式只有一路出声
    expect(
      shouldStartAutoCrossfade(atTrigger, duration, { ...ready, supportsOverlap: false }),
    ).toBe(false)
  })

  it('does nothing while the duration is unknown', () => {
    expect(shouldStartAutoCrossfade(10, null, ready)).toBe(false)
    expect(shouldStartAutoCrossfade(10, 0, ready)).toBe(false)
  })
})

describe('previous button', () => {
  it('restarts the current track once it is past the grace window', () => {
    expect(previousMeansRestart(0)).toBe(false)
    expect(previousMeansRestart(5)).toBe(false)
    expect(previousMeansRestart(5.1)).toBe(true)
  })
})
