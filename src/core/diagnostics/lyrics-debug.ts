import type { LyricProviderSource, LyricStatus } from '../types'

/** A read-only sample of the existing layout engine; no extra rendering is performed. */
export interface LyricsEngineDebugSnapshot {
  mountedLineCount: number
  /** Includes the engine's offscreen animation margin. */
  stagedLineCount: number
  visibleLineCount: number
  animatingLineCount: number
  viewportHeight: number
  offset: number
  browseOffset: number
  scrollMode: 'follow' | 'browse'
  flingVelocity: number
  frameScheduled: boolean
  anchorIndex: number
}

export interface LyricsDebugSnapshot {
  sampledAtMs: number
  trackId: string | null
  status: LyricStatus
  source: LyricProviderSource | null
  lineCount: number
  wordLineCount: number
  wordCount: number
  translationLineCount: number
  romanLineCount: number
  harmonyLineCount: number
  activeIndices: readonly number[]
  /** At most three active lines, with text limited to 120 characters each. */
  activeLines: readonly {
    index: number
    text: string
    background: boolean
    timeSeconds: number | null
    wordCount: number
  }[]
  mediaSeconds: number
  clockSeconds: number
  clockDriftMs: number
  playing: boolean
  panelActive: boolean
  animationEnabled: boolean
  translationEnabled: boolean
  documentHidden: boolean
  reducedMotion: boolean
  renderLoopRunning: boolean
  renderSchedule?: 'frame' | 'timer' | 'idle'
  userBrowsing: boolean
  sceneHeld: boolean
  engine: LyricsEngineDebugSnapshot | null
}

export type LyricsWindowKind = 'document-pip' | 'popup'
export interface LyricsWindowDebugSnapshot {
  sampledAtMs: number
  open: boolean
  opening: boolean
  kind: LyricsWindowKind | null
  width: number | null
  height: number | null
  visible: boolean | null
  nodesReady: boolean
  trackId: string | null
  status: LyricStatus
  source: LyricProviderSource | null
  mountedLineCount: number
  /** Slots actually bound to word timing; these are window slots, not song line indices. */
  activeSlots: readonly number[]
  renderedActiveIndex: number
  karaokeRunning: boolean
  renderSchedule?: 'frame' | 'timer' | 'idle'
  animatedWordCount: number
  scrollAnimationCount: number
  mediaSeconds: number
  clockSeconds: number
  animationEnabled: boolean
  reducedMotion: boolean | null
  lastFailure: string | null
  /** Only events observed while diagnostics were enabled; newest twelve retained. */
  lifecycle: readonly {
    atMs: number
    event: 'opening' | 'opened' | 'closed' | 'failed' | 'track-changed'
  }[]
}
