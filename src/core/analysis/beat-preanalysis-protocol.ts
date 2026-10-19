import type { BeatTimeline, BeatTimeRange } from './beat-timeline'
import type { BeatPlaybackState } from './beat-scheduling'
import type { BeatAnalysisCheckpoint, BeatCheckpointAudio } from './beat-checkpoint'

export interface BeatPreanalysisBuildRequest {
  type: 'build'
  channels: Float32Array[]
  sampleRate: number
  prioritySeconds?: number
  playback?: BeatPlaybackState
  checkpoint?: BeatAnalysisCheckpoint
  bufferSeconds?: number
  maxWindows?: number
}

export type BeatPreanalysisRequest =
  | BeatPreanalysisBuildRequest
  | ({ type: 'prioritize'; timeSeconds: number; bufferSeconds?: number } & Partial<
      Omit<BeatPlaybackState, 'timeSeconds'>
    >)
  | { type: 'yield' }

export type BeatPreanalysisResponse =
  | {
      type: 'partial'
      timeline: BeatTimeline
      progress: number
      activeRange?: BeatTimeRange
      checkpoint?: BeatAnalysisCheckpoint
    }
  | { type: 'progress'; progress: number; activeRange?: BeatTimeRange }
  | { type: 'buffered'; checkpoint: BeatAnalysisCheckpoint; audio: BeatCheckpointAudio }
  | { type: 'complete'; timeline: BeatTimeline; audio?: BeatCheckpointAudio }
  | { type: 'error'; message: string }
