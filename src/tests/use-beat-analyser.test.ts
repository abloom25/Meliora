import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { useBeatAnalyser } from '../platform/web/useBeatAnalyser'
import { createBeatVisualRenderer } from '../platform/web/beat-visuals'
import { buildBeatTimeline } from '../platform/web/beat-preanalysis'
import type {
  BeatBuildStatus,
  BeatPreloadTarget,
  BeatTimeline,
} from '../core/analysis/beat-timeline'

vi.mock('../platform/web/beat-preanalysis', () => ({ buildBeatTimeline: vi.fn() }))
enableAutoUnmount(afterEach)

interface BuildRequest {
  source: string
  signal: AbortSignal
  onStatus: (status: BeatBuildStatus) => void
  onPartial?: (timeline: BeatTimeline) => void
  resolve: (timeline: BeatTimeline) => void
}

let buildRequests: BuildRequest[] = []
let sourceId = 0

beforeEach(() => {
  buildRequests = []
  vi.mocked(buildBeatTimeline)
    .mockReset()
    .mockImplementation(
      (source, signal, onStatus, dependencies) =>
        new Promise<BeatTimeline>((resolve) => {
          buildRequests.push({
            source,
            signal,
            onStatus,
            resolve,
            onPartial: dependencies?.onPartial,
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
    expect(h.analyser.beatLevel.value).toBeLessThan(0.2)
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

  it('samples a completed timeline at the current media position and fades it in', async () => {
    const { analyser, activeAudio } = await mountBeatHarness()
    activeAudio.currentTime = 1.1
    runFrames(20)
    expect(analyser.beatLevel.value).toBe(0)
    await finishBuild()
    runFrames(1)
    expect(analyser.beatLevel.value).toBeGreaterThan(0)
    expect(analyser.beatLevel.value).toBeLessThan(0.2)
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
