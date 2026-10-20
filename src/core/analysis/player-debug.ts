import type { BeatTimeRange } from './beat-timeline'

/** A read-only snapshot of a real preload channel; never contains its audio URL. */
export interface AudioPreloadDebug {
  direction: 'previous' | 'next'
  channelId: string
  trackId: string | null
  title: string | null
  artist: string | null
  phase: 'empty' | 'loading' | 'ready' | 'error' | 'protected'
  currentTimeSeconds: number
  durationSeconds: number | null
  canStart: boolean
  failed: boolean
  bufferedRanges: readonly BeatTimeRange[]
  readyState: number
  networkState: number
  error: string | null
}
