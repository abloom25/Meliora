import { computed, onBeforeUnmount, readonly, ref, shallowRef, watch, type Ref } from 'vue'
import { EQ_BAND_FREQUENCIES, bandFilterType } from '../../core/audio/equalizer'
import { createAudioContextCompatible } from './browser'
import {
  isBeatTimelineReadyAt,
  sampleBeatTimeline,
  type BeatPreloadTarget,
  type BeatTimeline,
} from '../../core/analysis/beat-timeline'
import { createBeatVisualClock } from '../../core/analysis/beat-visual-clock'
import { useBeatPreanalysis } from './useBeatPreanalysis'
import { useBeatThisModels } from './useBeatThisModels'
import type { BeatAnalysisMode, Track } from '../../core/types'
import type { BeatPlaybackState } from '../../core/analysis/beat-scheduling'
import type { PlaybackResourcePressure } from '../../core/playback/resource-budget'
import {
  BEAT_DEBUG_HISTORY_MS,
  BEAT_DEBUG_INTERVAL_MS,
  type BeatDebugSample,
  type BeatDebugSnapshot,
  type BeatHighlightReason,
} from '../../core/analysis/beat-debug'

// 模块级音频上下文与 source 缓存：
// 浏览器对同一个 audio 节点只允许 createMediaElementSource 一次。
// 因此保持一个共享 AudioContext，避免组件重建后把旧 source 连接到新/已关闭 context。
let sharedAudioContext: AudioContext | null = null
const mediaSourceMap = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>()

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

// 帧率无关的一阶指数平滑:给定时间常数 tau(秒),返回本帧应向目标逼近的比例。
// 高刷新率屏幕上固定每帧系数会让动画整体加速,所有包络/自适应统计统一走这里
function smoothingAlpha(dtSeconds: number, tauSeconds: number) {
  return 1 - Math.exp(-dtSeconds / tauSeconds)
}

const SPECTRUM_BANDS: Array<{ from: number; to: number }> = [
  { from: 30, to: 120 },
  { from: 120, to: 400 },
  { from: 400, to: 1500 },
  { from: 1500, to: 5000 },
  { from: 5000, to: 12000 },
]
// 快起慢落,逐段略有差异,柱子才有"活"的感觉而不是整齐划一
const RISE_TAUS = [0.05, 0.045, 0.06, 0.04, 0.035]
const FALL_TAUS = [0.3, 0.26, 0.24, 0.2, 0.16]
const BAND_IDLE_AMP = [0.16, 0.2, 0.22, 0.15, 0.12]
const BAND_IDLE_BASE = [0.18, 0.24, 0.26, 0.2, 0.15]

const PULSE_WEIGHTS = [0.28, 0.2, 0.12, 0.06, 0.03]
const SEEK_SETTLE_MS = 180

export interface BeatAnalyserOptions {
  resourcePressure?: Readonly<Ref<PlaybackResourcePressure>>
  visualIntervalMs?: Readonly<Ref<number>>
  observeVisualFrame?: (now: number) => void
  track?: Ref<Track | null>
  debugEnabled?: Ref<boolean>
  /** Higher diagnostic cadence only while the live comparison is visible. */
  debugSampleIntervalMs?: Readonly<Ref<number>>
  mode?: Ref<BeatAnalysisMode>
  source?: Ref<string>
  durationSeconds?: Ref<number>
  adjacent?: Ref<readonly BeatPreloadTarget[]>
  preloadEnabled?: Ref<boolean>
  enabled?: Ref<boolean>
  unavailableReason?: Ref<string | null>
  players: readonly HTMLAudioElement[]
  getActiveAudio: () => HTMLAudioElement
  isPlaying: Ref<boolean>
  /** 可选:闪烁密度设置(每拍最多闪几次),非法值按 1 处理 */
  beatFlashRate?: Ref<number>
  /** 可选:闪光延迟微调(ms),叠加在自动输出延迟补偿之上,可为负 */
  beatVisualDelay?: Ref<number>
  /** 高频采样结果由宿主消费；分析器不持有视图节点或 CSS 变量。 */
  onBeat?: (level: number, sustain: number) => void
  onSpectrum?: (levels: readonly number[]) => void
  /**
   * 可选：当 EQ filter chain 首次创建完毕时回调，把 BiquadFilterNode 数组
   * 交给 useEqualizer 绑定，由其负责按 settings 更新各频段增益。
   */
  onEqFiltersReady?: (filters: BiquadFilterNode[]) => void
  /**
   * 可选：当某 audio 元素因跨域污染(tainted)导致无法通过 Web Audio API 读取数据时回调。
   * 仅在 createMediaElementSource 明确抛 SecurityError 时触发。
   * 调用方应重建该 audio 为无 crossOrigin 元素，并降级节拍分析。
   */
  onTainted?: (audio: HTMLAudioElement) => void
}

export function useBeatAnalyser(options: BeatAnalyserOptions) {
  const { players, getActiveAudio, isPlaying } = options
  const beatLevel = ref(0)
  const spectrumLevels = ref([0.1, 0.1, 0.1, 0.1, 0.1])
  const reducedMotion = ref(false)
  const visualEnabled = computed(() => options.enabled?.value !== false && !reducedMotion.value)
  const models = useBeatThisModels()
  void models.initialize()
  const selectedModel = computed(() =>
    options.mode?.value === 'beat-this-small'
      ? 'small'
      : options.mode?.value === 'beat-this-standard'
        ? 'standard'
        : null,
  )
  const selectedState = computed(() =>
    selectedModel.value ? models.status.value[selectedModel.value] : null,
  )
  const unavailableReason = computed(
    () =>
      options.unavailableReason?.value ??
      (selectedState.value?.phase === 'error'
        ? selectedState.value.error
        : selectedState.value?.phase === 'missing'
          ? '请在设置中下载并启用所选模型'
          : null),
  )
  let seekSettleTimer: ReturnType<typeof setTimeout> | null = null
  let settlingAudio: HTMLAudioElement | null = null
  let stalledAudio: HTMLAudioElement | null = null
  function playbackState(): BeatPlaybackState {
    const audio = getActiveAudio()
    return {
      timeSeconds: audio.currentTime,
      playing:
        isPlaying.value &&
        !audio.paused &&
        !audio.ended &&
        stalledAudio !== audio &&
        audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
      playbackRate: audio.playbackRate,
      seeking: audio.seeking || settlingAudio === audio,
    }
  }
  const preanalysis = useBeatPreanalysis({
    resourcePressure: options.resourcePressure,
    track: options.track,
    source: options.source ?? ref(''),
    debugEnabled: options.debugEnabled,
    mode: options.mode,
    durationSeconds: options.durationSeconds,
    adjacent: options.adjacent,
    preloadEnabled: options.preloadEnabled,
    getPlaybackState: playbackState,
    enabled: visualEnabled,
    modelAvailable: computed(() => !selectedState.value || selectedState.value.phase === 'ready'),
    preservePreviewOnUnavailable: computed(
      () => selectedState.value?.phase === 'error' && !options.unavailableReason?.value,
    ),
    unavailableReason,
  })
  let readyMix = 0
  const timelineSample = { level: 0, sustain: 0 }
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let frequencyData: Uint8Array<ArrayBuffer> | null = null
  const connectedSources: Array<{
    source: MediaElementAudioSourceNode
    target: AudioNode
  }> = []
  let eqFilters: BiquadFilterNode[] = []
  let beatFrame = 0
  // 每个频谱段的慢速基线(自适应归一化用,0 表示未初始化)
  const bandBaselines = [0, 0, 0, 0, 0]
  // 每段上一帧电平:帧间突变(鼓点/拨弦/咬字)瞬态直通,不等待基线拉开差距
  const prevBandDbs = [0, 0, 0, 0, 0]
  let sustainLevel = 0
  let lastFrameAt = 0
  let visibilityListenerRegistered = false
  let isUnmounted = false
  let motionQuery: MediaQueryList | null = null
  const debugSnapshot = shallowRef<BeatDebugSnapshot | null>(null)
  let debugHistory: BeatDebugSample[] = []
  let lastDebugAt = -Infinity
  let outputLevel = 0
  let outputSustain = 0
  const visualClock = createBeatVisualClock()
  let clockSample = visualClock.sample({
    nowMs: performance.now(),
    mediaSeconds: getActiveAudio().currentTime,
    playbackRate: getActiveAudio().playbackRate,
    running: false,
  })
  let clockAudio: HTMLAudioElement | null = null
  let clockContextState: AudioContextState | undefined
  let timelineSource: 'basic' | 'provisional' | 'model' | 'none' = 'none'
  let adoptedModelTimeline: BeatTimeline | null = null
  let lastProvisionalPulseAt = -Infinity
  let previousProvisionalLevel = 0
  let lastProvisionalFrameAt = -Infinity
  let previousModelLevel = 0
  let handoffUntil = 0
  let handoffPending = false
  let firstStartedAt: number | null = null
  let firstAvailableMs: number | null = null
  let lastWriteAtMs: number | null = null

  function readVisualClock(now: number, frameDeltaMs?: number) {
    const audio = getActiveAudio()
    const state = playbackState()
    if (clockAudio !== audio || clockContextState !== audioContext?.state) visualClock.reset()
    clockAudio = audio
    clockContextState = audioContext?.state
    let timestamp: AudioTimestamp | undefined
    try {
      timestamp = audioContext?.getOutputTimestamp?.()
    } catch {
      // Older engines and an audio-device transition may reject this optional API.
    }
    clockSample = visualClock.sample({
      nowMs: now,
      mediaSeconds: audio.currentTime,
      playbackRate: audio.playbackRate,
      running: state.playing && !audio.seeking && audioContext?.state === 'running',
      contextSeconds: audioContext?.currentTime,
      outputTimestamp:
        timestamp?.contextTime !== undefined && timestamp.performanceTime !== undefined
          ? { contextTime: timestamp.contextTime, performanceTime: timestamp.performanceTime }
          : undefined,
      baseLatencySeconds: audioContext?.baseLatency,
      outputLatencySeconds: audioContext?.outputLatency,
      manualOffsetMs: options.beatVisualDelay?.value,
      frameDeltaMs,
    })
    return clockSample
  }

  function availableTimeline(time: number): {
    timeline: BeatTimeline | null
    source: typeof timelineSource
  } {
    if (!visualEnabled.value) return { timeline: null, source: 'none' }
    const formal = preanalysis.timeline.value
    if (formal && isBeatTimelineReadyAt(formal, time))
      return { timeline: formal, source: selectedModel.value ? 'model' : 'basic' }
    // A verified model interval must never fall back to its older approximation.
    if (adoptedModelTimeline && isBeatTimelineReadyAt(adoptedModelTimeline, time))
      return { timeline: null, source: 'none' }
    const provisional = preanalysis.provisionalTimeline?.value
    if (provisional && isBeatTimelineReadyAt(provisional, time))
      return { timeline: provisional, source: 'provisional' }
    return { timeline: null, source: 'none' }
  }

  function clearDebug(): void {
    debugSnapshot.value = null
    debugHistory = []
    lastDebugAt = -Infinity
  }

  function highlightReason(audio: HTMLAudioElement, time: number): BeatHighlightReason {
    if (options.enabled?.value === false) return 'disabled'
    if (reducedMotion.value) return 'reduced-motion'
    if (document.hidden) return 'hidden'
    if (audio.paused || audio.ended) return 'paused'
    if (audio.seeking) return 'seeking'
    if (stalledAudio === audio || audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
      return 'buffering'
    if (!analyser || !frequencyData) return 'audio-unavailable'
    if (audioContext?.state !== 'running') return 'context-suspended'
    if (availableTimeline(time).timeline) return 'ready'
    if (unavailableReason.value) return 'model-unavailable'
    if (!preanalysis.timeline.value && !preanalysis.provisionalTimeline?.value)
      return 'timeline-missing'
    return 'range-unbuilt'
  }

  function captureDebug(force = false): void {
    if (!options.debugEnabled?.value || isUnmounted) return
    const now = performance.now()
    const requestedInterval = options.debugSampleIntervalMs?.value
    const interval =
      requestedInterval !== undefined && Number.isFinite(requestedInterval)
        ? clamp(requestedInterval, 1000 / 30, 1000)
        : BEAT_DEBUG_INTERVAL_MS
    const append = now - lastDebugAt >= interval
    if (!force && !append) return
    const audio = getActiveAudio()
    // Diagnostics observe the last actual render sample; they never advance its clock.
    const timing = clockSample
    const time = timing.sampleSeconds
    const reason = highlightReason(audio, time)
    const state = playbackState()
    const previous = debugSnapshot.value?.current
    if (
      !append &&
      previous?.reason === reason &&
      previous.playing === state.playing &&
      previous.seeking === state.seeking &&
      previous.level === outputLevel &&
      previous.sustain === outputSustain &&
      previous.delayMs === timing.delayMs
    )
      return
    const active = availableTimeline(time)
    const raw = active.timeline
      ? sampleBeatTimeline(active.timeline, time, options.beatFlashRate?.value ?? 1)
      : { level: 0, sustain: 0 }
    const current: BeatDebugSample = {
      sampledAtMs: now,
      level: outputLevel,
      sustain: outputSustain,
      rawLevel: raw.level,
      rawSustain: raw.sustain,
      readyMix,
      playbackSeconds: audio.currentTime,
      sampleSeconds: time,
      delayMs: timing.delayMs,
      playing: state.playing,
      seeking: state.seeking,
      canHighlight: reason === 'ready',
      reason,
      timing: {
        clockSource: timing.clockSource,
        frameLeadMs: timing.frameLeadMs,
        outputOffsetMs: timing.outputOffsetMs,
        timelineSource: active.source,
        firstAvailableMs,
        lastWriteAtMs,
        handoffPending,
      },
    }
    if (append) {
      lastDebugAt = now
      debugHistory = [
        ...debugHistory.filter((sample) => now - sample.sampledAtMs <= BEAT_DEBUG_HISTORY_MS),
        current,
      ]
    }
    debugSnapshot.value = {
      source: options.source?.value ?? audio.currentSrc ?? audio.src,
      mode: options.mode?.value ?? 'basic',
      current,
      history: debugHistory,
    }
  }

  function emitBeat(level: number, sustain: number): void {
    outputLevel = level
    outputSustain = sustain
    options.onBeat?.(level, sustain)
    lastWriteAtMs = options.onBeat ? performance.now() : null
    captureDebug()
  }

  function disconnectAnalysisGraph() {
    for (const { source, target } of connectedSources) {
      try {
        source.disconnect(target)
      } catch {
        // The source may already have been disconnected by browser cleanup.
      }
    }
    connectedSources.length = 0
    for (const filter of eqFilters) {
      try {
        filter.disconnect()
      } catch {
        // Ignore disconnect errors during teardown.
      }
    }
    eqFilters = []
    try {
      analyser?.disconnect()
    } catch {
      // Ignore disconnect errors during teardown.
    }
    analyser = null
    frequencyData = null
  }

  function resetBeatTracking() {
    visualClock.reset()
    timelineSource = 'none'
    handoffPending = false
    handoffUntil = 0
    previousProvisionalLevel = 0
    lastProvisionalFrameAt = -Infinity
    previousModelLevel = 0
    lastProvisionalPulseAt = -Infinity
    readyMix = 0
    beatLevel.value = 0
    sustainLevel = 0
    bandBaselines.fill(0)
    prevBandDbs.fill(0)
    emitBeat(0, 0)
  }

  watch(
    preanalysis.timeline,
    (next, previous) => {
      // Extending the same track's verified ranges must not interrupt an ongoing pulse.
      // Source/model changes always invalidate to null before publishing a new timeline.
      if ((!next || !previous) && !preanalysis.provisionalTimeline?.value) resetBeatTracking()
    },
    { flush: 'sync' },
  )
  watch(
    visualEnabled,
    (enabled) => {
      if (!enabled) {
        firstStartedAt = null
        firstAvailableMs = null
        resetBeatTracking()
      } else if (isPlaying.value && firstStartedAt === null) firstStartedAt = performance.now()
    },
    { flush: 'sync' },
  )

  function stopBeatAnalysis() {
    window.cancelAnimationFrame(beatFrame)
    beatFrame = 0
    beatLevel.value = 0
    resetBeatTracking()
    lastFrameAt = 0
    emitBeat(0, 0)
    spectrumLevels.value = spectrumLevels.value.map(() => 0.08)
    options.onSpectrum?.(spectrumLevels.value)
    captureDebug(true)
    if (visibilityListenerRegistered) {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      visibilityListenerRegistered = false
    }
  }

  function pauseBeatAnalysis() {
    visualClock.reset()
    if (!beatFrame) return
    window.cancelAnimationFrame(beatFrame)
    beatFrame = 0
    spectrumLevels.value = spectrumLevels.value.map((level) => Math.max(0.08, level * 0.82))
    options.onSpectrum?.(spectrumLevels.value)
    emitBeat(0, 0)
  }

  function handleVisibilityChange() {
    reducedMotion.value = motionQuery?.matches ?? false
    if (document.hidden || motionQuery?.matches) {
      pauseBeatAnalysis()
    } else {
      if (audioContext?.state === 'suspended') {
        void audioContext.resume()
      }
      if (!beatFrame && isPlaying.value) beatFrame = window.requestAnimationFrame(updateBeatLevel)
    }
    captureDebug(true)
  }

  function getAudioContext(): AudioContext {
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
      // Safari 14.1 之前需要 webkitAudioContext,由工具统一兼容
      const ctx = createAudioContextCompatible()
      if (!ctx) throw new Error('AudioContext unavailable')
      sharedAudioContext = ctx
    }
    ensureGestureResume()
    return sharedAudioContext
  }

  // Safari 的 AudioContext.resume() 必须发生在用户手势内:媒体元素事件
  // ('play' 等)在 WebKit 不继承用户激活态,异步 resume 后上下文仍停在
  // suspended,analyser 持续输出全零。在真实手势上兜底 resume,
  // 保证 macOS Safari 的分析链路能起来(Chrome 走同一无害路径)
  let gestureResumeRegistered = false
  function handleGestureResume() {
    if (sharedAudioContext?.state === 'suspended') void sharedAudioContext.resume()
  }
  function ensureGestureResume() {
    if (gestureResumeRegistered || typeof document === 'undefined') return
    gestureResumeRegistered = true
    document.addEventListener('pointerdown', handleGestureResume, true)
    document.addEventListener('keydown', handleGestureResume, true)
  }

  // 频段 dB 均值:byte 频谱本身是 dB 映射(默认 -100…-30dB 压到 0…255),
  // 均值落在压缩域,适合与自适应基线做相对比较
  function bandAverage(data: Uint8Array<ArrayBuffer>, from: number, to: number) {
    const start = Math.max(1, Math.min(data.length - 1, from))
    const end = Math.max(start + 1, Math.min(data.length, to))
    let sum = 0
    for (let index = start; index < end; index += 1) sum += data[index] ?? 0
    return sum / 255 / Math.max(1, end - start)
  }

  function updateBeatLevel() {
    const activeAudio = getActiveAudio()
    const now = performance.now()
    options.observeVisualFrame?.(now)
    const interval = options.visualIntervalMs?.value ?? 0
    if (lastFrameAt && now - lastFrameAt < interval - 2) {
      beatFrame = window.requestAnimationFrame(updateBeatLevel)
      return
    }
    const elapsedMs = lastFrameAt ? now - lastFrameAt : 1000 / 60
    const dt = clamp(elapsedMs / 1000, 0.001, 0.1)
    lastFrameAt = now
    const time = readVisualClock(now, elapsedMs).sampleSeconds
    if (!analyser || !frequencyData || activeAudio.paused) {
      beatLevel.value *= Math.exp(-dt / 0.13)
      sustainLevel *= Math.exp(-dt / 0.3)
      emitBeat(beatLevel.value, sustainLevel)
      spectrumLevels.value = spectrumLevels.value.map((level) =>
        Math.max(0.08, level * Math.exp(-dt / 0.084)),
      )
      options.onSpectrum?.(spectrumLevels.value)
      if (beatLevel.value > 0.005) beatFrame = window.requestAnimationFrame(updateBeatLevel)
      else stopBeatAnalysis()
      return
    }
    analyser.getByteFrequencyData(frequencyData)
    const data = frequencyData
    const binHz = audioContext ? audioContext.sampleRate / analyser.fftSize : 187.5
    const binOf = (hz: number) => clamp(Math.round(hz / binHz), 1, data.length - 1)
    const active = availableTimeline(time)
    const timeline = active.timeline
    if (
      timeline &&
      isBeatTimelineReadyAt(timeline, time) &&
      !activeAudio.seeking &&
      !activeAudio.ended &&
      stalledAudio !== activeAudio &&
      isPlaying.value &&
      !document.hidden &&
      activeAudio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
      audioContext?.state === 'running'
    ) {
      const levels = sampleBeatTimeline(
        timeline,
        time,
        options.beatFlashRate?.value ?? 1,
        timelineSample,
      )
      if (firstAvailableMs === null && firstStartedAt !== null)
        firstAvailableMs = Math.max(0, now - firstStartedAt)
      if (active.source === 'provisional') {
        if (
          levels.level > 0.1 &&
          (previousProvisionalLevel <= 0.1 || levels.level > previousProvisionalLevel + 0.05)
        )
          lastProvisionalPulseAt = now
        previousProvisionalLevel = levels.level
        lastProvisionalFrameAt = now
      } else if (active.source === 'model') {
        adoptedModelTimeline = timeline
        if (
          timelineSource !== 'model' &&
          (now - lastProvisionalPulseAt < 140 ||
            (now - lastProvisionalFrameAt < 150 && previousProvisionalLevel > 0.08))
        ) {
          handoffPending = true
          const rate = activeAudio.playbackRate > 0 ? activeAudio.playbackRate : 1
          handoffUntil = lastProvisionalPulseAt + 50 / rate + Math.min(elapsedMs, 20)
        }
      }
      // Switch to one timeline only. During a nearby provisional attack, the model
      // may shift that same beat slightly; do not create a second rising edge.
      if (
        handoffPending &&
        now >= handoffUntil &&
        (levels.level <= 0.08 ||
          (timelineSource === 'model' && levels.level > previousModelLevel + 0.05))
      )
        handoffPending = false
      readyMix = 1
      beatLevel.value = handoffPending ? Math.min(beatLevel.value, levels.level) : levels.level
      previousModelLevel = active.source === 'model' ? levels.level : 0
      sustainLevel +=
        (levels.sustain - sustainLevel) *
        smoothingAlpha(dt, levels.sustain > sustainLevel ? 0.045 : 0.16)
      timelineSource = active.source
    } else {
      timelineSource = 'none'
      handoffPending = false
      readyMix = 0
      beatLevel.value = 0
      sustainLevel = 0
    }
    emitBeat(beatLevel.value, sustainLevel)

    // 频谱柱五段 Hz 划分(sub/low/mid/high/air)
    const idlePhase = now / 1000
    const idleWave = [
      Math.sin(idlePhase * 4.26) * 0.55 + Math.sin(idlePhase * 1.74 + 1.3) * 0.45,
      Math.sin(idlePhase * 5.53 + 2.6) * 0.5 + Math.sin(idlePhase * 2.11 + 0.8) * 0.5,
      Math.sin(idlePhase * 6.78 + 1.7) * 0.5 + Math.sin(idlePhase * 2.46 + 3.2) * 0.5,
      Math.sin(idlePhase * 9.42 + 0.5) * 0.6 + Math.sin(idlePhase * 1.38 + 5.1) * 0.4,
      Math.sin(idlePhase * 11.82 + 4.4) * 0.45 + Math.sin(idlePhase * 3.18 + 2.7) * 0.55,
    ]
    // 整体电平门:接近静默时淡出到 idle 波浪,有内容时交给自适应动态
    const overallLevel = bandAverage(data, binOf(30), binOf(12000))
    const audioGate = clamp((overallLevel - 0.06) * 8, 0, 1)
    const nextSpectrum = spectrumLevels.value.map((previous, band) => {
      const def = SPECTRUM_BANDS[band] ?? SPECTRUM_BANDS[0]!
      const db = bandAverage(data, binOf(def.from), binOf(def.to))
      // 自适应归一化:byte 频谱是 dB 压缩域,绝对电平动态范围很窄(直接映射
      // 不是顶满就是贴地)。改为跟踪每段自身的慢速基线,映射"相对近期的
      // 抬升量",再围绕稳态点做对比拉伸——增益的是"变化"而不是电平本身:
      // 稳态留在低位,向上/向下的偏离都被加倍放大
      let baseline = bandBaselines[band] ?? 0
      baseline = baseline === 0 ? db : baseline + (db - baseline) * smoothingAlpha(dt, 1.5)
      bandBaselines[band] = baseline
      const relative = clamp((db - baseline * 0.96) / (baseline * 0.22 + 0.02), 0, 1)
      const transient = clamp((db - (prevBandDbs[band] ?? db)) * 4, 0, 1) * 0.85
      prevBandDbs[band] = db
      const raw = Math.max(relative, transient)
      const stretched = clamp(0.18 + (raw - 0.18) * 2.4, 0, 1)
      const idleHeight =
        (BAND_IDLE_BASE[band] ?? 0.2) + (BAND_IDLE_AMP[band] ?? 0.18) * (idleWave[band] ?? 0)
      const pulseLift = beatLevel.value * (PULSE_WEIGHTS[band] ?? 0.1)
      const target = clamp(
        idleHeight * (1 - audioGate) + (0.08 + stretched * 0.9) * audioGate + pulseLift,
        0.08,
        0.98,
      )
      const tau = target > previous ? (RISE_TAUS[band] ?? 0.05) : (FALL_TAUS[band] ?? 0.24)
      return previous + (target - previous) * smoothingAlpha(dt, tau)
    })
    spectrumLevels.value = nextSpectrum
    options.onSpectrum?.(nextSpectrum)
    beatFrame = window.requestAnimationFrame(updateBeatLevel)
  }

  async function startBeatAnalysis() {
    if (firstStartedAt === null && visualEnabled.value) firstStartedAt = performance.now()
    if (!motionQuery) {
      motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
      motionQuery.addEventListener?.('change', handleVisibilityChange)
    }
    const prefersReducedMotion = motionQuery.matches
    reducedMotion.value = prefersReducedMotion
    preanalysis.prioritize(getActiveAudio().currentTime, playbackState())
    preanalysis.start()
    try {
      if (!audioContext) {
        audioContext = getAudioContext()
        analyser = audioContext.createAnalyser()
        // 2048 点 FFT:48kHz 下 bin 宽约 23Hz,30–130Hz 的底鼓基频段有足够的频率分辨率
        // (旧值 256 的 bin 宽约 187Hz,底鼓挤不进独立 bin);分析器自带平滑调低,
        // onset 锐利度交给后面的帧率无关包络控制
        analyser.fftSize = 2048
        analyser.smoothingTimeConstant = 0.3
        // 构建 EQ filter chain：5 个 BiquadFilterNode 串联，
        // 插入在 MediaElementSource 与 Analyser 之间。
        // createMediaElementSource 每个元素只能 attach 一次，
        // 因此 EQ 必须在 graph 首次构建时一并接入，后续无法重连。
        eqFilters = EQ_BAND_FREQUENCIES.map((frequency, index) => {
          const filter = audioContext!.createBiquadFilter()
          filter.type = bandFilterType(index)
          filter.frequency.value = frequency
          filter.Q.value = 1
          filter.gain.value = 0
          return filter
        })
        for (let index = 0; index < eqFilters.length - 1; index += 1) {
          eqFilters[index].connect(eqFilters[index + 1])
        }
        const eqInput = eqFilters[0]
        const eqOutput = eqFilters[eqFilters.length - 1]
        let taintedSourceDetected = false
        players.forEach((audio) => {
          let source = mediaSourceMap.get(audio)
          try {
            if (!source) {
              source = audioContext!.createMediaElementSource(audio)
              mediaSourceMap.set(audio, source)
            }
            source.connect(eqInput)
            connectedSources.push({ source, target: eqInput })
          } catch (error) {
            const isTainted = error instanceof DOMException && error.name === 'SecurityError'
            if (isTainted) {
              // 明确的安全异常才是污染证据；全零频谱也可能是正常静音。
              // 通知调用方降级重建 audio(去掉 crossOrigin)，牺牲节拍分析保播放
              taintedSourceDetected = true
              options.onTainted?.(audio)
            } else {
              console.warn('[useAudioPlayer] createMediaElementSource failed', error)
            }
          }
        })
        if (taintedSourceDetected) {
          stopBeatAnalysis()
          disconnectAnalysisGraph()
          return
        }
        eqOutput.connect(analyser)
        analyser.connect(audioContext.destination)
        frequencyData = new Uint8Array(analyser.frequencyBinCount)
        options.onEqFiltersReady?.(eqFilters)
      }
      if (audioContext.state === 'suspended') await audioContext.resume()
      if (isUnmounted) {
        // resume 挂起期间组件已卸载:onBeforeUnmount 的 suspend 先结算时,
        // 本 resume 后结算会让上下文在无消费者状态下保持 running,补一次 suspend
        void audioContext.suspend()
        return
      }
      if (audioContext.state !== 'running') {
        // Safari:媒体事件不继承用户激活态,本次 resume 未生效。
        // 手势兜底监听已注册(ensureGestureResume),下一次真实手势会自动恢复;
        // 此处不再反复重试,但继续调度 rAF 保持待命
        console.warn('[useBeatAnalyser] AudioContext 仍处于 suspended,等待用户手势恢复')
      }
      if (prefersReducedMotion) {
        pauseBeatAnalysis()
        return
      }
      if (document.hidden) {
        pauseBeatAnalysis()
      }
      if (!visibilityListenerRegistered) {
        document.addEventListener('visibilitychange', handleVisibilityChange)
        visibilityListenerRegistered = true
      }
      if (!document.hidden && !beatFrame) beatFrame = window.requestAnimationFrame(updateBeatLevel)
    } catch (error) {
      // 启动失败不再静默:此前任何异常都会永久关闭分析且无任何线索
      console.warn('[useBeatAnalyser] 启动节拍分析失败', error)
      stopBeatAnalysis()
    }
  }

  onBeforeUnmount(() => {
    isUnmounted = true
    clearDebug()
    motionQuery?.removeEventListener?.('change', handleVisibilityChange)
    stopBeatAnalysis()
    disconnectAnalysisGraph()
    // 挂起共享 AudioContext 释放音频硬件资源；SPA 生命周期内不 close，
    // 后续 startBeatAnalysis 可通过 resume() 恢复。
    if (sharedAudioContext?.state === 'running') {
      void sharedAudioContext.suspend()
    }
    if (gestureResumeRegistered) {
      document.removeEventListener('pointerdown', handleGestureResume, true)
      document.removeEventListener('keydown', handleGestureResume, true)
      gestureResumeRegistered = false
    }
    audioContext = null
  })

  // Keep pending windows near the actual playhead, including during model loading
  // and when the tab is hidden (where RAF no longer runs).
  function clearSeekSettlement(): void {
    if (seekSettleTimer !== null) clearTimeout(seekSettleTimer)
    seekSettleTimer = null
    settlingAudio = null
  }
  watch(
    () => [options.source?.value, options.mode?.value],
    () => {
      clearSeekSettlement()
      stalledAudio = null
      adoptedModelTimeline = null
      firstStartedAt = isPlaying.value && visualEnabled.value ? performance.now() : null
      firstAvailableMs = null
      resetBeatTracking()
    },
    { flush: 'sync' },
  )
  const priorityListeners: Array<() => void> = []
  for (const audio of players) {
    const updatePriority = (event?: Event): void => {
      if (audio === getActiveAudio()) {
        if (event && event.type !== 'timeupdate') {
          visualClock.reset()
        }
        preanalysis.prioritize(audio.currentTime, playbackState())
        captureDebug(event?.type !== 'timeupdate')
      }
    }
    const settleSeek = (): void => {
      if (audio !== getActiveAudio()) return
      visualClock.reset()
      clearSeekSettlement()
      settlingAudio = audio
      updatePriority()
      seekSettleTimer = setTimeout(() => {
        seekSettleTimer = null
        if (audio !== getActiveAudio()) {
          settlingAudio = null
          return
        }
        // An outstanding native seek will emit seeked later. Do not poll or
        // release its hold merely because pointer movement stopped briefly.
        if (audio.seeking) return
        settlingAudio = null
        updatePriority()
      }, SEEK_SETTLE_MS)
    }
    const resetOnSeek = (): void => {
      if (audio !== getActiveAudio()) return
      if (settlingAudio !== audio) clearDebug()
      resetBeatTracking()
      settleSeek()
    }
    const markStalled = (): void => {
      if (audio !== getActiveAudio()) return
      stalledAudio = audio
      resetBeatTracking()
      updatePriority()
    }
    const markPlaying = (): void => {
      if (audio !== getActiveAudio()) return
      stalledAudio = null
      visualClock.reset()
      updatePriority()
    }
    audio.addEventListener?.('seeking', resetOnSeek)
    audio.addEventListener?.('seeked', settleSeek)
    audio.addEventListener?.('waiting', markStalled)
    audio.addEventListener?.('playing', markPlaying)
    const stateEvents = ['timeupdate', 'pause', 'ended', 'ratechange'] as const
    for (const event of stateEvents) audio.addEventListener?.(event, updatePriority)
    priorityListeners.push(() => {
      audio.removeEventListener?.('seeking', resetOnSeek)
      audio.removeEventListener?.('seeked', settleSeek)
      audio.removeEventListener?.('waiting', markStalled)
      audio.removeEventListener?.('playing', markPlaying)
      for (const event of stateEvents) audio.removeEventListener?.(event, updatePriority)
    })
  }
  onBeforeUnmount(() => {
    clearSeekSettlement()
    for (const remove of priorityListeners) remove()
  })

  watch(
    () => [options.debugEnabled?.value, options.source?.value, options.mode?.value],
    () => {
      clearDebug()
      captureDebug(true)
    },
    { flush: 'sync', immediate: true },
  )
  watch(
    () => [
      isPlaying.value,
      visualEnabled.value,
      unavailableReason.value,
      options.beatVisualDelay?.value,
      options.beatFlashRate?.value,
    ],
    () => captureDebug(true),
    { flush: 'sync' },
  )

  return {
    beatLevel,
    spectrumLevels,
    startBeatAnalysis,
    stopBeatAnalysis,
    preanalysis,
    resetBeatTracking,
    debugSnapshot: readonly(debugSnapshot),
  }
}
