import { afterEach, describe, expect, it, vi } from 'vitest'
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
  frequencyBinCount = 128

  getByteFrequencyData(data: Uint8Array) {
    data.fill(0)
  }
}

class BiquadFilterNodeMock extends AudioNodeMock {
  type: BiquadFilterType = 'peaking'
  frequency = { value: 0 }
  Q = { value: 0 }
  gain = { value: 0 }
}

class AudioContextMock {
  state: AudioContextState = 'running'
  destination = new AudioNodeMock() as unknown as AudioDestinationNode
  sources: unknown[] = []

  createAnalyser() {
    return new AnalyserNodeMock() as unknown as AnalyserNode
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
