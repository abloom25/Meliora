import { onBeforeUnmount, ref, type Ref } from 'vue'

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
    analyser: AnalyserNode
  }> = []
  let beatFrame = 0
  let energyFloor = 0.08
  let fluxFloor = 0.02
  let beatPeak = 0.35
  let spectrumPeak = 0.28
  let spectrumTick = 0
  let visibilityListenerRegistered = false

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
      sharedAudioContext = new AudioContext()
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
    const sampleGroups = [
      [4, 17, 58],
      [9, 34, 82],
      [3, 26, 49],
      [13, 43, 69],
    ]
    const performanceShape = [
      0.86 + Math.sin(spectrumTick * 0.13) * 0.16,
      1.08 + Math.sin(spectrumTick * 0.17 + 1.7) * 0.18,
      0.94 + Math.sin(spectrumTick * 0.11 + 3.1) * 0.17,
      1.02 + Math.sin(spectrumTick * 0.19 + 4.4) * 0.2,
    ]
    const contrastShape = [0.92, 1.08, 0.84, 1.16]
    const nextSpectrum = spectrumLevels.value.map((previous, band) => {
      const samples = sampleGroups[band] ?? sampleGroups[0]
      const weightedEnergy = samples.reduce((total, rawIndex, sampleIndex) => {
        const index = Math.min(data.length - 1, rawIndex)
        const value = data[index] ?? 0
        return total + value * value * (1 - sampleIndex * 0.08)
      }, 0)
      const normalized = Math.sqrt(weightedEnergy / samples.length) / 255
      spectrumPeak = Math.max(normalized, spectrumPeak * 0.992)
      const relative = normalized / Math.max(0.18, spectrumPeak)
      const contrasted = Math.pow(relative, 1.55) * (contrastShape[band] ?? 1)
      const lively = contrasted * (performanceShape[band] ?? 1)
      const pulseLift = beatLevel.value * (band % 2 === 0 ? 0.08 : 0.18)
      const target = Math.max(0.09, Math.min(0.88, lively * 0.66 + normalized * 0.14 + pulseLift))
      return previous + (target - previous) * (target > previous ? 0.44 : 0.24)
    })
    spectrumLevels.value = nextSpectrum
    // 将当前帧数据保存为"上一帧"供下一帧频谱通量计算使用
    for (let index = 0; index < data.length; index += 1) {
      previousFrequencyData[index] = (data[index] ?? 0) / 255
    }
    beatFrame = window.requestAnimationFrame(updateBeatLevel)
  }

  async function startBeatAnalysis() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (!visibilityListenerRegistered) {
      document.addEventListener('visibilitychange', handleVisibilityChange)
      visibilityListenerRegistered = true
    }
    try {
      if (!audioContext) {
        audioContext = getAudioContext()
        analyser = audioContext.createAnalyser()
        analyser.fftSize = 256
        analyser.smoothingTimeConstant = 0.5
        players.forEach((audio) => {
          let source = mediaSourceMap.get(audio)
          try {
            if (!source) {
              source = audioContext!.createMediaElementSource(audio)
              mediaSourceMap.set(audio, source)
            }
            source.connect(analyser!)
            connectedSources.push({ source, analyser: analyser! })
          } catch (error) {
            console.warn('[useAudioPlayer] createMediaElementSource failed', error)
          }
        })
        analyser.connect(audioContext.destination)
        frequencyData = new Uint8Array(analyser.frequencyBinCount)
        previousFrequencyData = new Float32Array(analyser.frequencyBinCount)
      }
      if (audioContext.state === 'suspended') await audioContext.resume()
      if (!beatFrame) beatFrame = window.requestAnimationFrame(updateBeatLevel)
    } catch {
      stopBeatAnalysis()
    }
  }

  onBeforeUnmount(() => {
    stopBeatAnalysis()
    for (const { source, analyser: targetAnalyser } of connectedSources) {
      try {
        source.disconnect(targetAnalyser)
      } catch {
        // The source may already have been disconnected by browser cleanup.
      }
    }
    connectedSources.length = 0
    try {
      analyser?.disconnect()
    } catch {
      // Ignore disconnect errors during teardown.
    }
    analyser = null
    audioContext = null
  })

  return { beatLevel, spectrumLevels, startBeatAnalysis, stopBeatAnalysis }
}
