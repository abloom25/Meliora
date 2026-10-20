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
      kind: 'frame',
    })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 2.25 }, 5, words, false)).toEqual({
      kind: 'timer',
      delayMs: 1000,
    })
  })

  it('keeps rendering a short word rise after the wipe and sleeps once it settles', () => {
    const brief = [{ time: 2, duration: 0.15, text: 'you' }]
    expect(scheduleLyricRender({ ...playing, timeSeconds: 2.5 }, 5, brief, true)).toEqual({
      kind: 'frame',
    })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 3 }, 5, brief, true)).toEqual({
      kind: 'timer',
      delayMs: 1000,
    })
    expect(
      scheduleLyricRender({ ...playing, timeSeconds: 2.5, playing: false }, 5, brief, true),
    ).toEqual({ kind: 'idle' })
    expect(
      scheduleLyricRender({ ...playing, timeSeconds: 2.5, seeking: true }, 5, brief, true),
    ).toEqual({ kind: 'idle' })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 2.5 }, 5, brief, false)).toEqual({
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

  it('keeps frames running for an overlapping harmony after the lead word has finished', () => {
    const overlap = [
      { time: 0, duration: 1, text: 'lead' },
      { time: 0.5, duration: 2, text: 'harmony' },
      { time: 3, duration: 1, text: 'next' },
    ]
    expect(scheduleLyricRender({ ...playing, timeSeconds: 1.5 }, 4, overlap, true)).toEqual({
      kind: 'frame',
    })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 2.5 }, 4, overlap, true)).toEqual({
      kind: 'timer',
      delayMs: 500,
    })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 0.25 }, 4, overlap, true)).toEqual({
      kind: 'frame',
    })
  })

  it('wakes for an instant word without scheduling endless frames and handles rewind', () => {
    const instant = [{ time: 2, duration: 0, text: 'instant' }]
    expect(scheduleLyricRender({ ...playing, timeSeconds: 1.9 }, null, instant, true)).toEqual({
      kind: 'timer',
      delayMs: expect.closeTo(100, 6),
    })
    expect(scheduleLyricRender(playing, null, instant, true)).toEqual({ kind: 'idle' })
    expect(scheduleLyricRender({ ...playing, timeSeconds: 1.5 }, null, instant, true)).toEqual({
      kind: 'timer',
      delayMs: 500,
    })
  })
})
