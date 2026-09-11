import { onBeforeUnmount, ref, type Ref } from 'vue'
import { EQ_BAND_FREQUENCIES, bandFilterType } from '../../core/audio/equalizer'
import { createAudioContextCompatible } from './browser'
import { createBeatEnvelope, sanitizeBeatFlashRate } from '../../core/analysis/beat-envelope'
import { createRealtimeHpss, type RealtimeHpss } from '../../core/analysis/hpss'
import { createTempoRuler } from '../../core/analysis/tempo-ruler'

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

// byte 频谱(analyser 默认 -100…-30dB 映射到 0…255)到线性幅度的查表,供 HPSS 掩膜使用
const LINEAR_MAGNITUDE_LUT = new Float32Array(256)
for (let index = 0; index < 256; index += 1) {
  LINEAR_MAGNITUDE_LUT[index] = Math.pow(10, (-100 + (index / 255) * 70) / 20)
}

export interface BeatAnalyserOptions {
  players: readonly HTMLAudioElement[]
  getActiveAudio: () => HTMLAudioElement
  isPlaying: Ref<boolean>
  /** 可选:闪烁密度设置(每拍最多闪几次),非法值按 1 处理 */
  beatFlashRate?: Ref<number>
  /** 可选:闪光延迟微调(ms),叠加在自动输出延迟补偿之上,可为负 */
  beatVisualDelay?: Ref<number>
  /**
   * 可选：返回需要每帧同步 `--beat-level` / `--beat-sustain` CSS 变量的 DOM 节点列表。
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

  function writeBeatLevelToTargets(level: number, sustain = 0) {
    if (!getBeatTargets) return
    const targets = getBeatTargets()
    const primary = targets.find((el) => el && el.isConnected) ?? null
    if (!primary) {
      lastBeatLevelCssValue = ''
      lastBeatTarget = null
      return
    }
    const nextLevel = level.toFixed(3)
    const nextSustain = sustain.toFixed(3)
    const next = `${nextLevel}/${nextSustain}`
    if (primary === lastBeatTarget && next === lastBeatLevelCssValue) return
    lastBeatLevelCssValue = next
    lastBeatTarget = primary
    for (const el of targets) {
      // isConnected 守卫：组件卸载或 v-if 隐藏时跳过，避免脏写已脱离 DOM 的节点。
      if (!el || !el.isConnected) continue
      el.style.setProperty('--beat-level', nextLevel)
      el.style.setProperty('--beat-sustain', nextSustain)
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
  // 实时 HPSS 给出每 bin 的打击掩膜;背景亮度只看打击成分在 30–150Hz 的线性功率
  let hpss: RealtimeHpss | null = null
  let linearMagnitude: Float32Array | null = null
  // 速度尺子吃的是 dB 域(byte/255)打击成分低频正向通量,峰值拾取需要这个量纲
  let prevPercussiveLow: Float32Array | null = null
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
  // ---- 节奏包络(实时 HPSS → 打击成分低频功率 → core/analysis/beat-envelope)----
  // 这是表现效果的驱动源:一条连续的快起慢落包络,不做击点判定、不选乐器。
  // 真歌离线实验(9 首,EDM 到钢琴独奏)确认:有鼓的歌拍点覆盖约 90%,拍外误闪每秒 0.2 次左右
  const envelope = createBeatEnvelope()
  // 输出延迟补偿:analyser 读到的是送往声卡之前的信号,声音真正到耳朵还要再等
  // baseLatency + outputLatency(Windows 共享模式 20–50ms,蓝牙耳机常在 100ms 以上)。
  // 视觉链路自己只有约 25ms(FFT 窗中心 + 平滑 + 合成上屏),所以画面会先于声音。
  // 把包络按差值延后再写入 CSS 变量;Safari 拿不到 outputLatency,按 0 处理即不延迟
  // 用户还可以在设置里手动加减:设备报的 outputLatency 不一定准(蓝牙编解码延迟往往不在里面)
  const VISUAL_PIPELINE_MS = 25
  const MAX_VISUAL_DELAY_MS = 600
  const levelHistory: Array<{ at: number; level: number; sustain: number }> = []
  // 速度尺子只提供拍长:决定包络释放时长与「闪烁频率」档位的最小间距
  const tempoRuler = createTempoRuler()
  // pauseBeatAnalysis 会把上一帧频谱清零,恢复后首帧对零向量求差分会产生
  // 全频谱伪 flux;该标志让恢复首帧跳过 ODF 采样(只更新上一帧基线)
  let skipNextOdfSample = false
  // 慢包络:低频能量高出自适应底的部分,给背景一点随段落起伏的呼吸(CSS 侧权重很低)
  let sustainLevel = 0
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
    hpss = null
    linearMagnitude = null
    prevPercussiveLow = null
  }

  function visualDelayMs() {
    const context = audioContext as (AudioContext & { outputLatency?: number }) | null
    const deviceLatencyMs = ((context?.baseLatency ?? 0) + (context?.outputLatency ?? 0)) * 1000
    const manual = options.beatVisualDelay?.value
    const manualMs = typeof manual === 'number' && Number.isFinite(manual) ? manual : 0
    return clamp(deviceLatencyMs - VISUAL_PIPELINE_MS + manualMs, 0, MAX_VISUAL_DELAY_MS)
  }

  // 延迟线:记录每帧的包络,取"延迟量之前"那一帧写出;延迟为 0 时原样返回
  function delayedLevels(now: number, level: number, sustain: number) {
    const delay = visualDelayMs()
    if (delay <= 0) {
      levelHistory.length = 0
      return { level, sustain }
    }
    levelHistory.push({ at: now, level, sustain })
    const target = now - delay
    let picked = levelHistory[0] ?? { at: now, level, sustain }
    while (levelHistory.length > 1 && (levelHistory[1]?.at ?? Infinity) <= target) {
      levelHistory.shift()
      picked = levelHistory[0] ?? picked
    }
    // 还没积累到延迟量的时长:先保持暗,避免开播首帧提前亮
    if (picked.at > target) return { level: 0, sustain: 0 }
    return { level: picked.level, sustain: picked.sustain }
  }

  function resetBeatTracking() {
    levelHistory.length = 0
    envelope.reset()
    tempoRuler.reset()
    bandBaselines.fill(0)
    prevBandDbs.fill(0)
    hpss?.reset()
    prevPercussiveLow?.fill(0)
    sustainLevel = 0
  }

  function stopBeatAnalysis() {
    window.cancelAnimationFrame(beatFrame)
    beatFrame = 0
    beatLevel.value = 0
    resetBeatTracking()
    lastFrameAt = 0
    writeBeatLevelToTargets(0)
    prevPercussiveLow?.fill(0)
    hpss?.reset()
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
    prevPercussiveLow?.fill(0)
    hpss?.reset()
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
      ensureGestureResume()
    }
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

  // 打击成分 30–150Hz 的线性功率(每 bin 平均),包络的输入
  function percussiveLowPower(
    magnitude: Float32Array,
    mask: Float32Array,
    fromBin: number,
    toBin: number,
  ) {
    const start = Math.max(1, fromBin)
    const end = Math.max(start + 1, Math.min(magnitude.length, toBin))
    let power = 0
    for (let index = start; index < end; index += 1) {
      const value = magnitude[index] ?? 0
      power += value * value * (mask[index] ?? 0.5)
    }
    return power / (end - start)
  }

  // 打击成分低频 dB 域正向通量(每 bin 平均),速度尺子的 ODF
  function percussiveLowFlux(
    data: Uint8Array<ArrayBuffer>,
    mask: Float32Array,
    previous: Float32Array,
    fromBin: number,
    toBin: number,
  ) {
    const start = Math.max(1, fromBin)
    const end = Math.max(start + 1, Math.min(data.length, toBin))
    let flux = 0
    for (let index = start; index < end; index += 1) {
      const compressed = ((data[index] ?? 0) / 255) * (mask[index] ?? 0.5)
      const rise = compressed - (previous[index] ?? 0)
      if (rise > 0) flux += rise
      previous[index] = compressed
    }
    return flux / (end - start)
  }

  const TAINTED_SILENCE_GRACE_MS = 3000

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
      beatLevel.value *= Math.exp(-dt / 0.13)
      sustainLevel *= Math.exp(-dt / 0.3)
      writeBeatLevelToTargets(beatLevel.value, sustainLevel)
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
    // 仅累计"currentTime 在前进(确实在出声)且上下文运行中但频谱全零"的时长,
    // 暂停、缓冲 stall 与 AudioContext suspended(Safari 手势前)均不计入,避免误判。
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
    } else if (progressed && audioContext?.state === 'running') {
      // 仅在上下文运行时累计:AudioContext suspended(Safari 手势前)同样输出全零,
      // 那不是跨源污染,不能误判(会错误重建 audio 并永久降级)
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
    // 分离缓冲与 data 等长(fftSize 变化时重建),在任何读操作之前执行
    if (!hpss || !linearMagnitude || !prevPercussiveLow || linearMagnitude.length !== data.length) {
      hpss = createRealtimeHpss({ bins: data.length })
      linearMagnitude = new Float32Array(data.length)
      prevPercussiveLow = new Float32Array(data.length)
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

    // 自适应能量底:EMA 跟踪近期平均能量,持续低音提供少量环境亮度
    energyFloor += (beatEnergy - energyFloor) * smoothingAlpha(dt, 1.1)

    // 实时 HPSS 掩膜 → 打击成分 30–150Hz 功率 → 连续包络;恢复首帧跳过差分避免伪 flux
    for (let index = 0; index < data.length; index += 1) {
      linearMagnitude[index] = LINEAR_MAGNITUDE_LUT[data[index] ?? 0] ?? 0
    }
    const percussiveMask = hpss.process(linearMagnitude).percussiveMask
    const lowFrom = binOf(30)
    const lowTo = binOf(150)
    const rulerFlux = percussiveLowFlux(data, percussiveMask, prevPercussiveLow, lowFrom, lowTo)
    const lowPower = percussiveLowPower(linearMagnitude, percussiveMask, lowFrom, lowTo)
    const flashRate = sanitizeBeatFlashRate(options.beatFlashRate?.value)
    if (skipNextOdfSample) {
      skipNextOdfSample = false
      tempoRuler.pushSample(now, 0)
      // 用当前功率"预热"包络的上一帧,本帧不产生上升
      envelope.update({
        power: lowPower,
        dtSeconds: 0.001,
        nowMs: now,
        periodMs: 0,
        rate: flashRate,
      })
    } else {
      tempoRuler.pushSample(now, rulerFlux)
    }
    const tempo = tempoRuler.getState()
    const rawLevel = envelope.update({
      power: lowPower,
      dtSeconds: dt,
      nowMs: now,
      periodMs: tempo.locked ? tempo.periodMs : 0,
      rate: flashRate,
    })

    const sustainTarget = clamp((beatEnergy - energyFloor * 1.05) * 6, 0, 1)
    sustainLevel +=
      (sustainTarget - sustainLevel) * smoothingAlpha(dt, sustainTarget > sustainLevel ? 0.15 : 0.6)
    const delayed = delayedLevels(now, rawLevel, sustainLevel)
    beatLevel.value = delayed.level
    // 高频写入：直接 setProperty 到目标节点，跳过 Vue reactivity 与根 :style 路径
    writeBeatLevelToTargets(delayed.level, delayed.sustain)

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
      if (!visibilityListenerRegistered) {
        document.addEventListener('visibilitychange', handleVisibilityChange)
        visibilityListenerRegistered = true
      }
      if (!beatFrame) beatFrame = window.requestAnimationFrame(updateBeatLevel)
    } catch (error) {
      // 启动失败不再静默:此前任何异常都会永久关闭分析且无任何线索
      console.warn('[useBeatAnalyser] 启动节拍分析失败', error)
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
    if (gestureResumeRegistered) {
      document.removeEventListener('pointerdown', handleGestureResume, true)
      document.removeEventListener('keydown', handleGestureResume, true)
      gestureResumeRegistered = false
    }
    audioContext = null
  })

  return { beatLevel, spectrumLevels, startBeatAnalysis, stopBeatAnalysis }
}
