import { onBeforeUnmount, ref, type Ref } from 'vue'
import { EQ_BAND_FREQUENCIES, bandFilterType } from '../utils/equalizer'
import { createAudioContextCompatible } from '../utils/browser'

// 模块级音频上下文与 source 缓存：
// 浏览器对同一个 audio 节点只允许 createMediaElementSource 一次。
// 因此保持一个共享 AudioContext，避免组件重建后把旧 source 连接到新/已关闭 context。
let sharedAudioContext: AudioContext | null = null
const mediaSourceMap = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>()

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export interface BeatAnalyserOptions {
  players: readonly HTMLAudioElement[]
  getActiveAudio: () => HTMLAudioElement
  isPlaying: Ref<boolean>
  /**
   * 可选：返回需要每帧同步 `--beat-level` CSS 变量的 DOM 节点列表。
   * 直接 setProperty 到这些节点可以避免根元素 :style 触发整棵子树样式重算，
   * 大幅降低 UpdateLayoutTree 频次。
   */
  getBeatTargets?: () => readonly (HTMLElement | null | undefined)[]
  /**
   * 可选：当 EQ filter chain 首次创建完毕时回调，把 BiquadFilterNode 数组
   * 交给 useEqualizer 绑定，由其负责按 settings 更新各频段增益。
   */
  onEqFiltersReady?: (filters: BiquadFilterNode[]) => void
  /**
   * 可选：当某 audio 元素因跨域污染(tainted)导致 createMediaElementSource 抛 SecurityError 时回调。
   * 调用方应重建该 audio 为无 crossOrigin 元素，并降级节拍分析。
   */
  onTainted?: (audio: HTMLAudioElement) => void
}

export function useBeatAnalyser(options: BeatAnalyserOptions) {
  const { players, getActiveAudio, isPlaying, getBeatTargets } = options
  const beatLevel = ref(0)
  const spectrumLevels = ref([0.1, 0.1, 0.1, 0.1])
  // 记录最近一次写到 DOM 的字符串值，避免重复写入触发样式风暴。
  let lastBeatLevelCssValue = ''

  function writeBeatLevelToTargets(value: number) {
    if (!getBeatTargets) return
    const next = value.toFixed(3)
    if (next === lastBeatLevelCssValue) return
    lastBeatLevelCssValue = next
    const targets = getBeatTargets()
    for (const el of targets) {
      // isConnected 守卫：组件卸载或 v-if 隐藏时跳过，避免脏写已脱离 DOM 的节点。
      if (el && el.isConnected) el.style.setProperty('--beat-level', next)
    }
  }

  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let frequencyData: Uint8Array<ArrayBuffer> | null = null
  let previousFrequencyData: Float32Array | null = null
  const connectedSources: Array<{
    source: MediaElementAudioSourceNode
    target: AudioNode
  }> = []
  let eqFilters: BiquadFilterNode[] = []
  let beatFrame = 0
  let energyFloor = 0.08
  let fluxFloor = 0.02
  let beatPeak = 0.35
  let spectrumTick = 0
  let visibilityListenerRegistered = false
  let isUnmounted = false

  function stopBeatAnalysis() {
    window.cancelAnimationFrame(beatFrame)
    beatFrame = 0
    beatLevel.value = 0
    writeBeatLevelToTargets(0)
    if (previousFrequencyData) previousFrequencyData.fill(0)
    spectrumLevels.value = spectrumLevels.value.map(() => 0.08)
    if (visibilityListenerRegistered) {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      visibilityListenerRegistered = false
    }
  }

  function pauseBeatAnalysis() {
    if (!beatFrame) return
    window.cancelAnimationFrame(beatFrame)
    beatFrame = 0
    if (previousFrequencyData) previousFrequencyData.fill(0)
    spectrumLevels.value = spectrumLevels.value.map((level) => Math.max(0.08, level * 0.82))
    writeBeatLevelToTargets(0)
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      pauseBeatAnalysis()
    } else {
      if (audioContext?.state === 'suspended') {
        void audioContext.resume()
      }
      if (!beatFrame && isPlaying.value) beatFrame = window.requestAnimationFrame(updateBeatLevel)
    }
  }

  function getAudioContext(): AudioContext {
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
      // Safari 14.1 之前需要 webkitAudioContext,由工具统一兼容
      const ctx = createAudioContextCompatible()
      if (!ctx) throw new Error('AudioContext unavailable')
      sharedAudioContext = ctx
    }
    return sharedAudioContext
  }

  function bandEnergy(data: Uint8Array<ArrayBuffer>, from: number, to: number) {
    const start = Math.max(1, Math.min(data.length - 1, from))
    const end = Math.max(start + 1, Math.min(data.length, to))
    let energy = 0
    for (let index = start; index < end; index += 1) {
      const value = data[index] ?? 0
      energy += value * value
    }
    return Math.sqrt(energy / Math.max(1, end - start)) / 255
  }

  function spectralFlux(data: Uint8Array<ArrayBuffer>, from: number, to: number) {
    if (!previousFrequencyData) return 0
    const start = Math.max(1, Math.min(data.length - 1, from))
    const end = Math.max(start + 1, Math.min(data.length, to))
    let flux = 0
    for (let index = start; index < end; index += 1) {
      const current = (data[index] ?? 0) / 255
      const previous = previousFrequencyData[index] ?? 0
      const rise = current - previous
      if (rise > 0) flux += rise * rise
    }
    return Math.sqrt(flux / Math.max(1, end - start))
  }

  function updateBeatLevel() {
    const activeAudio = getActiveAudio()
    if (!analyser || !frequencyData || activeAudio.paused) {
      beatLevel.value *= 0.88
      writeBeatLevelToTargets(beatLevel.value)
      spectrumLevels.value = spectrumLevels.value.map((level) => Math.max(0.08, level * 0.82))
      if (beatLevel.value > 0.005) beatFrame = window.requestAnimationFrame(updateBeatLevel)
      else stopBeatAnalysis()
      return
    }
    analyser.getByteFrequencyData(frequencyData)
    const data = frequencyData
    // 确保 previousFrequencyData 长度与 data 一致（在任何读操作之前执行，防止旧数据残留导致频谱计算异常）
    if (!previousFrequencyData || previousFrequencyData.length !== data.length) {
      previousFrequencyData = new Float32Array(data.length)
    }
    const bassEnd = Math.max(7, Math.floor(data.length * 0.1))
    const lowMidEnd = Math.max(bassEnd + 5, Math.floor(data.length * 0.24))
    const bassEnergy = bandEnergy(data, 1, bassEnd)
    const lowMidEnergy = bandEnergy(data, bassEnd, lowMidEnd)
    const totalEnergy = bassEnergy * 0.72 + lowMidEnergy * 0.28
    const flux = spectralFlux(data, 1, lowMidEnd)
    energyFloor = energyFloor * 0.988 + totalEnergy * 0.012
    fluxFloor = fluxFloor * 0.982 + flux * 0.018
    const energyOnset = Math.max(0, totalEnergy - energyFloor * 1.08)
    const fluxOnset = Math.max(0, flux - fluxFloor * 1.2)
    beatPeak = Math.max(energyOnset * 2.9 + fluxOnset * 4.2, beatPeak * 0.965, 0.18)
    const pulse = clamp((energyOnset * 2.9 + fluxOnset * 4.2) / beatPeak, 0, 1)
    const shapedPulse = pulse < 0.08 ? 0 : Math.pow(pulse, 1.28)
    beatLevel.value +=
      (shapedPulse - beatLevel.value) * (shapedPulse > beatLevel.value ? 0.52 : 0.12)
    // 高频写入：直接 setProperty 到目标节点，跳过 Vue reactivity 与根 :style 路径
    writeBeatLevelToTargets(beatLevel.value)

    spectrumTick += 1
    const bandSamplers = [
      { start: 2, step: 7, count: 16, weightDecay: 0.92 },
      { start: 5, step: 11, count: 12, weightDecay: 0.96 },
      { start: 3, step: 13, count: 10, weightDecay: 1.02 },
      { start: 8, step: 17, count: 8, weightDecay: 1.06 },
    ]
    const bandBoost = [1.6, 1.4, 1.8, 2.6]
    const riseSpeeds = [0.42, 0.6, 0.32, 0.78]
    const fallSpeeds = [0.08, 0.22, 0.14, 0.34]
    const bandIdleAmp = [0.16, 0.22, 0.14, 0.2]
    const bandIdleBase = [0.18, 0.28, 0.22, 0.16]
    const idleWave = [
      Math.sin(spectrumTick * 0.071) * 0.55 + Math.sin(spectrumTick * 0.029 + 1.3) * 0.45,
      Math.sin(spectrumTick * 0.113 + 1.7) * 0.5 + Math.sin(spectrumTick * 0.041 + 3.2) * 0.5,
      Math.sin(spectrumTick * 0.157 + 0.5) * 0.6 + Math.sin(spectrumTick * 0.023 + 5.1) * 0.4,
      Math.sin(spectrumTick * 0.197 + 4.4) * 0.45 + Math.sin(spectrumTick * 0.053 + 2.7) * 0.55,
    ]
    const pulseWeights = [0.28, 0.12, 0.04, 0.18]
    const nextSpectrum = spectrumLevels.value.map((previous, band) => {
      const sampler = bandSamplers[band] ?? bandSamplers[0]
      let energy = 0
      let weightSum = 0
      let weight = 1
      for (let i = 0; i < sampler.count; i += 1) {
        const index = sampler.start + i * sampler.step
        if (index >= data.length) break
        const value = (data[index] ?? 0) / 255
        energy += value * value * weight
        weightSum += weight
        weight *= sampler.weightDecay
      }
      const rms = Math.sqrt(energy / Math.max(0.0001, weightSum))
      const audioActive = Math.min(1, rms * (bandBoost[band] ?? 1))
      const idleHeight = (bandIdleBase[band] ?? 0.2) + (bandIdleAmp[band] ?? 0.18) * idleWave[band]
      const pulseLift = beatLevel.value * (pulseWeights[band] ?? 0.1)
      const target = Math.max(0.08, Math.min(0.92, Math.max(idleHeight, audioActive) + pulseLift))
      const rising = target > previous
      const speed = rising ? (riseSpeeds[band] ?? 0.5) : (fallSpeeds[band] ?? 0.2)
      return previous + (target - previous) * speed
    })
    spectrumLevels.value = nextSpectrum
    // 将当前帧数据保存为"上一帧"供下一帧频谱通量计算使用
    for (let index = 0; index < data.length; index += 1) {
      previousFrequencyData[index] = (data[index] ?? 0) / 255
    }
    beatFrame = window.requestAnimationFrame(updateBeatLevel)
  }

  async function startBeatAnalysis() {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    try {
      if (!audioContext) {
        audioContext = getAudioContext()
        analyser = audioContext.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.5
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
            const isTainted =
              error instanceof DOMException &&
              (error.name === 'SecurityError' || error.name === 'InvalidStateError')
            if (isTainted) {
              // 音频源被 CORS 污染，无法通过 Web Audio API 读取数据
              // 通知调用方降级重建 audio(去掉 crossOrigin)，牺牲节拍分析保播放
              options.onTainted?.(audio)
            } else {
              console.warn('[useAudioPlayer] createMediaElementSource failed', error)
            }
          }
        })
        eqOutput.connect(analyser)
        analyser.connect(audioContext.destination)
        frequencyData = new Uint8Array(analyser.frequencyBinCount)
        previousFrequencyData = new Float32Array(analyser.frequencyBinCount)
        options.onEqFiltersReady?.(eqFilters)
      }
      if (audioContext.state === 'suspended') await audioContext.resume()
      if (isUnmounted) return
      if (prefersReducedMotion) {
        pauseBeatAnalysis()
        return
      }
      if (!visibilityListenerRegistered) {
        document.addEventListener('visibilitychange', handleVisibilityChange)
        visibilityListenerRegistered = true
      }
      if (!beatFrame) beatFrame = window.requestAnimationFrame(updateBeatLevel)
    } catch {
      stopBeatAnalysis()
    }
  }

  onBeforeUnmount(() => {
    isUnmounted = true
    stopBeatAnalysis()
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
    // 挂起共享 AudioContext 释放音频硬件资源；SPA 生命周期内不 close，
    // 后续 startBeatAnalysis 可通过 resume() 恢复。
    if (sharedAudioContext?.state === 'running') {
      void sharedAudioContext.suspend()
    }
    audioContext = null
  })

  return { beatLevel, spectrumLevels, startBeatAnalysis, stopBeatAnalysis }
}
