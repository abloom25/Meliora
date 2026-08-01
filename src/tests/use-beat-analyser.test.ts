import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { useBeatAnalyser } from '../composables/useBeatAnalyser'

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

    const Harness = defineComponent({
      setup() {
        const analyser = useBeatAnalyser({
          players,
          getActiveAudio: () => players[0]!,
          isPlaying: ref(true),
          onEqFiltersReady,
        })
        return { analyser }
      },
      render() {
        return h('div')
      },
    })

    const wrapper = mount(Harness)
    await (wrapper.vm.analyser as ReturnType<typeof useBeatAnalyser>).startBeatAnalysis()
    await nextTick()

    expect(onEqFiltersReady).toHaveBeenCalledTimes(1)
    expect(onEqFiltersReady.mock.calls[0]?.[0]).toHaveLength(5)
    expect(rafSpy).not.toHaveBeenCalled()
    expect(addListenerSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })
})

describe('useBeatAnalyser beat detection', () => {
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
  }

  async function mountBeatHarness(
    options: { spectrumTarget?: HTMLElement } = {},
  ): Promise<BeatHarness> {
    stubMatchMedia()
    vi.stubGlobal('AudioContext', AudioContextMock)
    installRafMock()
    // currentTime 恒为 0:不产生播放推进,CORS 全零检测不会误触发
    const activeAudio = { paused: false, currentTime: 0 } as HTMLAudioElement
    let analyserApi: ReturnType<typeof useBeatAnalyser> | null = null
    const Harness = defineComponent({
      setup() {
        analyserApi = useBeatAnalyser({
          players: [activeAudio],
          getActiveAudio: () => activeAudio,
          isPlaying: ref(true),
          getSpectrumTargets: options.spectrumTarget ? () => [options.spectrumTarget] : undefined,
        })
        return () => h('div')
      },
    })
    mount(Harness)
    const analyser = analyserApi as unknown as ReturnType<typeof useBeatAnalyser>
    await analyser.startBeatAnalysis()
    const context = AudioContextMock.instances.at(-1)
    const analyserNode = context?.lastAnalyser
    if (!analyserNode) throw new Error('analyser mock not created')
    // 48kHz / fftSize 2048 → bin 宽约 23.4Hz;测试频谱按 bin 直接构造
    const spectrum = new Uint8Array(analyserNode.frequencyBinCount)
    analyserNode.spectrum = spectrum
    return { analyser, analyserNode, spectrum }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    rafCallbacks = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('raises beat level on bass onsets and decays back in silence', async () => {
    const { analyser, spectrum } = await mountBeatHarness()

    runFrames(10)
    expect(analyser.beatLevel.value).toBeLessThan(0.05)

    // 底鼓 onset:30–130Hz(bin 1–6)瞬时能量
    for (let index = 1; index <= 6; index += 1) spectrum[index] = 240
    runFrames(6)
    expect(analyser.beatLevel.value).toBeGreaterThan(0.6)

    // 恢复静默后脉冲按时间常数衰减,背景回落
    spectrum.fill(0)
    runFrames(80)
    expect(analyser.beatLevel.value).toBeLessThan(0.1)
  })

  it('does not stay lit under constant loud bass without onsets', async () => {
    const { analyser, spectrum } = await mountBeatHarness()

    // 持续大声的低音能量(无 onset):自适应 floor 跟上后不应常亮
    for (let index = 1; index <= 30; index += 1) spectrum[index] = 220
    runFrames(250)

    expect(analyser.beatLevel.value).toBeLessThan(0.2)
  })

  it('locks onto a steady tempo and keeps predicting beats into a quiet gap', async () => {
    const { analyser, spectrum } = await mountBeatHarness()
    const kick = () => {
      for (let index = 1; index <= 6; index += 1) spectrum[index] = 240
    }

    // 约 120BPM:每 ~500ms 一个底鼓(帧间隔 16ms,落点有 ±12ms 抖动,贴近真实)
    // 9s 后进入静默段,验证节拍跟踪是否继续按预测触发(而非反应式停摆)
    const pulseTimes: number[] = []
    let wasLow = true
    let timeMs = 0
    for (let frame = 0; frame < 750; frame += 1) {
      if (timeMs < 9000 && timeMs % 500 < 16) kick()
      else spectrum.fill(0)
      vi.advanceTimersByTime(16)
      timeMs += 16
      const callbacks = rafCallbacks
      rafCallbacks = []
      callbacks.forEach((callback) => callback(performance.now()))
      const level = analyser.beatLevel.value
      if (wasLow && level > 0.5) {
        pulseTimes.push(timeMs)
        wasLow = false
      }
      if (level < 0.2) wasLow = true
    }

    // 训练段(4–9s)的脉冲间隔应锁定在 500ms 附近
    const trained = pulseTimes.filter((time) => time >= 4000 && time < 9000)
    expect(trained.length).toBeGreaterThanOrEqual(8)
    const intervals = trained.slice(1).map((time, index) => time - (trained[index] ?? time))
    for (const interval of intervals) {
      expect(interval).toBeGreaterThan(400)
      expect(interval).toBeLessThan(600)
    }

    // 静默段(9–10.5s)节拍表仍应按预测节奏触发
    const predicted = pulseTimes.filter((time) => time >= 9000 && time < 10500)
    expect(predicted.length).toBeGreaterThanOrEqual(2)
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

    // 自适应归一化:稳态下既不顶满也不贴地
    for (const level of analyser.spectrumLevels.value) {
      expect(level).toBeLessThan(0.75)
      expect(level).toBeGreaterThan(0.1)
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
})
