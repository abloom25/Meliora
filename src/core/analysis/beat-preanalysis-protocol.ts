import type { BeatTimeline, BeatTimeRange } from './beat-timeline'
import type { BeatPlaybackState } from './beat-scheduling'
import type { BeatAnalysisCheckpoint, BeatCheckpointAudio } from './beat-checkpoint'

export interface BeatInferenceMetrics {
  initializationMs: number
  inferenceMs: number
  sessionReused: boolean
  backend?: 'webgpu' | 'wasm'
  featureFrames?: number
  reusedFeatureFrames?: number
  /** Frequency pages and readiness flags, excluding PCM, FFT scratch and inference inputs. */
  featureResidentBytes?: number
  featurePeakResidentBytes?: number
  /** Largest single model-input allocation, separate from resident feature pages. */
  featureInputBytes?: number
}

export interface BeatAnalysisMetrics extends BeatInferenceMetrics {
  /** Entire build, including model/audio preparation and waiting for a worker. */
  totalMs: number
  fetchMs?: number
  hashMs?: number
  cacheReadMs?: number
  decodeMs?: number
  /** Model cache reads and exclusive worker-lease wait, excluding inference initialization. */
  modelPreparationMs?: number
  /** Elapsed from build start until the first validated cached timeline was published. */
  cacheReadyMs?: number
  cacheOrigin?: 'none' | 'memory' | 'persistent'
  /** True only when no decoder, model preparation or worker was started by this build. */
  cacheOnly?: boolean
  /** Input allocations owned by this build, not browser/process memory measurements. */
  encodedBytes?: number
  pcmBytes?: number
}

export interface BeatPreanalysisBuildRequest {
  type: 'build'
  channels: Float32Array[]
  sampleRate: number
  audioIdentity?: string
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
  /** Display-only DSP preview from the model worker, separate from verified results. */
  | { type: 'preview'; timeline: BeatTimeline }
  | {
      type: 'partial'
      timeline: BeatTimeline
      progress: number
      activeRange?: BeatTimeRange
      checkpoint?: BeatAnalysisCheckpoint
    }
  | { type: 'progress'; progress: number; activeRange?: BeatTimeRange }
  | {
      type: 'buffered'
      checkpoint: BeatAnalysisCheckpoint
      audio: BeatCheckpointAudio
      metrics?: BeatInferenceMetrics
    }
  | {
      type: 'complete'
      timeline: BeatTimeline
      audio?: BeatCheckpointAudio
      metrics?: BeatInferenceMetrics
    }
  | { type: 'error'; message: string }
