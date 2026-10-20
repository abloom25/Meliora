import type { BeatAnalysisMode } from '../types'
import type { BeatBuildStatus, BeatTimeRange } from './beat-timeline'
import type { BeatPlaybackState } from './beat-scheduling'
import type { BeatVisualClockSource } from './beat-visual-clock'
import type { BeatAnalysisMetrics } from './beat-preanalysis-protocol'

export const BEAT_DEBUG_INTERVAL_MS = 100
export const BEAT_DEBUG_HISTORY_MS = 20_000

export type BeatHighlightReason =
  | 'ready'
  | 'disabled'
  | 'reduced-motion'
  | 'hidden'
  | 'paused'
  | 'seeking'
  | 'buffering'
  | 'audio-unavailable'
  | 'context-suspended'
  | 'model-unavailable'
  | 'timeline-missing'
  | 'range-unbuilt'

/** Output is the value actually sent to the renderer, before its CSS scaling. */
export interface BeatDebugSample {
  sampledAtMs: number
  level: number
  sustain: number
  rawLevel: number
  rawSustain: number
  readyMix: number
  playbackSeconds: number
  sampleSeconds: number
  delayMs: number
  playing: boolean
  seeking: boolean
  canHighlight: boolean
  reason: BeatHighlightReason
  timing?: {
    clockSource: BeatVisualClockSource
    frameLeadMs: number
    /** Device-side sampling offset estimate, not measured audiovisual error. */
    outputOffsetMs: number
    timelineSource: 'basic' | 'provisional' | 'model' | 'none'
    /** From this source/mode's first analysis start to its first usable render frame. */
    firstAvailableMs: number | null
    /** Last callback write, not the actual screen presentation timestamp. */
    lastWriteAtMs: number | null
    handoffPending: boolean
  }
}

export interface BeatDebugSnapshot {
  source: string
  mode: BeatAnalysisMode
  current: BeatDebugSample
  /** Monotonic wall-clock samples; cleared on source/model changes and seek. */
  history: readonly BeatDebugSample[]
}

export interface BeatDebugTask {
  source: string
  role: 'current' | 'next' | 'previous' | 'retiring'
  phase: BeatBuildStatus['phase']
  progress: number
  activeRange?: BeatTimeRange
  yielding: boolean
  aborted: boolean
}

export interface BeatDebugQueueItem {
  source: string
  title: string
  role: 'current' | 'next' | 'previous'
  /** Zero for the active job; positive for eligible work; null for blocked/satisfied work. */
  order: number | null
  reason: string
  phase: BeatBuildStatus['phase']
  progress: number
  continuousCoverageSeconds: number
  targetBufferSeconds: number
  cached: boolean
  resumable: boolean
  completedWindows: number
  estimatedWorkMs: number
  completedRanges: readonly BeatTimeRange[]
}

export interface BeatSchedulerDebug {
  sampledAtMs: number
  source: string
  mode: BeatAnalysisMode
  playback: BeatPlaybackState
  enabled: boolean
  preloadEnabled: boolean
  started: boolean
  refilling: boolean
  /** The coordinator's most recent actual decision, not a simulated schedule. */
  decision: string
  continuousCoverageSeconds: number
  lowWatermarkSeconds: number
  highWatermarkSeconds: number
  cacheEntries: number
  /** Most recent build for this source and mode, never an adjacent track's metrics. */
  metrics?: BeatAnalysisMetrics
  activeTask: BeatDebugTask | null
  queue: readonly BeatDebugQueueItem[]
}
