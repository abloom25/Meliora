import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { useBeatAnalyser } from '../platform/web/useBeatAnalyser'
import { createBeatVisualRenderer } from '../platform/web/beat-visuals'
import { buildBeatTimeline } from '../platform/web/beat-preanalysis'
import { useBeatThisModels, type BeatThisModelStatus } from '../platform/web/useBeatThisModels'
import type { BeatAnalysisMode } from '../core/types'
import type {
  BeatBuildStatus,
  BeatPreloadTarget,
  BeatTimeline,
} from '../core/analysis/beat-timeline'

vi.mock('../platform/web/beat-preanalysis', () => ({
  buildBeatTimeline: vi.fn(),
  protectBeatAudioSource: vi.fn(),
  persistKnownBeatCheckpoint: vi.fn(),
}))
vi.mock('../platform/web/useBeatThisModels', async () => {
  const { ref } = await import('vue')
  const status = ref({
    small: { phase: 'ready', progress: 1, error: null },
    standard: { phase: 'ready', progress: 1, error: null },
  })
  return {
    useBeatThisModels: () => ({
      initialize: async () => {},
      status,
    }),
  }
})
enableAutoUnmount(afterEach)

interface BuildRequest {
  source: string
  signal: AbortSignal
  onStatus: (status: BeatBuildStatus) => void
  onPartial?: (timeline: BeatTimeline) => void
  onPreview?: (timeline: BeatTimeline) => void
  reject: (reason: Error) => void
  resolve: (timeline: BeatTimeline) => void
}

let buildRequests: BuildRequest[] = []
let sourceId = 0
const modelStates = useBeatThisModels().status as Ref<
  Record<'small' | 'standard', BeatThisModelStatus>
>

beforeEach(() => {
  buildRequests = []
  modelStates.value = {
    small: { phase: 'ready', progress: 1, error: null },
    standard: { phase: 'ready', progress: 1, error: null },
  }
  vi.mocked(buildBeatTimeline)
    .mockReset()
    .mockImplementation(
      (source, signal, onStatus, dependencies) =>
        new Promise<BeatTimeline>((resolve, reject) => {
          buildRequests.push({
            source,
            signal,
            onStatus,
            resolve,
            reject,
            onPartial: dependencies?.onPartial,
            onPreview: dependencies?.onPreview,
          })
        }),
    )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function timelineWithPulse(): BeatTimeline {
  const levels = Float32Array.from({ length: 41 }, (_, index) =>
    index >= 10 && index <= 14 ? 1 : 0,
  )
  return {
    durationSeconds: 4,
    stepSeconds: 0.1,
    levels: [levels.slice(), levels.slice(), levels.slice(), levels.slice()],
    sustain: Float32Array.from(levels, (level) => level * 0.25),
  }
}

async function finishBuild(index = 0, timeline = timelineWithPulse()): Promise<void> {
  const request = buildRequests[index]
  if (!request) throw new Error('expected a pending timeline build')
  request.resolve(timeline)
  for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
  await nextTick()
}

function createHarness(setup: () => Record<string, unknown>) {
  return defineComponent({ setup, render: () => h('div') })
}

class AudioNodeMock {
  connections: unknown[] = []

  connect(target?: unknown) {
    this.connections.push(target)
    return target
  }

  disconnect() {
    this.connections = []
  }
}

class AnalyserNodeMock extends AudioNodeMock {
  fftSize = 0
  smoothingTimeConstant = 0
  spectrum: Uint8Array | null = null

  get frequencyBinCount() {
    return this.fftSize / 2 || 128
  }

  getByteFrequencyData(data: Uint8Array) {
    data.fill(0)
    if (this.spectrum) data.set(this.spectrum.subarray(0, data.length))
  }
}

class BiquadFilterNodeMock extends AudioNodeMock {
  type: BiquadFilterType = 'peaking'
  frequency = { value: 0 }
  Q = { value: 0 }
  gain = { value: 0 }
}

class AudioContextMock {
  static instances: AudioContextMock[] = []

  state: AudioContextState = 'running'
  readonly sampleRate = 48000
  baseLatency = 0
  outputLatency = 0
  currentTime = NaN
  getOutputTimestamp: (() => AudioTimestamp) | undefined
  destination = new AudioNodeMock() as unknown as AudioDestinationNode
  sources: unknown[] = []
  lastAnalyser: AnalyserNodeMock | null = null

  constructor() {
    AudioContextMock.instances.push(this)
  }

  createAnalyser() {
    this.lastAnalyser = new AnalyserNodeMock()
    return this.lastAnalyser as unknown as AnalyserNode
  }

  createBiquadFilter() {
    return new BiquadFilterNodeMock() as unknown as BiquadFilterNode
  }

  createMediaElementSource(audio: HTMLAudioElement) {
    const source = new AudioNodeMock()
    this.sources.push({ source, audio })
    return source as unknown as MediaElementAudioSourceNode
  }

  suspend() {
    this.state = 'suspended'
    return Promise.resolve()
  }

  resume() {
    this.state = 'running'
    return Promise.resolve()
  }
}

describe('useBeatAnalyser', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('still builds the WebAudio EQ graph under reduced motion but skips the visual RAF loop', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
    vi.stubGlobal('AudioContext', AudioContextMock)
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    const addListenerSpy = vi.spyOn(document, 'addEventListener')
    const onEqFiltersReady = vi.fn()
    const players = [new Audio('/1.mp3'), new Audio('/2.mp3'), new Audio('/3.mp3')]

    const Harness = createHarness(() => {
      const analyser = useBeatAnalyser({
        players,
        getActiveAudio: () => players[0]!,
        isPlaying: ref(true),
        source: ref(`/reduced-motion-${++sourceId}.mp3`),
        onEqFiltersReady,
      })
      return { analyser }
    })

    const wrapper = mount(Harness)
    await (wrapper.vm.analyser as ReturnType<typeof useBeatAnalyser>).startBeatAnalysis()
    await nextTick()

    expect(onEqFiltersReady).toHaveBeenCalledTimes(1)
    expect(onEqFiltersReady.mock.calls[0]?.[0]).toHaveLength(5)
    expect(rafSpy).not.toHaveBeenCalled()
    expect(buildBeatTimeline).not.toHaveBeenCalled()
    expect(addListenerSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })
})

describe('useBeatAnalyser completed timeline playback', () => {
  it('forwards live neighbor sources and the preload toggle without replacing the current timeline', async () => {
    const neighborSource = `/neighbor-${++sourceId}.mp3`
    const adjacent = ref<readonly BeatPreloadTarget[]>([
      { direction: 'next', source: neighborSource, title: 'Prepared next', durationSeconds: 4 },
    ])
    const preloadEnabled = ref(true)
    const h = await mountBeatHarness({ adjacent, preloadEnabled })
    expect(buildRequests).toHaveLength(1)
    await finishBuild()
    expect(buildRequests).toHaveLength(2)
    expect(buildRequests[1]!.source).toBe(neighborSource)
    expect(h.analyser.preanalysis.status.value.adjacent?.[0]).toMatchObject({
      source: neighborSource,
      title: 'Prepared next',
      phase: 'fetching',
    })
    const currentTimeline = h.analyser.preanalysis.timeline.value
    preloadEnabled.value = false
    await nextTick()
    expect(buildRequests[1]!.signal.aborted).toBe(true)
    expect(h.analyser.preanalysis.status.value.adjacent).toEqual([])
    expect(h.analyser.preanalysis.timeline.value).toBe(currentTimeline)
  })

  it('holds consecutive seeks until stable while rate, pause, and buffering reach the scheduler', async () => {
    const h = await mountBeatHarness()
    const dependencies = vi.mocked(buildBeatTimeline).mock.calls[0]![3]!
    const receive = vi.fn()
    const yieldWindow = vi.fn()
    // A running model window settles cooperatively; playback updates remain
    // connected until its checkpoint returns and releases the worker slot.
    dependencies.subscribeYield!(yieldWindow)
    dependencies.subscribePriority!(receive)
    h.activeAudio.currentTime = 1.1
    h.activeAudio.dispatchEvent(new Event('seeking'))
    vi.advanceTimersByTime(100)
    h.activeAudio.currentTime = 2.2
    h.activeAudio.dispatchEvent(new Event('seeked'))
    h.activeAudio.dispatchEvent(new Event('timeupdate'))
    vi.advanceTimersByTime(179)
    expect(receive.mock.calls.every(([state]) => state.seeking)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(receive).toHaveBeenLastCalledWith({
      timeSeconds: 2.2,
      playing: true,
      playbackRate: 1,
      seeking: false,
    })
    h.activeAudio.playbackRate = 2
    h.activeAudio.dispatchEvent(new Event('ratechange'))
    expect(receive.mock.lastCall![0].playbackRate).toBe(2)
    h.activeAudio.dispatchEvent(new Event('waiting'))
    expect(receive.mock.lastCall![0].playing).toBe(false)
    expect(yieldWindow).toHaveBeenCalledOnce()
    h.activeAudio.dispatchEvent(new Event('playing'))
    expect(receive.mock.lastCall![0].playing).toBe(true)
    Object.defineProperty(h.activeAudio, 'paused', { configurable: true, value: true })
    h.activeAudio.dispatchEvent(new Event('pause'))
    expect(receive.mock.lastCall![0].playing).toBe(false)
    expect(dependencies.getPlaybackState!()).toMatchObject({
      playing: false,
      playbackRate: 2,
      seeking: false,
    })
    expect(buildBeatTimeline).toHaveBeenCalledTimes(1)
  })

  it('does not release a native seek before seeked and discards settlement after a source change', async () => {
    const h = await mountBeatHarness()
    const dependencies = vi.mocked(buildBeatTimeline).mock.calls[0]![3]!
    const receive = vi.fn()
    dependencies.subscribePriority!(receive)
    Object.defineProperty(h.activeAudio, 'seeking', { configurable: true, value: true })
    h.activeAudio.currentTime = 2
    h.activeAudio.dispatchEvent(new Event('seeking'))
    vi.advanceTimersByTime(250)
    expect(receive.mock.calls.every(([state]) => state.seeking)).toBe(true)
    Object.defineProperty(h.activeAudio, 'seeking', { configurable: true, value: false })
    h.activeAudio.dispatchEvent(new Event('seeked'))
    h.source.value = '/changed-during-seek.mp3'
    vi.advanceTimersByTime(250)
    expect(receive.mock.calls.every(([state]) => state.seeking)).toBe(true)
    expect(dependencies.getPlaybackState!().seeking).toBe(false)
  })

  it('highlights a completed middle range while keeping surrounding holes dark', async () => {
    const h = await mountBeatHarness()
    const timeline = timelineWithPulse()
    for (const levels of timeline.levels) levels.fill(1)
    timeline.completedRanges = [{ startSeconds: 1, endSeconds: 2 }]
    buildRequests[0]!.onPartial!(timeline)
    h.activeAudio.currentTime = 0.5
    runFrames(30)
    expect(h.analyser.beatLevel.value).toBe(0)
    h.activeAudio.currentTime = 1.2
    runFrames(60)
    expect(h.analyser.beatLevel.value).toBeGreaterThan(0.99)
    h.activeAudio.currentTime = 2.2
    runFrames(1)
    expect(h.analyser.beatLevel.value).toBe(0)
    timeline.completedRanges = [{ startSeconds: 1, endSeconds: 3 }]
    buildRequests[0]!.onPartial!({ ...timeline })
    runFrames(1)
    expect(h.analyser.beatLevel.value).toBeGreaterThan(0)
    expect(h.analyser.beatLevel.value).toBe(1)
  })

  it('forwards seek and normal playback positions to the existing background build', async () => {
    const h = await mountBeatHarness()
    const dependencies = vi.mocked(buildBeatTimeline).mock.calls[0]![3]!
    const receive = vi.fn()
    dependencies.subscribePriority!(receive)
    h.activeAudio.currentTime = 2.1
    h.activeAudio.dispatchEvent(new Event('seeking'))
    expect(receive).toHaveBeenLastCalledWith({
      timeSeconds: 2.1,
      playing: true,
      playbackRate: 1,
      seeking: true,
    })
    h.activeAudio.currentTime = 3.2
    h.activeAudio.dispatchEvent(new Event('timeupdate'))
    expect(receive).toHaveBeenLastCalledWith({
      timeSeconds: 3.2,
      playing: true,
      playbackRate: 1,
      seeking: true,
    })
    expect(dependencies.getPrioritySeconds!()).toBe(3.2)
    expect(buildBeatTimeline).toHaveBeenCalledTimes(1)
    expect(buildRequests[0]!.signal.aborted).toBe(false)
  })

  it('extends partial coverage without blanking an ongoing pulse or repeating its fade-in', async () => {
    const h = await mountBeatHarness()
    h.activeAudio.currentTime = 1.2
    buildRequests[0]!.onPartial!({ ...timelineWithPulse(), builtUntilSeconds: 2 })
    runFrames(70)
    expect(h.analyser.beatLevel.value).toBeGreaterThan(0.99)
    buildRequests[0]!.onPartial!({ ...timelineWithPulse(), builtUntilSeconds: 3 })
    expect(h.analyser.beatLevel.value).toBeGreaterThan(0.99)
    await finishBuild()
    expect(h.analyser.beatLevel.value).toBeGreaterThan(0.99)
  })
  let rafCallbacks: FrameRequestCallback[] = []

  function installRafMock() {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => {
      rafCallbacks[handle - 1] = () => {}
    })
  }

  function runFrames(count: number, stepMs = 16) {
    for (let frame = 0; frame < count; frame += 1) {
      vi.advanceTimersByTime(stepMs)
      const callbacks = rafCallbacks
      rafCallbacks = []
      callbacks.forEach((callback) => callback(performance.now()))
    }
  }

  function stubMatchMedia() {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: false,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    )
  }

  interface BeatHarness {
    analyser: ReturnType<typeof useBeatAnalyser>
    analyserNode: AnalyserNodeMock
    spectrum: Uint8Array
    activeAudio: HTMLAudioElement
    source: Ref<string>
    enabled: Ref<boolean>
    beatVisualDelay: Ref<number>
    beatFlashRate: Ref<number>
  }

  async function mountBeatHarness(
    options: {
      spectrumTarget?: HTMLElement
      activeAudio?: HTMLAudioElement
      onTainted?: (audio: HTMLAudioElement) => void
      beatVisualDelay?: number
      adjacent?: Ref<readonly BeatPreloadTarget[]>
      preloadEnabled?: Ref<boolean>
      debugEnabled?: Ref<boolean>
      debugSampleIntervalMs?: Ref<number>
      mode?: Ref<BeatAnalysisMode>
      onBeat?: (level: number, sustain: number) => void
      visualIntervalMs?: Ref<number>
      observeVisualFrame?: (now: number) => void
    } = {},
  ): Promise<BeatHarness> {
    stubMatchMedia()
    vi.stubGlobal('AudioContext', AudioContextMock)
    installRafMock()
    const activeAudio = options.activeAudio ?? new Audio(`/timeline-${++sourceId}.mp3`)
    if (!options.activeAudio) {
      Object.defineProperty(activeAudio, 'paused', {
        configurable: true,
        writable: true,
        value: false,
      })
    }
    Object.defineProperty(activeAudio, 'readyState', {
      configurable: true,
      writable: true,
      value: HTMLMediaElement.HAVE_ENOUGH_DATA,
    })
    const source = ref(`/analysis-source-${++sourceId}.mp3`)
    const enabled = ref(true)
    const beatVisualDelay = ref(options.beatVisualDelay ?? 0)
    const beatFlashRate = ref(1)
    let analyserApi: ReturnType<typeof useBeatAnalyser> | null = null
    const Harness = createHarness(() => {
      analyserApi = useBeatAnalyser({
        players: [activeAudio],
        getActiveAudio: () => activeAudio,
        isPlaying: ref(true),
        source,
        enabled,
        debugEnabled: options.debugEnabled,
        debugSampleIntervalMs: options.debugSampleIntervalMs,
        mode: options.mode,
        onBeat: options.onBeat,
        visualIntervalMs: options.visualIntervalMs,
        observeVisualFrame: options.observeVisualFrame,
        adjacent: options.adjacent,
        preloadEnabled: options.preloadEnabled,
        onSpectrum: createBeatVisualRenderer({
          getSpectrumTargets: options.spectrumTarget ? () => [options.spectrumTarget] : undefined,
        }).renderSpectrum,
        onTainted: options.onTainted,
        beatVisualDelay,
        beatFlashRate,
      })
      return {}
    })
    mount(Harness)
    const analyser = analyserApi as unknown as ReturnType<typeof useBeatAnalyser>
    await analyser.startBeatAnalysis()
    const context = AudioContextMock.instances.at(-1)
    if (context) {
      context.baseLatency = 0
      context.outputLatency = 0
      context.currentTime = NaN
      context.getOutputTimestamp = undefined
    }
    const analyserNode = context?.lastAnalyser
    if (!analyserNode) throw new Error('analyser mock not created')
    // 48kHz / fftSize 2048 → bin 宽约 23.4Hz;测试频谱按 bin 直接构造
    const spectrum = new Uint8Array(analyserNode.frequencyBinCount)
    analyserNode.spectrum = spectrum
    return {
      analyser,
      analyserNode,
      spectrum,
      activeAudio,
      source,
      enabled,
      beatVisualDelay,
      beatFlashRate,
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    rafCallbacks = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps highlights dark before the whole timeline completes despite loud live bass', async () => {
    const { analyser, spectrum } = await mountBeatHarness()
    expect(buildRequests).toHaveLength(1)
    for (const phase of ['fetching', 'decoding', 'analysing'] as const) {
      buildRequests[0]!.onStatus({ phase, progress: 0.99, error: null })
      for (let index = 1; index <= 6; index += 1) spectrum[index] = 250
      runFrames(10)
      expect(analyser.beatLevel.value).toBe(0)
      expect(analyser.preanalysis.timeline.value).toBeNull()
    }
  })

  it('throttles background sampling while still measuring every real RAF and restores full cadence', async () => {
    const interval = ref(1000 / 30)
    const observe = vi.fn()
    const h = await mountBeatHarness({ visualIntervalMs: interval, observeVisualFrame: observe })
    const sample = vi.spyOn(h.analyserNode, 'getByteFrequencyData')
    runFrames(60)
    expect(observe).toHaveBeenCalledTimes(60)
    expect(sample.mock.calls.length).toBeGreaterThanOrEqual(29)
    expect(sample.mock.calls.length).toBeLessThanOrEqual(31)
    sample.mockClear()
    interval.value = 0
    runFrames(30)
    expect(sample).toHaveBeenCalledTimes(30)
  })

  it('uses provisional coverage immediately without calling it verified model progress', async () => {
    const h = await mountBeatHarness({ mode: ref('beat-this-small'), debugEnabled: ref(true) })
    h.activeAudio.currentTime = 1.1
    buildRequests[0]!.onPreview!({ ...timelineWithPulse(), builtUntilSeconds: 2 })
    runFrames(1, 110)
    expect(h.analyser.beatLevel.value).toBe(1)
    expect(h.analyser.preanalysis.timeline.value).toBeNull()
    expect(h.analyser.preanalysis.status.value.progress).toBe(0)
    expect(h.analyser.debugSnapshot.value?.current.timing?.timelineSource).toBe('provisional')
    h.activeAudio.currentTime = 3
    runFrames(1, 110)
    expect(h.analyser.beatLevel.value).toBe(0)
    expect(h.analyser.debugSnapshot.value?.current.reason).toBe('range-unbuilt')
  })

  it('does not reflash a shifted model pulse or its long tail during handoff', async () => {
    const h = await mountBeatHarness({ mode: ref('beat-this-small'), debugEnabled: ref(true) })
    const preview = timelineWithPulse()
    buildRequests[0]!.onPreview!(preview)
    h.activeAudio.currentTime = 1
    runFrames(1)
    expect(h.analyser.beatLevel.value).toBe(1)
    const values = Float32Array.from({ length: 401 }, (_, index) => {
      const time = index / 100
      if (time < 1.05) return 0
      if (time < 1.55) return 1 - (time - 1.05) * 1.2
      if (time < 1.65) return 0
      if (time < 1.8) return 0.9
      return 0
    })
    const formal: BeatTimeline = {
      durationSeconds: 4,
      stepSeconds: 0.01,
      levels: [values.slice(), values.slice(), values.slice(), values.slice()],
      sustain: Float32Array.from(values, (value) => value * 0.25),
    }
    await finishBuild(0, formal)
    h.activeAudio.currentTime = 1.02
    runFrames(1)
    expect(h.analyser.beatLevel.value).toBe(0)
    for (let index = 0; index < 32; index += 1) {
      h.activeAudio.currentTime += 0.016
      runFrames(1)
      expect(h.analyser.beatLevel.value).toBe(0)
    }
    expect(h.analyser.debugSnapshot.value?.current.timing?.timelineSource).toBe('model')
    h.activeAudio.currentTime = 1.6
    runFrames(1)
    h.activeAudio.currentTime = 1.7
    runFrames(1)
    expect(h.analyser.beatLevel.value).toBeCloseTo(0.9)
  })

  it('does not treat a late first model sample as a new attack during an existing tail', async () => {
    const h = await mountBeatHarness({ mode: ref('beat-this-small') })
    const preview = timelineWithPulse()
    preview.levels.forEach((values) => {
      values[11] = 0.2
      values[12] = 0.1
    })
    buildRequests[0]!.onPreview!(preview)
    h.activeAudio.currentTime = 1
    runFrames(1)
    h.activeAudio.currentTime = 1.1
    runFrames(1, 100)
    expect(h.analyser.beatLevel.value).toBeCloseTo(0.2)
    const model = timelineWithPulse()
    model.levels.forEach((values) => values.fill(0.5))
    await finishBuild(0, model)
    h.activeAudio.currentTime = 1.116
    runFrames(1)
    expect(h.analyser.beatLevel.value).toBeCloseTo(0.2)
    runFrames(20)
    expect(h.analyser.beatLevel.value).toBeCloseTo(0.2)
  })

  it('preserves provisional light on model failure but clears it on source/mode changes', async () => {
    const mode = ref<BeatAnalysisMode>('beat-this-small')
    const h = await mountBeatHarness({ mode, debugEnabled: ref(true) })
    h.activeAudio.currentTime = 1.1
    buildRequests[0]!.onPreview!(timelineWithPulse())
    runFrames(1, 110)
    buildRequests[0]!.reject(new Error('模型推理失败'))
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve()
    runFrames(1, 110)
    expect(h.analyser.beatLevel.value).toBe(1)
    expect(h.analyser.debugSnapshot.value?.current.timing?.timelineSource).toBe('provisional')
    mode.value = 'beat-this-standard'
    expect(h.analyser.preanalysis.provisionalTimeline.value).toBeNull()
    expect(h.analyser.beatLevel.value).toBe(0)
    await h.analyser.startBeatAnalysis()
    await nextTick()
    buildRequests[1]!.onPreview!(timelineWithPulse())
    runFrames(1)
    expect(h.analyser.beatLevel.value).toBe(1)
    h.source.value = `/preview-replaced-${++sourceId}.mp3`
    expect(h.analyser.preanalysis.provisionalTimeline.value).toBeNull()
    expect(h.analyser.beatLevel.value).toBe(0)
  })

  it('does not fall back to an older preview inside an interval already adopted from the model', async () => {
    const h = await mountBeatHarness({ mode: ref('beat-this-small'), debugEnabled: ref(true) })
    h.activeAudio.currentTime = 1.1
    buildRequests[0]!.onPreview!(timelineWithPulse())
    const model = timelineWithPulse()
    model.levels.forEach((values) => values.fill(0.2))
    buildRequests[0]!.onPartial!({
      ...model,
      completedRanges: [{ startSeconds: 1, endSeconds: 2 }],
    })
    runFrames(1, 110)
    expect(h.analyser.beatLevel.value).toBeCloseTo(0.2)
    // A later partial must not resurrect the older, much stronger approximation.
    buildRequests[0]!.onPartial!({
      ...model,
      completedRanges: [{ startSeconds: 2, endSeconds: 3 }],
    })
    runFrames(1, 110)
    expect(h.analyser.beatLevel.value).toBe(0)
    expect(h.analyser.debugSnapshot.value!.current.timing?.timelineSource).toBe('none')
  })

  it('allows the next fast subdivision through even when the previous model tail has no low valley', async () => {
    const h = await mountBeatHarness({ mode: ref('beat-this-small') })
    h.activeAudio.currentTime = 1
    buildRequests[0]!.onPreview!(timelineWithPulse())
    runFrames(1)
    const values = Float32Array.from({ length: 801 }, (_, index) => {
      const time = index / 200
      if (time < 1.05) return 0.21
      const phase = (time - 1.05 + 1e-8) % 0.125
      return Math.max(0.21, 1 - phase / 0.08)
    })
    await finishBuild(0, {
      durationSeconds: 4,
      stepSeconds: 0.005,
      levels: [values.slice(), values.slice(), values.slice(), values.slice()],
      sustain: new Float32Array(801),
    })
    h.activeAudio.currentTime = 1.02
    runFrames(1)
    h.activeAudio.currentTime = 1.05
    runFrames(1, 30)
    expect(h.analyser.beatLevel.value).toBeCloseTo(0.21)
    h.activeAudio.currentTime = 1.15
    runFrames(1, 100)
    h.activeAudio.currentTime = 1.175
    runFrames(1, 25)
    expect(h.analyser.beatLevel.value).toBeCloseTo(1)
  })

  it('keeps finished preview coverage after an asset-read error and clears it when removed', async () => {
    const h = await mountBeatHarness({ mode: ref('beat-this-small'), debugEnabled: ref(true) })
    h.activeAudio.currentTime = 1.1
    buildRequests[0]!.onPreview!(timelineWithPulse())
    runFrames(1, 110)
    modelStates.value = {
      ...modelStates.value,
      small: { phase: 'error', progress: 0, error: '模型读取失败' },
    }
    runFrames(1, 110)
    expect(h.analyser.beatLevel.value).toBe(1)
    expect(h.analyser.debugSnapshot.value?.current.reason).toBe('ready')
    modelStates.value = {
      ...modelStates.value,
      small: { phase: 'missing', progress: 0, error: null },
    }
    runFrames(1, 110)
    expect(h.analyser.preanalysis.provisionalTimeline.value).toBeNull()
    expect(h.analyser.beatLevel.value).toBe(0)
  })

  it('resumes an already built position immediately after native seeked while scheduling settles', async () => {
    const h = await mountBeatHarness()
    await finishBuild()
    h.activeAudio.currentTime = 1.1
    Object.defineProperty(h.activeAudio, 'seeking', {
      configurable: true,
      writable: true,
      value: true,
    })
    h.activeAudio.dispatchEvent(new Event('seeking'))
    runFrames(1)
    expect(h.analyser.beatLevel.value).toBe(0)
    Object.defineProperty(h.activeAudio, 'seeking', { configurable: true, value: false })
    h.activeAudio.dispatchEvent(new Event('seeked'))
    runFrames(1)
    expect(h.analyser.beatLevel.value).toBe(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
  })

  it('uses output timestamps without duplicate latency and debug opening does not resample them', async () => {
    const debugEnabled = ref(false)
    const h = await mountBeatHarness({ debugEnabled, beatVisualDelay: 50 })
    await finishBuild()
    const context = AudioContextMock.instances.at(-1)!
    context.currentTime = 10
    context.baseLatency = 0.05
    context.outputLatency = 0.1
    context.getOutputTimestamp = vi.fn(() => ({
      contextTime: 9.9,
      performanceTime: performance.now(),
    }))
    h.activeAudio.currentTime = 1.3
    runFrames(1, 110)
    expect(h.analyser.beatLevel.value).toBe(1)
    const reads = vi.mocked(context.getOutputTimestamp).mock.calls.length
    debugEnabled.value = true
    debugEnabled.value = false
    debugEnabled.value = true
    expect(context.getOutputTimestamp).toHaveBeenCalledTimes(reads)
    const sample = h.analyser.debugSnapshot.value!.current
    expect(sample.sampleSeconds).toBeCloseTo(1.15)
    expect(sample.delayMs).toBeCloseTo(150)
    expect(sample.timing?.clockSource).toBe('output-timestamp')
    context.getOutputTimestamp = () => {
      throw new Error('device changed')
    }
    runFrames(1, 110)
    expect(h.analyser.debugSnapshot.value!.current.timing?.clockSource).toBe('latency-fallback')
    expect(h.analyser.debugSnapshot.value!.current.sampleSeconds).toBeCloseTo(1.1)
  })

  it('turns off immediately on waiting even before readyState catches up and reanchors on playing', async () => {
    const h = await mountBeatHarness({ debugEnabled: ref(true) })
    await finishBuild()
    h.activeAudio.currentTime = 1.1
    runFrames(1, 110)
    h.activeAudio.dispatchEvent(new Event('waiting'))
    expect(h.analyser.beatLevel.value).toBe(0)
    runFrames(1, 110)
    expect(h.analyser.debugSnapshot.value!.current.reason).toBe('buffering')
    h.activeAudio.dispatchEvent(new Event('playing'))
    runFrames(1, 110)
    expect(h.analyser.beatLevel.value).toBe(1)
    expect(h.analyser.debugSnapshot.value!.current.timing?.firstAvailableMs).toBe(110)
  })

  it('collects no debug samples or extra frame loops until opened and clears them when closed', async () => {
    const debugEnabled = ref(false)
    const h = await mountBeatHarness({ debugEnabled })
    await finishBuild()
    h.activeAudio.currentTime = 1.1
    runFrames(20)
    expect(h.analyser.debugSnapshot.value).toBeNull()
    const framesBefore = rafCallbacks.length
    const timersBefore = vi.getTimerCount()
    debugEnabled.value = true
    expect(h.analyser.debugSnapshot.value?.history).toHaveLength(1)
    expect(rafCallbacks).toHaveLength(framesBefore)
    expect(vi.getTimerCount()).toBe(timersBefore)
    runFrames(60)
    expect(h.analyser.debugSnapshot.value!.history.length).toBeGreaterThan(5)
    expect(h.analyser.debugSnapshot.value!.history.length).toBeLessThanOrEqual(11)
    debugEnabled.value = false
    runFrames(60)
    expect(h.analyser.debugSnapshot.value).toBeNull()
    expect(h.analyser.preanalysis.debugSnapshot.value).toBeNull()
    debugEnabled.value = true
    expect(h.analyser.debugSnapshot.value?.history).toHaveLength(1)
  })

  it('reports actual output, raw timeline values, ready mix and compensated sample time', async () => {
    const onBeat = vi.fn()
    const h = await mountBeatHarness({ debugEnabled: ref(true), beatVisualDelay: 100, onBeat })
    await finishBuild()
    h.activeAudio.currentTime = 1.3
    runFrames(1, 120)
    const sample = h.analyser.debugSnapshot.value!.current
    expect(sample).toMatchObject({
      rawLevel: 1,
      rawSustain: 0.25,
      playbackSeconds: 1.3,
      sampleSeconds: 1.2,
      reason: 'ready',
      canHighlight: true,
    })
    expect(sample.level).toBeCloseTo(sample.rawLevel * sample.readyMix)
    expect(sample.delayMs).toBeCloseTo(100)
    expect(sample.sustain).toBeGreaterThan(0)
    expect(sample.sustain).toBeLessThan(sample.rawSustain)
    expect(onBeat).toHaveBeenLastCalledWith(sample.level, sample.sustain)
    expect(sample.readyMix).toBe(1)
    expect(sample.timing).toMatchObject({
      clockSource: 'latency-fallback',
      timelineSource: 'basic',
      firstAvailableMs: 120,
      lastWriteAtMs: 120,
      handoffPending: false,
    })
  })

  it('raises comparison sampling cadence without an extra render loop and restores normal cadence', async () => {
    const debugSampleIntervalMs = ref(1000 / 30)
    const onBeat = vi.fn()
    const h = await mountBeatHarness({
      debugEnabled: ref(true),
      debugSampleIntervalMs,
      onBeat,
    })
    await finishBuild()
    h.activeAudio.currentTime = 1.1
    const framesBefore = rafCallbacks.length
    const timersBefore = vi.getTimerCount()
    runFrames(30, 34)
    const snapshot = h.analyser.debugSnapshot.value!
    expect(snapshot.history.length).toBeGreaterThanOrEqual(30)
    expect(onBeat).toHaveBeenLastCalledWith(snapshot.current.level, snapshot.current.sustain)
    expect(rafCallbacks).toHaveLength(framesBefore)
    expect(vi.getTimerCount()).toBe(timersBefore)
    debugSampleIntervalMs.value = 100
    runFrames(30, 34)
    expect(h.analyser.debugSnapshot.value!.history.length - snapshot.history.length).toBe(10)
    debugSampleIntervalMs.value = 0
    runFrames(1000, 34)
    const history = h.analyser.debugSnapshot.value!.history
    expect(history.length).toBeLessThanOrEqual(601)
    expect(history.at(-1)!.sampledAtMs - history[0]!.sampledAtMs).toBeLessThanOrEqual(20_000)
  })

  it('bounds history to twenty seconds and breaks it at a seek and a source change', async () => {
    const h = await mountBeatHarness({ debugEnabled: ref(true) })
    await finishBuild()
    h.activeAudio.currentTime = 1.1
    runFrames(260, 100)
    const history = h.analyser.debugSnapshot.value!.history
    expect(history.length).toBeLessThanOrEqual(201)
    expect(history.at(-1)!.sampledAtMs - history[0]!.sampledAtMs).toBeLessThanOrEqual(20_000)
    Object.defineProperty(h.activeAudio, 'seeking', { configurable: true, value: true })
    h.activeAudio.currentTime = 2.2
    h.activeAudio.dispatchEvent(new Event('seeking'))
    expect(h.analyser.debugSnapshot.value?.history).toHaveLength(1)
    expect(h.analyser.debugSnapshot.value?.current).toMatchObject({
      reason: 'seeking',
      canHighlight: false,
      level: 0,
      playbackSeconds: 2.2,
    })
    h.source.value = '/debug-new-song.mp3'
    expect(h.analyser.debugSnapshot.value?.source).toBe('/debug-new-song.mp3')
    expect(h.analyser.debugSnapshot.value?.history).toHaveLength(1)
    expect(h.analyser.debugSnapshot.value?.current.rawLevel).toBe(0)
  })

  it('explains missing coverage, buffering, pause and disabled output without inventing values', async () => {
    const h = await mountBeatHarness({ debugEnabled: ref(true) })
    runFrames(1, 110)
    expect(h.analyser.debugSnapshot.value?.current.reason).toBe('timeline-missing')
    const partial = {
      ...timelineWithPulse(),
      completedRanges: [{ startSeconds: 1, endSeconds: 2 }],
    }
    buildRequests[0]!.onPartial!(partial)
    h.activeAudio.currentTime = 3
    runFrames(1, 110)
    expect(h.analyser.debugSnapshot.value?.current).toMatchObject({
      reason: 'range-unbuilt',
      rawLevel: 0,
      level: 0,
    })
    Object.defineProperty(h.activeAudio, 'readyState', {
      configurable: true,
      value: HTMLMediaElement.HAVE_CURRENT_DATA,
    })
    runFrames(1, 110)
    expect(h.analyser.debugSnapshot.value?.current.reason).toBe('buffering')
    Object.defineProperty(h.activeAudio, 'paused', { configurable: true, value: true })
    h.activeAudio.dispatchEvent(new Event('pause'))
    expect(h.analyser.debugSnapshot.value?.current.reason).toBe('paused')
    h.enabled.value = false
    expect(h.analyser.debugSnapshot.value?.current.reason).toBe('disabled')
  })

  it('passes the first available pulse through immediately and smooths only its sustain', async () => {
    const { analyser, activeAudio } = await mountBeatHarness()
    activeAudio.currentTime = 1.1
    runFrames(20)
    expect(analyser.beatLevel.value).toBe(0)
    await finishBuild()
    runFrames(1)
    expect(analyser.beatLevel.value).toBeGreaterThan(0)
    expect(analyser.beatLevel.value).toBe(1)
    runFrames(60)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    activeAudio.currentTime = 2
    runFrames(1)
    expect(analyser.beatLevel.value).toBe(0)
  })

  it('reuses the completed timeline across pause, resume, seeks and density changes', async () => {
    const { analyser, activeAudio, beatFlashRate } = await mountBeatHarness()
    const timeline = timelineWithPulse()
    timeline.levels[3].fill(0.3)
    await finishBuild(0, timeline)
    activeAudio.currentTime = 1.1
    runFrames(60)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    analyser.stopBeatAnalysis()
    expect(analyser.beatLevel.value).toBe(0)
    expect(analyser.preanalysis.timeline.value).toBe(timeline)
    await analyser.startBeatAnalysis()
    activeAudio.currentTime = 2
    activeAudio.dispatchEvent(new Event('seeking'))
    runFrames(60)
    expect(analyser.beatLevel.value).toBe(0)
    activeAudio.currentTime = 1.1
    activeAudio.dispatchEvent(new Event('seeking'))
    runFrames(60)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    beatFlashRate.value = 4
    runFrames(1)
    expect(analyser.beatLevel.value).toBeCloseTo(0.3, 2)
    expect(buildBeatTimeline).toHaveBeenCalledTimes(1)
  })

  it('writes per-band spectrum CSS variables directly to the meter target', async () => {
    const target = document.createElement('span')
    document.body.append(target)
    const { spectrum } = await mountBeatHarness({ spectrumTarget: target })

    for (let index = 1; index <= 6; index += 1) spectrum[index] = 240
    runFrames(3)

    expect(target.style.getPropertyValue('--spectrum-level-0')).toMatch(/%$/)
    expect(target.style.getPropertyValue('--spectrum-level-4')).toMatch(/%$/)
    target.remove()
  })

  it('keeps spectrum bars in a lively mid range under constant full-spectrum audio', async () => {
    const { analyser, spectrum } = await mountBeatHarness()

    for (let index = 1; index <= 200; index += 1) spectrum[index] = 200
    runFrames(200)

    // 自适应归一化:稳态下既不顶满也不贴地(空段坐在 0.08 地板上)
    for (const level of analyser.spectrumLevels.value) {
      expect(level).toBeLessThan(0.75)
      expect(level).toBeGreaterThan(0.07)
    }
  })

  it('lifts the matching band when spectral content changes', async () => {
    const { analyser, spectrum } = await mountBeatHarness()

    for (let index = 1; index <= 200; index += 1) spectrum[index] = 140
    runFrames(200)
    // 基线收敛后突然抬高 high 段(1.5–5kHz,bin 64–213)
    for (let index = 64; index <= 213; index += 1) spectrum[index] = 255
    runFrames(4)

    const levels = analyser.spectrumLevels.value
    expect(levels[3]).toBeGreaterThan(levels[0] ?? 0)
    expect(levels[3]).toBeGreaterThan(levels[4] ?? 0)
  })

  it('discards an old source build and clears the old highlight before the new source completes', async () => {
    const { analyser, activeAudio, source } = await mountBeatHarness()
    source.value = `/replacement-${++sourceId}.mp3`
    expect(buildRequests[0]!.signal.aborted).toBe(true)
    await analyser.startBeatAnalysis()
    // The cancelled decoder keeps the single work slot until it settles.
    expect(buildRequests).toHaveLength(1)
    activeAudio.currentTime = 1.1
    await finishBuild(0)
    expect(buildRequests).toHaveLength(2)
    runFrames(60)
    expect(analyser.preanalysis.timeline.value).toBeNull()
    expect(analyser.beatLevel.value).toBe(0)
    await finishBuild(1)
    runFrames(60)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    source.value = `/third-${++sourceId}.mp3`
    expect(analyser.preanalysis.timeline.value).toBeNull()
    expect(analyser.beatLevel.value).toBe(0)
    runFrames(10)
    expect(analyser.beatLevel.value).toBe(0)
  })

  it('reads the timeline behind the media position by current output and manual latency', async () => {
    const { analyser, activeAudio, beatVisualDelay } = await mountBeatHarness({
      beatVisualDelay: 100,
    })
    const context = AudioContextMock.instances.at(-1)
    if (!context) throw new Error('context mock missing')
    context.baseLatency = 0.025
    context.outputLatency = 0.075
    await finishBuild()
    activeAudio.currentTime = 1.05
    runFrames(60)
    expect(analyser.beatLevel.value).toBe(0)
    activeAudio.currentTime = 1.3
    runFrames(1)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    beatVisualDelay.value = 400
    runFrames(1)
    expect(analyser.beatLevel.value).toBe(0)
    expect(buildBeatTimeline).toHaveBeenCalledTimes(1)
  })

  it('allows negative offsets to advance a known pulse and scales time offsets by playback rate', async () => {
    const { analyser, activeAudio, beatVisualDelay } = await mountBeatHarness()
    await finishBuild()
    activeAudio.currentTime = 0.8
    runFrames(60)
    expect(analyser.beatLevel.value).toBe(0)
    beatVisualDelay.value = -200
    runFrames(1)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    activeAudio.currentTime = 0.65
    runFrames(1)
    expect(analyser.beatLevel.value).toBe(0)
    activeAudio.playbackRate = 2
    runFrames(1)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    expect(buildBeatTimeline).toHaveBeenCalledTimes(1)
  })

  it('stops visual output immediately when beat flashes are disabled', async () => {
    const { analyser, activeAudio, enabled } = await mountBeatHarness()
    await finishBuild()
    activeAudio.currentTime = 1.1
    runFrames(60)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    enabled.value = false
    expect(analyser.beatLevel.value).toBe(0)
    runFrames(1)
    expect(analyser.beatLevel.value).toBe(0)
  })

  it('keeps a stalled media element dark and reuses its timeline after buffering ends', async () => {
    const { analyser, activeAudio } = await mountBeatHarness()
    await finishBuild()
    activeAudio.currentTime = 1.1
    runFrames(60)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    Object.defineProperty(activeAudio, 'readyState', {
      configurable: true,
      value: HTMLMediaElement.HAVE_CURRENT_DATA,
    })
    runFrames(1)
    expect(analyser.beatLevel.value).toBe(0)
    Object.defineProperty(activeAudio, 'readyState', {
      configurable: true,
      value: HTMLMediaElement.HAVE_ENOUGH_DATA,
    })
    runFrames(60)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.99)
    expect(buildBeatTimeline).toHaveBeenCalledTimes(1)
  })

  it('does not accumulate tainted silence across a long hidden gap', async () => {
    const activeAudio = { paused: false, currentTime: 0 } as HTMLAudioElement
    const onTainted = vi.fn()
    await mountBeatHarness({ activeAudio, onTainted })

    // 播放推进 + 频谱全零(真实静音段),挂起 5 分钟后再跑一帧:
    // 后台时长不得一次性计入 3s 污染宽限
    runFrames(1)
    activeAudio.currentTime = 1
    vi.advanceTimersByTime(300000)
    const callbacks = rafCallbacks
    rafCallbacks = []
    callbacks.forEach((callback) => callback(performance.now()))
    runFrames(20)

    expect(onTainted).not.toHaveBeenCalled()
  })

  it('keeps normal advancing silence from rebuilding the audio or disabling EQ', async () => {
    const activeAudio = { paused: false, currentTime: 0 } as HTMLAudioElement
    const onTainted = vi.fn()
    const { spectrum } = await mountBeatHarness({ activeAudio, onTainted })
    for (let frame = 0; frame < 400; frame += 1) {
      activeAudio.currentTime += 0.016
      runFrames(1)
    }
    expect(onTainted).not.toHaveBeenCalled()
    spectrum[2] = 245
    runFrames(2)
    expect(onTainted).not.toHaveBeenCalled()
  })

  it('does not mistake a suspended AudioContext (Safari pre-gesture) for CORS taint', async () => {
    const activeAudio = { paused: false, currentTime: 0 } as HTMLAudioElement
    const onTainted = vi.fn()
    await mountBeatHarness({ activeAudio, onTainted })
    const context = AudioContextMock.instances.at(-1)
    if (!context) throw new Error('context mock not found')
    // Safari:媒体事件不继承用户激活态,resume 未生效,上下文停在 suspended,
    // analyser 输出全零——这不是跨源污染,累计多久都不得触发降级重建
    context.state = 'suspended'
    try {
      activeAudio.currentTime = 1
      runFrames(250)
      expect(onTainted).not.toHaveBeenCalled()
    } finally {
      context.state = 'running'
    }
  })

  it('resumes a suspended AudioContext on the next real user gesture', async () => {
    const activeAudio = { paused: false, currentTime: 0 } as HTMLAudioElement
    await mountBeatHarness({ activeAudio })
    const context = AudioContextMock.instances.at(-1)
    if (!context) throw new Error('context mock not found')
    context.state = 'suspended'
    try {
      document.dispatchEvent(new Event('pointerdown'))
      expect(context.state).toBe('running')
    } finally {
      context.state = 'running'
    }
  })
})

describe('useBeatAnalyser explicit source errors', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it.each([
    ['SecurityError', true],
    ['InvalidStateError', false],
  ] as const)('only degrades on an explicit security error (%s)', async (name, shouldDegrade) => {
    vi.resetModules()
    class RejectingContext extends AudioContextMock {
      override createMediaElementSource(): MediaElementAudioSourceNode {
        throw new DOMException('source rejected', name)
      }
    }
    vi.stubGlobal('AudioContext', RejectingContext)
    const onTainted = vi.fn()
    const onEqFiltersReady = vi.fn()
    const { useBeatAnalyser: useFreshAnalyser } = await import('../platform/web/useBeatAnalyser')
    const audio = new Audio('/safe.mp3')
    const wrapper = mount(
      createHarness(() => ({
        analyser: useFreshAnalyser({
          players: [audio],
          getActiveAudio: () => audio,
          isPlaying: ref(false),
          onTainted,
          onEqFiltersReady,
        }),
      })),
    )
    await (wrapper.vm.analyser as ReturnType<typeof useBeatAnalyser>).startBeatAnalysis()
    expect(onTainted).toHaveBeenCalledTimes(shouldDegrade ? 1 : 0)
    wrapper.unmount()
  })
})
