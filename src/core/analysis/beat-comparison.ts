import type { BeatAnalysisMode } from '../types'
import type { BeatAnalysisMetrics } from './beat-preanalysis-protocol'
import { BEAT_DEBUG_HISTORY_MS, type BeatDebugSample } from './beat-debug'
import { sanitizeBeatFlashRate, type BeatFlashRate } from './beat-envelope'
import {
  isBeatTimelineReadyAt,
  sampleBeatTimeline,
  type BeatBuildStatus,
  type BeatTimeline,
  type BeatTimelineSample,
} from './beat-timeline'

export type BeatComparisonMode = BeatAnalysisMode

export const BEAT_COMPARISON_MODES: readonly BeatComparisonMode[] = [
  'basic',
  'beat-this-small',
  'beat-this-standard',
]
export const BEAT_COMPARISON_MAX_SAMPLES = 1200

export interface BeatComparisonRoute {
  mode: BeatComparisonMode
  status: 'idle' | 'queued' | 'running' | 'ready' | 'unavailable' | 'cancelled' | 'error'
  phase: BeatBuildStatus['phase']
  progress: number
  error: string | null
  timeline: BeatTimeline | null
  elapsedMs: number | null
  metrics?: BeatAnalysisMetrics
}

/** Values observed together, never reconstructed after a candidate finishes late. */
export interface BeatComparisonSample {
  sampledAtMs: number
  playbackSeconds: number
  sampleSeconds: number
  flashRate: BeatFlashRate
  actual: BeatDebugSample
  candidates: Record<BeatComparisonMode, BeatTimelineSample | null>
}

export interface BeatComparisonSnapshot {
  phase: 'idle' | 'running' | 'cancelled' | 'error'
  requestedAtMs: number | null
  flashRate: BeatFlashRate
  actualMode: BeatAnalysisMode | null
  epoch: number
  current: BeatComparisonSample | null
  history: readonly BeatComparisonSample[]
  routes: BeatComparisonRoute[]
}

export function createBeatComparisonSnapshot(epoch = 0): BeatComparisonSnapshot {
  return {
    phase: 'idle',
    requestedAtMs: null,
    flashRate: 1,
    actualMode: null,
    epoch,
    current: null,
    history: [],
    routes: BEAT_COMPARISON_MODES.map((mode) => ({
      mode,
      status: 'idle',
      phase: 'idle',
      progress: 0,
      error: null,
      timeline: null,
      elapsedMs: null,
    })),
  }
}

export function createBeatComparisonSample(
  actual: BeatDebugSample,
  flashRate: number,
  timelines: Record<BeatComparisonMode, BeatTimeline | null>,
): BeatComparisonSample {
  const rate = sanitizeBeatFlashRate(flashRate)
  const read = (mode: BeatComparisonMode): BeatTimelineSample | null => {
    const timeline = timelines[mode]
    if (!timeline || !isBeatTimelineReadyAt(timeline, actual.sampleSeconds)) return null
    const value = sampleBeatTimeline(timeline, actual.sampleSeconds, rate)
    return Number.isFinite(value.level) && Number.isFinite(value.sustain) ? value : null
  }
  return {
    sampledAtMs: actual.sampledAtMs,
    playbackSeconds: actual.playbackSeconds,
    sampleSeconds: actual.sampleSeconds,
    flashRate: rate,
    actual: { ...actual, ...(actual.timing ? { timing: { ...actual.timing } } : {}) },
    candidates: {
      basic: read('basic'),
      'beat-this-small': read('beat-this-small'),
      'beat-this-standard': read('beat-this-standard'),
    },
  }
}

export function appendBeatComparisonSample(
  history: readonly BeatComparisonSample[],
  sample: BeatComparisonSample,
): readonly BeatComparisonSample[] {
  if (!Number.isFinite(sample.sampledAtMs)) return history
  const recent = history.filter(
    (previous) =>
      previous.sampledAtMs >= sample.sampledAtMs - BEAT_DEBUG_HISTORY_MS &&
      previous.sampledAtMs < sample.sampledAtMs,
  )
  return [...recent, sample].slice(-BEAT_COMPARISON_MAX_SAMPLES)
}
