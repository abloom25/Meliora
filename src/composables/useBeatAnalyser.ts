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

// 帧率无关的一阶指数平滑:给定时间常数 tau(秒),返回本帧应向目标逼近的比例。
// 高刷新率屏幕上固定每帧系数会让动画整体加速,所有包络/自适应统计统一走这里
function smoothingAlpha(dtSeconds: number, tauSeconds: number) {
  return 1 - Math.exp(-dtSeconds / tauSeconds)
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
   * 可选：返回队列小频谱 meter 节点。每帧直接写入 `--spectrum-level-N`,
   * 避免频谱柱经 Vue 响应式驱动整个播放队列 60fps 重渲染。
   */
  getSpectrumTargets?: () => readonly (HTMLElement | null | undefined)[]
  /**
   * 可选：当 EQ filter chain 首次创建完毕时回调，把 BiquadFilterNode 数组
   * 交给 useEqualizer 绑定，由其负责按 settings 更新各频段增益。
   */
  onEqFiltersReady?: (filters: BiquadFilterNode[]) => void
  /**
   * 可选：当某 audio 元素因跨域污染(tainted)导致无法通过 Web Audio API 读取数据时回调。
   * 触发途径有两种：createMediaElementSource 抛 SecurityError(少数浏览器)，
   * 或播放推进期间 analyser 输出持续全零(多数浏览器对跨源媒体不抛错而是输出静音)。
   * 调用方应重建该 audio 为无 crossOrigin 元素，并降级节拍分析。
   */
  onTainted?: (audio: HTMLAudioElement) => void
}

export function useBeatAnalyser(options: BeatAnalyserOptions) {
  const { players, getActiveAudio, isPlaying, getBeatTargets, getSpectrumTargets } = options
  const beatLevel = ref(0)
  const spectrumLevels = ref([0.1, 0.1, 0.1, 0.1, 0.1])
  // 记录最近一次写到 DOM 的字符串值，避免重复写入触发样式风暴。
  // 去抖缓存同时绑定主目标元素:目标重挂载(抽屉开合/虚拟列表滚动)后
  // 即使值未变化也必须重写一轮,否则新元素一直没有内联变量
  let lastBeatLevelCssValue = ''
  let lastBeatTarget: HTMLElement | null = null
  let lastSpectrumCssValues: string[] = []
  let lastSpectrumTarget: HTMLElement | null = null

  function writeBeatLevelToTargets(value: number) {
    if (!getBeatTargets) return
    const targets = getBeatTargets()
    const primary = targets.find((el) => el && el.isConnected) ?? null
    if (!primary) {
      lastBeatLevelCssValue = ''
      lastBeatTarget = null
      return
    }
    const next = value.toFixed(3)
    if (primary === lastBeatTarget && next === lastBeatLevelCssValue) return
    lastBeatLevelCssValue = next
    lastBeatTarget = primary
    for (const el of targets) {
      // isConnected 守卫：组件卸载或 v-if 隐藏时跳过，避免脏写已脱离 DOM 的节点。
      if (el && el.isConnected) el.style.setProperty('--beat-level', next)
    }
  }

  function writeSpectrumToTargets(levels: readonly number[]) {
    if (!getSpectrumTargets) return
    const targets = getSpectrumTargets()
    const primary = targets.find((el) => el && el.isConnected) ?? null
    if (!primary) {
      lastSpectrumCssValues = []
      lastSpectrumTarget = null
      return
    }
    const nextValues = levels.map(
      (level) => `${(Math.max(0.08, Math.min(1, level)) * 100).toFixed(1)}%`,
    )
    if (
      primary === lastSpectrumTarget &&
      nextValues.every((value, index) => value === lastSpectrumCssValues[index])
    ) {
      return
    }
    lastSpectrumCssValues = nextValues
    lastSpectrumTarget = primary
    for (const el of targets) {
      if (!el || !el.isConnected) continue
      nextValues.forEach((value, index) => {
        el.style.setProperty(`--spectrum-level-${index}`, value)
      })
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
  // 每个频谱段的慢速基线(自适应归一化用,0 表示未初始化)
  const bandBaselines = [0, 0, 0, 0, 0]
  // 每段上一帧电平:帧间突变(鼓点/拨弦/咬字)瞬态直通,不等待基线拉开差距
  const prevBandDbs = [0, 0, 0, 0, 0]
  // ---- 节拍检测状态(SuperFlux ODF + ACF 节拍跟踪)----
  // ODF 以固定 10ms 槽采样,与显示帧率解耦;6s 环形历史供速度/相位估计
  const ODF_SLOT_MS = 10
  const ODF_HISTORY = 600
  const odfHistory = new Float32Array(ODF_HISTORY)
  let odfOriginMs = 0
  let odfSlotCount = 0
  let currentSlotStartMs = 0
  let currentSlotFlux = 0
  let odfPeak = 0.1
  let lastOnsetSlot = -1000
  let lastOnsetMs = 0
  // 首次 onset 检出前不做置信度衰减:lastOnsetMs 初始为 0 时
  // "2s 无 onset" 恒真,会把前奏噪声估出的垃圾 tempo 衰减掉(语义混淆)
  let hasOnset = false
  // pauseBeatAnalysis 会把上一帧频谱清零,恢复后首帧对零向量求差分会产生
  // 全频谱伪 flux;该标志让恢复首帧跳过 ODF 采样(只更新上一帧基线)
  let skipNextOdfSample = false
  // 节拍跟踪:ACF 估计周期(40–222 BPM),梳齿对齐相位,预测式调度节拍脉冲
  let tempoPeriodSlots = 0
  let tempoConfidence = 0
  let nextBeatAt = 0
  let lastTempoEstimateMs = 0
  // 节拍脉冲包络:触发时抬升并按时间常数衰减,背景呈现呼吸而非闪烁
  let beatImpulse = 0
  let lastFrameAt = 0
  let visibilityListenerRegistered = false
  let isUnmounted = false
  // CORS 污染检测状态:跨源媒体经 createMediaElementSource 通常不抛 SecurityError,
  // 而是让 analyser 持续输出全零(静音)。这里累计"播放推进中但输出全零"的时长,
  // 超过宽限即判定该源被污染并回调 onTainted 降级重建。
  let taintedSilenceMs = 0
  let lastBeatFrameAt = 0
  let lastObservedCurrentTime = 0

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
    previousFrequencyData = null
  }

  function resetBeatTracking() {
    odfHistory.fill(0)
    bandBaselines.fill(0)
    prevBandDbs.fill(0)
    odfSlotCount = 0
    currentSlotStartMs = 0
    currentSlotFlux = 0
    odfPeak = 0.1
    lastOnsetSlot = -1000
    lastOnsetMs = 0
    hasOnset = false
    tempoPeriodSlots = 0
    tempoConfidence = 0
    nextBeatAt = 0
    lastTempoEstimateMs = 0
    beatImpulse = 0
  }

  function stopBeatAnalysis() {
    window.cancelAnimationFrame(beatFrame)
    beatFrame = 0
    beatLevel.value = 0
    resetBeatTracking()
    lastFrameAt = 0
    writeBeatLevelToTargets(0)
    if (previousFrequencyData) previousFrequencyData.fill(0)
    spectrumLevels.value = spectrumLevels.value.map(() => 0.08)
    writeSpectrumToTargets(spectrumLevels.value)
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
    skipNextOdfSample = true
    // 重置污染检测计时,避免恢复后首帧把整段后台时长一次性累加
    taintedSilenceMs = 0
    lastBeatFrameAt = 0
    spectrumLevels.value = spectrumLevels.value.map((level) => Math.max(0.08, level * 0.82))
    writeSpectrumToTargets(spectrumLevels.value)
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

  // 频段 dB 均值:byte 频谱本身是 dB 映射(默认 -100…-30dB 压到 0…255),
  // 均值落在压缩域,适合与自适应基线做相对比较
  function bandAverage(data: Uint8Array<ArrayBuffer>, from: number, to: number) {
    const start = Math.max(1, Math.min(data.length - 1, from))
    const end = Math.max(start + 1, Math.min(data.length, to))
    let sum = 0
    for (let index = start; index < end; index += 1) sum += data[index] ?? 0
    return sum / 255 / Math.max(1, end - start)
  }

  // SuperFlux(Böck & Widmer, ISMIR 2013):对数域频谱(byte 数据本身是 dB 映射,
  // 近似对数压缩)与其最大值滤波后的上一帧求正向差分总和。最大值滤波把上一帧
  // 频谱在频率方向"拓宽"±3 bin,抑制颤音/滑音造成的伪 onset
  function superFluxODF(data: Uint8Array<ArrayBuffer>, toBin: number) {
    if (!previousFrequencyData) return 0
    const prevLength = previousFrequencyData.length
    const end = Math.max(5, Math.min(data.length - 4, toBin))
    let flux = 0
    for (let index = 1; index < end; index += 1) {
      const current = (data[index] ?? 0) / 255
      let widened = 0
      for (let k = index - 3; k <= index + 3; k += 1) {
        const value = previousFrequencyData[clamp(k, 0, prevLength - 1)] ?? 0
        if (value > widened) widened = value
      }
      const rise = current - widened
      if (rise > 0) flux += rise
    }
    return flux
  }

  const TAINTED_SILENCE_GRACE_MS = 3000

  function histAt(absSlot: number) {
    if (absSlot < 0 || absSlot >= odfSlotCount) return 0
    return odfHistory[absSlot % ODF_HISTORY] ?? 0
  }

  function slotTime(slot: number) {
    return odfOriginMs + slot * ODF_SLOT_MS
  }

  // 把帧内 ODF 采样归并进固定 10ms 槽;槽满即入历史并评估上一槽是否 onset。
  // 帧率波动只影响每帧写入次数,不影响 ODF 的时间基准
  function pushOdfSample(now: number, flux: number) {
    if (currentSlotStartMs === 0) {
      currentSlotStartMs = now
      odfOriginMs = now
    }
    if (now - currentSlotStartMs > ODF_HISTORY * ODF_SLOT_MS) {
      // 长时间暂停/后台挂起:历史整体作废,从当前时刻重建
      resetBeatTracking()
      currentSlotStartMs = now
      odfOriginMs = now
    }
    currentSlotFlux = Math.max(currentSlotFlux, flux)
    while (now - currentSlotStartMs >= ODF_SLOT_MS) {
      odfHistory[odfSlotCount % ODF_HISTORY] = currentSlotFlux
      odfSlotCount += 1
      currentSlotFlux = 0
      currentSlotStartMs += ODF_SLOT_MS
      evaluateOnsetSlot(odfSlotCount - 2)
    }
  }

  // Böck peak-picking:局部极大 + 移动均值自适应阈值 + 120ms 不应期
  function evaluateOnsetSlot(slot: number) {
    if (slot < 2) return
    const prev = histAt(slot - 1)
    const cur = histAt(slot)
    const next = histAt(slot + 1)
    if (!(cur > prev && cur >= next)) return
    let sum = 0
    let count = 0
    for (let i = Math.max(0, slot - 100); i < slot; i += 1) {
      sum += histAt(i)
      count += 1
    }
    const mean = count > 0 ? sum / count : 0
    if (cur < mean * 1.5 + 0.02) return
    if (slot - lastOnsetSlot < 12) return
    lastOnsetSlot = slot
    lastOnsetMs = slotTime(slot)
    hasOnset = true
    odfPeak = Math.max(cur, odfPeak * 0.995, 0.05)
    handleOnset(lastOnsetMs, clamp(cur / odfPeak, 0, 1))
  }

  function handleOnset(onsetMs: number, strength: number) {
    const periodMs = tempoPeriodSlots * ODF_SLOT_MS
    if (tempoConfidence >= 0.3 && periodMs > 0 && nextBeatAt > 0) {
      // onset 只用于相位校正:与最近的预测节拍比对,渐进对齐(容差 ±20% 周期)
      const nearest = nextBeatAt + Math.round((onsetMs - nextBeatAt) / periodMs) * periodMs
      const error = onsetMs - nearest
      if (Math.abs(error) < periodMs * 0.2) nextBeatAt += error * 0.25
      return
    }
    // 无可靠节拍估计(前奏/氛围/自由节奏):退回反应式触发,保持即时响应
    beatImpulse = Math.max(beatImpulse, 0.5 + strength * 0.5)
  }

  // Davies/Plumbley 因果节拍跟踪:对 ODF 历史做自相关估计周期(40–222 BPM,
  // 高斯权重偏向 ~110BPM 抑制半速/倍速歧义),再穷举相位使梳齿与 ODF 脉冲对齐
  function estimateTempo() {
    const N = Math.min(odfSlotCount, 400)
    if (N < 250) return
    const h = new Float32Array(N)
    let power = 0
    for (let i = 0; i < N; i += 1) {
      const value = histAt(odfSlotCount - N + i)
      h[i] = value
      power += value * value
    }
    if (power < 1e-6) {
      tempoConfidence = 0
      return
    }
    let bestTau = 0
    let bestWeighted = 0
    let bestRaw = 0
    for (let tau = 27; tau <= 150; tau += 1) {
      let score = 0
      for (let n = tau; n < N; n += 1) score += (h[n] ?? 0) * (h[n - tau] ?? 0)
      const bpm = 60000 / (tau * ODF_SLOT_MS)
      const weight = Math.exp(-0.5 * ((bpm - 110) / 45) ** 2)
      const weighted = score * weight
      if (weighted > bestWeighted) {
        bestWeighted = weighted
        bestTau = tau
        bestRaw = score
      }
    }
    tempoConfidence = clamp(bestRaw / power, 0, 1)
    tempoPeriodSlots = bestTau
    let bestPhase = 0
    let bestPhaseScore = -1
    for (let phase = 0; phase < bestTau; phase += 1) {
      let score = 0
      for (let n = N - 1 - phase; n >= 0; n -= bestTau) score += h[n] ?? 0
      if (score > bestPhaseScore) {
        bestPhaseScore = score
        bestPhase = phase
      }
    }
    const periodMs = bestTau * ODF_SLOT_MS
    const candidate = slotTime(odfSlotCount - 1 - bestPhase + bestTau)
    // 与当前预测差距小则渐进调整,避免节拍位置跳变;差距大(失步/重估)才重置
    if (nextBeatAt === 0 || Math.abs(candidate - nextBeatAt) > periodMs * 0.35) {
      nextBeatAt = candidate
    } else {
      nextBeatAt += (candidate - nextBeatAt) * 0.2
    }
  }

  // 预测式节拍调度:到点即触发脉冲,而不是等 onset 出现再反应;
  // 首次 onset 后 2s 无新 onset 时置信度衰减,间奏不会机械地一直跳
  function scheduleBeats(now: number, dt: number) {
    if (hasOnset && now - lastOnsetMs > 2000) tempoConfidence *= Math.exp(-dt / 1)
    if (tempoConfidence >= 0.3 && tempoPeriodSlots > 0 && nextBeatAt > 0) {
      const periodMs = tempoPeriodSlots * ODF_SLOT_MS
      let guard = 0
      while (now >= nextBeatAt && guard < 3) {
        // 错过超过一个周期的节拍不重放
        if (now - nextBeatAt <= periodMs) beatImpulse = Math.max(beatImpulse, 0.85)
        nextBeatAt += periodMs
        guard += 1
      }
      if (now - nextBeatAt > periodMs * 2) nextBeatAt = 0
    }
  }

  function updateBeatLevel() {
    const activeAudio = getActiveAudio()
    const now = performance.now()
    const dt = lastFrameAt ? clamp((now - lastFrameAt) / 1000, 0.001, 0.1) : 1 / 60
    lastFrameAt = now
    if (!analyser || !frequencyData || activeAudio.paused) {
      // 暂停/无 analyser 时重置污染检测进度,恢复播放后重新累计
      taintedSilenceMs = 0
      lastBeatFrameAt = 0
      lastObservedCurrentTime = activeAudio.currentTime
      beatImpulse = 0
      beatLevel.value *= Math.exp(-dt / 0.13)
      writeBeatLevelToTargets(beatLevel.value)
      spectrumLevels.value = spectrumLevels.value.map((level) =>
        Math.max(0.08, level * Math.exp(-dt / 0.084)),
      )
      writeSpectrumToTargets(spectrumLevels.value)
      if (beatLevel.value > 0.005) beatFrame = window.requestAnimationFrame(updateBeatLevel)
      else stopBeatAnalysis()
      return
    }
    analyser.getByteFrequencyData(frequencyData)
    const data = frequencyData
    // CORS 污染检测:跨源媒体不抛错而是让 analyser 持续输出全零。
    // 仅累计"currentTime 在前进(确实在出声)但频谱全零"的时长,
    // 暂停与缓冲 stall(currentTime 不前进)不计入,避免误伤正常弱音/卡顿。
    let allZero = true
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== 0) {
        allZero = false
        break
      }
    }
    const progressed = activeAudio.currentTime > lastObservedCurrentTime + 0.001
    lastObservedCurrentTime = activeAudio.currentTime
    if (!allZero) {
      taintedSilenceMs = 0
    } else if (progressed) {
      // 单帧 delta 钳制:页面 hidden 期间 rAF 停转,恢复后首帧的
      // now - lastBeatFrameAt 会包含整个后台时长,不得一次性累加
      taintedSilenceMs += lastBeatFrameAt ? Math.min(now - lastBeatFrameAt, 100) : 0
      if (taintedSilenceMs >= TAINTED_SILENCE_GRACE_MS) {
        // 判定该源被 CORS 污染:通知调用方重建 audio(去 crossOrigin)并降级节拍分析
        taintedSilenceMs = 0
        lastBeatFrameAt = 0
        stopBeatAnalysis()
        options.onTainted?.(activeAudio)
        return
      }
    }
    lastBeatFrameAt = now
    // 确保 previousFrequencyData 长度与 data 一致（在任何读操作之前执行，防止旧数据残留导致频谱计算异常）
    if (!previousFrequencyData || previousFrequencyData.length !== data.length) {
      previousFrequencyData = new Float32Array(data.length)
    }
    // 频段按 Hz 划分再换算 bin:fftSize 或采样率变化时语义不变。
    // 底鼓基频集中在 30–130Hz,旧实现(fftSize 256)一个 bin 就 ~187Hz,
    // "低频段"实际混入 2kHz 以下全部低中频,军鼓/人声都会误触发节拍
    const binHz = audioContext ? audioContext.sampleRate / analyser.fftSize : 187.5
    const binOf = (hz: number) => clamp(Math.round(hz / binHz), 1, data.length - 1)

    const kickEnergy = bandEnergy(data, binOf(30), binOf(130))
    const bassEnergy = bandEnergy(data, binOf(130), binOf(260))
    const lowMidEnergy = bandEnergy(data, binOf(260), binOf(2000))
    const beatEnergy = kickEnergy * 0.62 + bassEnergy * 0.26 + lowMidEnergy * 0.12

    // 自适应能量底:EMA 跟踪近期平均能量,持续低音提供少量环境亮度,
    // 避免纯节拍驱动在持续 bassline 下完全熄灭
    energyFloor += (beatEnergy - energyFloor) * smoothingAlpha(dt, 1.1)

    // SuperFlux ODF 并入 10ms 槽(onset 评估在槽 finalize 时进行),
    // 然后做预测式节拍调度与周期/相位重估;恢复首帧跳过采样避免伪 flux
    const odfSample = skipNextOdfSample ? 0 : superFluxODF(data, binOf(8000))
    skipNextOdfSample = false
    pushOdfSample(now, odfSample)
    scheduleBeats(now, dt)
    if (now - lastTempoEstimateMs >= 500) {
      lastTempoEstimateMs = now
      estimateTempo()
    }
    beatImpulse *= Math.exp(-dt / 0.23)

    const sustain = clamp((beatEnergy - energyFloor * 1.05) * 0.9, 0, 0.16)
    const target = clamp(beatImpulse + sustain, 0, 1)
    beatLevel.value +=
      (target - beatLevel.value) * smoothingAlpha(dt, target > beatLevel.value ? 0.028 : 0.11)
    // 高频写入：直接 setProperty 到目标节点，跳过 Vue reactivity 与根 :style 路径
    writeBeatLevelToTargets(beatLevel.value)

    // 频谱柱五段 Hz 划分(sub/low/mid/high/air)
    const spectrumBands: Array<{ from: number; to: number }> = [
      { from: 30, to: 120 },
      { from: 120, to: 400 },
      { from: 400, to: 1500 },
      { from: 1500, to: 5000 },
      { from: 5000, to: 12000 },
    ]
    // 快起慢落,逐段略有差异,柱子才有"活"的感觉而不是整齐划一
    const riseTaus = [0.05, 0.045, 0.06, 0.04, 0.035]
    const fallTaus = [0.3, 0.26, 0.24, 0.2, 0.16]
    const bandIdleAmp = [0.16, 0.2, 0.22, 0.15, 0.12]
    const bandIdleBase = [0.18, 0.24, 0.26, 0.2, 0.15]
    const idlePhase = now / 1000
    const idleWave = [
      Math.sin(idlePhase * 4.26) * 0.55 + Math.sin(idlePhase * 1.74 + 1.3) * 0.45,
      Math.sin(idlePhase * 5.53 + 2.6) * 0.5 + Math.sin(idlePhase * 2.11 + 0.8) * 0.5,
      Math.sin(idlePhase * 6.78 + 1.7) * 0.5 + Math.sin(idlePhase * 2.46 + 3.2) * 0.5,
      Math.sin(idlePhase * 9.42 + 0.5) * 0.6 + Math.sin(idlePhase * 1.38 + 5.1) * 0.4,
      Math.sin(idlePhase * 11.82 + 4.4) * 0.45 + Math.sin(idlePhase * 3.18 + 2.7) * 0.55,
    ]
    const pulseWeights = [0.28, 0.2, 0.12, 0.06, 0.03]
    // 整体电平门:接近静默时淡出到 idle 波浪,有内容时交给自适应动态
    const overallLevel = bandAverage(data, binOf(30), binOf(12000))
    const audioGate = clamp((overallLevel - 0.06) * 8, 0, 1)
    const nextSpectrum = spectrumLevels.value.map((previous, band) => {
      const def = spectrumBands[band] ?? spectrumBands[0]!
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
        (bandIdleBase[band] ?? 0.2) + (bandIdleAmp[band] ?? 0.18) * (idleWave[band] ?? 0)
      const pulseLift = beatLevel.value * (pulseWeights[band] ?? 0.1)
      const target = clamp(
        idleHeight * (1 - audioGate) + (0.08 + stretched * 0.9) * audioGate + pulseLift,
        0.08,
        0.98,
      )
      const tau = target > previous ? (riseTaus[band] ?? 0.05) : (fallTaus[band] ?? 0.24)
      return previous + (target - previous) * smoothingAlpha(dt, tau)
    })
    spectrumLevels.value = nextSpectrum
    writeSpectrumToTargets(nextSpectrum)
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
            const isTainted =
              error instanceof DOMException &&
              (error.name === 'SecurityError' || error.name === 'InvalidStateError')
            if (isTainted) {
              // 少数浏览器对跨源媒体抛 SecurityError(多数不抛错而是输出静音,
              // 由 updateBeatLevel 的全零检测兜底),无法通过 Web Audio API 读取数据。
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
    disconnectAnalysisGraph()
    // 挂起共享 AudioContext 释放音频硬件资源；SPA 生命周期内不 close，
    // 后续 startBeatAnalysis 可通过 resume() 恢复。
    if (sharedAudioContext?.state === 'running') {
      void sharedAudioContext.suspend()
    }
    audioContext = null
  })

  return { beatLevel, spectrumLevels, startBeatAnalysis, stopBeatAnalysis }
}
