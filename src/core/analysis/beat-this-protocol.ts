import type { BeatTimeline, BeatTimeRange } from './beat-timeline'
import type { BeatPlaybackState } from './beat-scheduling'
import type { BeatAnalysisCheckpoint, BeatCheckpointAudio } from './beat-checkpoint'

export interface BeatThisBuildRequest {
  type: 'build'
  channels: Float32Array[]
  sampleRate: number
  modelId: 'small' | 'standard'
  model: ArrayBuffer
  /** Official torchaudio filterbank, little-endian float32 [513, 128]. */
  filterbank: ArrayBuffer
  wasmBinary: ArrayBuffer
  wasmPaths?: { wasm?: string; mjs: string }
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

export type BeatThisResponse =
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
    }
  | {
      type: 'complete'
      timeline: BeatTimeline
      backend: 'webgpu' | 'wasm'
      audio?: BeatCheckpointAudio
    }
  | { type: 'error'; message: string }
