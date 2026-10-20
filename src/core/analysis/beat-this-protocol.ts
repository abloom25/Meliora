import type { BeatTimeline, BeatTimeRange } from './beat-timeline'
import type { BeatPlaybackState } from './beat-scheduling'
import type { BeatAnalysisCheckpoint, BeatCheckpointAudio } from './beat-checkpoint'
import type { BeatInferenceMetrics } from './beat-preanalysis-protocol'

export interface BeatThisModelAssets {
  model: ArrayBuffer
  /** Official torchaudio filterbank, little-endian float32 [513, 128]. */
  filterbank: ArrayBuffer
  wasmBinary: ArrayBuffer
  wasmPaths?: { wasm?: string; mjs: string }
}

export interface BeatThisBuildRequest {
  type: 'build'
  channels: Float32Array[]
  sampleRate: number
  /** Exact decoded audio identity, preserved across buffer transfers. */
  audioIdentity?: string
  modelId: 'small' | 'standard'
  model?: ArrayBuffer
  /** Official torchaudio filterbank, little-endian float32 [513, 128]. */
  filterbank?: ArrayBuffer
  wasmBinary?: ArrayBuffer
  wasmPaths?: { wasm?: string; mjs: string }
  /** Hosts opt in only when they own an exclusive reusable worker lease. */
  retainSession?: boolean
  prioritySeconds?: number
  playback?: BeatPlaybackState
  checkpoint?: BeatAnalysisCheckpoint
  bufferSeconds?: number
  maxWindows?: number
}

export type BeatThisRequest =
  | BeatThisBuildRequest
  | ({ type: 'prioritize'; timeSeconds: number; bufferSeconds?: number } & Partial<
      Omit<BeatPlaybackState, 'timeSeconds'>
    >)
  | { type: 'yield' }
  | { type: 'dispose' }

export type BeatThisResponse =
  /** Basic DSP only: never counts as a model checkpoint or completed window. */
  | { type: 'preview'; timeline: BeatTimeline }
  | { type: 'progress'; progress: number; activeRange?: BeatTimeRange }
  | {
      type: 'partial'
      timeline: BeatTimeline
      progress: number
      activeRange?: BeatTimeRange
      checkpoint?: BeatAnalysisCheckpoint
    }
  | {
      type: 'buffered'
      checkpoint: BeatAnalysisCheckpoint
      audio: BeatCheckpointAudio
      backend?: 'webgpu' | 'wasm'
      metrics?: BeatInferenceMetrics
    }
  | {
      type: 'complete'
      timeline: BeatTimeline
      backend: 'webgpu' | 'wasm'
      metrics?: BeatInferenceMetrics
      audio?: BeatCheckpointAudio
    }
  | { type: 'error'; message: string }
  | { type: 'disposed' }
