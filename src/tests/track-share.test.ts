import { afterEach, describe, expect, it } from 'vitest'
import type { Track } from '../core/types'
import { createTrackShareId } from '../core/library/tracks'
import {
  MAX_TRACK_SHARE_SECONDS,
  formatTrackShareTime,
  parseTrackShareTime,
} from '../core/library/track-share'
import { createTrackShareUrl } from '../platform/web/track-share'

const track: Track = {
  id: 'song',
  title: 'Song',
  artist: 'Artist',
  audioUrl: '/song.mp3',
  kind: 'local',
}

describe('track share times', () => {
  it.each([
    ['0', 0],
    ['80', 80],
    ['80.125', 80.125],
    ['80.123456', 80.123],
    [String(MAX_TRACK_SHARE_SECONDS), MAX_TRACK_SHARE_SECONDS],
  ])('reads a finite decimal timestamp %s', (value, seconds) => {
    expect(parseTrackShareTime(value)).toBe(seconds)
  })

  it.each([
    null,
    undefined,
    '',
    ' ',
    'NaN',
    'Infinity',
    '-1',
    '-0',
    '+10',
    '1e4',
    '0x10',
    '1:20',
    '10s',
    ' 10 ',
    '86400.001',
    '9'.repeat(1000),
  ])('ignores malformed or out-of-range timestamp %s', (value) => {
    expect(parseTrackShareTime(value)).toBeNull()
  })

  it('serializes milliseconds without superfluous decimal zeros', () => {
    expect(formatTrackShareTime(80.123456)).toBe('80.123')
    expect(formatTrackShareTime(80.1)).toBe('80.1')
    expect(formatTrackShareTime(0)).toBe('0')
    expect(formatTrackShareTime(-0)).toBe('0')
  })

  it.each([NaN, Infinity, -Infinity, -1, MAX_TRACK_SHARE_SECONDS + 1])(
    'does not serialize an invalid position %s',
    (value) => {
      expect(formatTrackShareTime(value)).toBeNull()
    },
  )
})

describe('track share URLs', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('preserves the page path and never forwards unrelated query parameters or fragments', () => {
    window.history.replaceState(null, '', '/player/?unrelated=private&share=old&t=100#debug')
    const url = new URL(createTrackShareUrl(track, 80.125))
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/player/')
    expect([...url.searchParams.entries()]).toEqual([
      ['share', createTrackShareId(track)],
      ['t', '80.125'],
    ])
    expect(url.hash).toBe('')
  })

  it('keeps normal song links untimed but allows a fragment at the song beginning', () => {
    expect(new URL(createTrackShareUrl(track)).searchParams.has('t')).toBe(false)
    expect(new URL(createTrackShareUrl(track, 0)).searchParams.get('t')).toBe('0')
    expect(new URL(createTrackShareUrl(track, NaN)).searchParams.has('t')).toBe(false)
  })
})
