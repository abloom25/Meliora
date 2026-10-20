import { describe, expect, it } from 'vitest'
import { scheduleLyricRender, type LyricPlaybackState } from '../core/lyrics/render-schedule'

const playing: LyricPlaybackState = {
  timeSeconds: 2,
  playing: true,
  playbackRate: 1,
  seeking: false,
}
const words = [
  { time: 2.2, duration: 0.2, text: 'one' },
  { time: 3, duration: 0.4, text: 'two' },
]

describe('lyric render scheduling', () => {
  it('sleeps until the nearest actual word/line boundary and accounts for playback speed', () => {
    expect(scheduleLyricRender(playing, 5, words, true)).toEqual({
      kind: 'timer',
      delayMs: expect.closeTo(200, 6),
    })
    expect(scheduleLyricRender({ ...playing, playbackRate: 2 }, 2.3, [], false)).toMatchObject({
      kind: 'timer',
      delayMs: expect.closeTo(150, 6),
    })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 2.25 }, 5, words, true)).toEqual({
      kind: 'frame',
    })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 2.5 }, 5, words, true)).toEqual({
      kind: 'timer',
      delayMs: 500,
    })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 2.25 }, 5, words, false)).toEqual({
      kind: 'timer',
      delayMs: 1000,
    })
  })

  it('stops during pause/buffering/seek or after the final boundary without extrapolating', () => {
    expect(scheduleLyricRender({ ...playing, playing: false }, 3, words, true)).toEqual({
      kind: 'idle',
    })
    expect(scheduleLyricRender({ ...playing, seeking: true }, 3, words, true)).toEqual({
      kind: 'idle',
    })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 8 }, null, words, true)).toEqual({
      kind: 'idle',
    })
    const frozen = { ...playing, timeSeconds: 2.5 }
    for (let wake = 0; wake < 10; wake += 1)
      expect(scheduleLyricRender(frozen, 3, [], false)).toEqual({ kind: 'timer', delayMs: 500 })
  })
})
