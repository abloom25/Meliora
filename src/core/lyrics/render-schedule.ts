import type { LyricWord } from '../types'
import { lyricWordMotionEnd } from './word-motion'

/** Actual media state, independent of DOM and of the player's requested play state. */
export interface LyricPlaybackState {
  timeSeconds: number
  playing: boolean
  playbackRate: number
  seeking: boolean
}

export type LyricRenderSchedule =
  | { kind: 'frame' }
  | { kind: 'timer'; delayMs: number }
  | { kind: 'idle' }

/** Sleep between real line/word boundaries; the host re-reads the media clock on wake. */
export function scheduleLyricRender(
  playback: LyricPlaybackState,
  nextLineBoundary: number | null,
  words: readonly LyricWord[],
  animated: boolean,
  motionEnd: number | null = null,
): LyricRenderSchedule {
  if (!playback.playing || playback.seeking || !Number.isFinite(playback.timeSeconds))
    return { kind: 'idle' }
  const time = playback.timeSeconds
  let next = nextLineBoundary ?? Number.POSITIVE_INFINITY
  if (animated) {
    if (motionEnd !== null && Number.isFinite(motionEnd) && time < motionEnd)
      return { kind: 'frame' }
    for (const word of words) {
      if (!Number.isFinite(word.time) || !Number.isFinite(word.duration)) continue
      if (
        word.duration > 0 &&
        time >= word.time &&
        time < Math.max(word.time + word.duration, lyricWordMotionEnd(word))
      )
        return { kind: 'frame' }
      if (word.time > time) next = Math.min(next, word.time)
    }
  }
  if (!Number.isFinite(next) || next <= time) return { kind: 'idle' }
  const rate =
    Number.isFinite(playback.playbackRate) && playback.playbackRate > 0 ? playback.playbackRate : 1
  // Repair missed native events or legacy hosts without subscriptions. Never
  // advance a frozen media clock merely because this watchdog has expired.
  return { kind: 'timer', delayMs: Math.max(4, Math.min(1000, ((next - time) / rate) * 1000)) }
}
