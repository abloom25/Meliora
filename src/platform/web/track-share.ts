import type { Track } from '../../core/types'
import { createTrackShareId } from '../../core/library/tracks'
import { formatTrackShareTime } from '../../core/library/track-share'

/** Start from the public page path so a share never leaks the caller's query or fragment. */
export function createTrackShareUrl(track: Track, seconds?: number): string {
  const url = new URL(window.location.pathname, window.location.origin)
  url.searchParams.set('share', createTrackShareId(track))
  const time = seconds === undefined ? null : formatTrackShareTime(seconds)
  if (time !== null) url.searchParams.set('t', time)
  return url.href
}
