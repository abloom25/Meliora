// 速度尺子(DOM-free 纯模块):只回答"这首歌现在的拍长大概是多少"。
// 它不决定何时闪——闪光由 beat-envelope 的连续包络负责;拍长只用来定包络的释放时长
// 和「闪烁频率」档位的最小间距。
// 估计方法:onset 检测函数(ODF)按固定 10ms 槽入环形历史,每 500ms 做一次
//   1. 去均值归一化自相关(ACF)——ODF 恒非负,不去均值任何 lag 的相关度都接近 1,
//      速度就只剩先验在决定(旧实现锁死在 ~121 BPM 的根因);
//   2. 梳齿谐波求和抗噪,先用宽先验挑原始峰;
//   3. 在谐波家族(⅓ ½ ⅔ 1 1.5 2 3 倍)里用偏紧的对数高斯先验挑一档,解八度歧义。先验中心
//      略偏快(132 BPM):尺子只用于释放时长与密度闸门,估快了闸门只是更松,估成半速会把
//      隔一个的底鼓挡掉,后者才是看得见的错;已锁定时对八度关系的新估计有粘性,不来回跳;
//   4. 抛物线插值到亚槽周期;置信度带滞回锁定 / 解锁,静默 2s 后衰减。

export interface TempoRulerOptions {
  /** ODF 槽宽(ms),默认 10 */
  slotMs?: number
  /** 环形历史长度(槽数),默认 600(6s) */
  historySlots?: number
  minBpm?: number
  maxBpm?: number
  /** 速度先验中心(BPM),默认 132 */
  priorBpm?: number
}

export interface TempoState {
  bpm: number
  periodMs: number
  confidence: number
  locked: boolean
}

export interface TempoRuler {
  pushSample(nowMs: number, flux: number): void
  getState(): TempoState
  reset(): void
}

const LOCK_CONFIDENCE = 0.12
const UNLOCK_CONFIDENCE = 0.07
const ONSET_REFRACTORY_SLOTS = 12
const ONSET_QUIET_MS = 2000
const ESTIMATE_INTERVAL_MS = 500
const MIN_ESTIMATE_SLOTS = 250
// 已锁定时,与当前周期成八度关系的新估计要明显更好才切换
const OCTAVE_STICKINESS = 0.85

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function logGaussianPrior(bpm: number, centerBpm: number, sigmaOctaves: number) {
  const octaves = Math.log2(bpm / centerBpm)
  return Math.exp(-0.5 * (octaves / sigmaOctaves) ** 2)
}

function parabolicPeak(left: number, center: number, right: number) {
  const denominator = left - 2 * center + right
  if (Math.abs(denominator) < 1e-9) return { offset: 0, value: center }
  const offset = clamp((0.5 * (left - right)) / denominator, -0.5, 0.5)
  const value = center - 0.25 * (left - right) * offset
  return { offset, value }
}

export function createTempoRuler(options: TempoRulerOptions = {}): TempoRuler {
  const slotMs = options.slotMs ?? 10
  const historySlots = options.historySlots ?? 600
  const minBpm = options.minBpm ?? 40
  const maxBpm = options.maxBpm ?? 222
  const priorBpm = options.priorBpm ?? 132
  const minTau = Math.max(2, Math.round(60000 / (maxBpm * slotMs)))
  const maxTau = Math.round(60000 / (minBpm * slotMs))

  const history = new Float32Array(historySlots)
  let originMs = 0
  let slotCount = 0
  let slotStartMs = 0
  let slotFlux = 0
  let lastOnsetSlot = -1000
  let lastOnsetMs = 0
  let hasOnset = false
  let lastEstimateMs = 0
  let lastSampleMs = 0
  let periodSlots = 0
  let confidence = 0
  let locked = false

  function reset() {
    history.fill(0)
    originMs = 0
    slotCount = 0
    slotStartMs = 0
    slotFlux = 0
    lastOnsetSlot = -1000
    lastOnsetMs = 0
    hasOnset = false
    lastEstimateMs = 0
    lastSampleMs = 0
    periodSlots = 0
    confidence = 0
    locked = false
  }

  function histAt(absSlot: number) {
    if (absSlot < 0 || absSlot >= slotCount || absSlot < slotCount - historySlots) return 0
    return history[absSlot % historySlots] ?? 0
  }

  // Böck peak-picking(局部极大 + 1s 移动均值阈值 + 不应期)只用来知道"最近有没有击点",
  // 静默段据此让置信度衰减,间奏不会抱着旧速度不放
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
    if (slot - lastOnsetSlot < ONSET_REFRACTORY_SLOTS) return
    lastOnsetSlot = slot
    lastOnsetMs = originMs + slot * slotMs
    hasOnset = true
  }

  function pushSample(nowMs: number, flux: number) {
    if (slotStartMs === 0) {
      slotStartMs = nowMs
      originMs = nowMs
    }
    if (nowMs - slotStartMs > historySlots * slotMs) {
      reset()
      slotStartMs = nowMs
      originMs = nowMs
    }
    const dtMs = lastSampleMs > 0 ? clamp(nowMs - lastSampleMs, 0, 100) : 0
    lastSampleMs = nowMs
    slotFlux = Math.max(slotFlux, flux)
    while (nowMs - slotStartMs >= slotMs) {
      history[slotCount % historySlots] = slotFlux
      slotCount += 1
      slotFlux = 0
      slotStartMs += slotMs
      evaluateOnsetSlot(slotCount - 2)
    }
    if (hasOnset && nowMs - lastOnsetMs > ONSET_QUIET_MS) {
      confidence *= Math.exp(-dtMs / 1000)
      if (confidence < UNLOCK_CONFIDENCE) locked = false
    }
    if (nowMs - lastEstimateMs >= ESTIMATE_INTERVAL_MS) {
      lastEstimateMs = nowMs
      estimateTempo(nowMs)
    }
  }

  function estimateTempo(nowMs: number) {
    const N = Math.min(slotCount, historySlots)
    if (N < MIN_ESTIMATE_SLOTS) return
    const h = new Float32Array(N)
    let mean = 0
    for (let i = 0; i < N; i += 1) {
      const value = histAt(slotCount - N + i)
      h[i] = value
      mean += value
    }
    mean /= N
    let variance = 0
    for (let i = 0; i < N; i += 1) {
      const centered = (h[i] ?? 0) - mean
      h[i] = centered
      variance += centered * centered
    }
    variance /= N
    if (variance < 1e-8) {
      confidence = 0
      locked = false
      return
    }
    const maxLag = Math.min(N - 100, maxTau * 3)
    const acf = new Float32Array(maxLag + 2)
    for (let tau = minTau; tau <= maxLag; tau += 1) {
      let sum = 0
      for (let n = tau; n < N; n += 1) sum += (h[n] ?? 0) * (h[n - tau] ?? 0)
      acf[tau] = sum / ((N - tau) * variance)
    }
    const acfPeakNear = (lag: number) => {
      const k = Math.round(lag)
      if (k < minTau + 1 || k > maxLag - 1) return Number.NaN
      const left = acf[k - 1] ?? 0
      const center = acf[k] ?? 0
      const right = acf[k + 1] ?? 0
      return Math.max(left, center, right, parabolicPeak(left, center, right).value)
    }
    const combScore = (tau: number) => {
      let score = 0
      let weightSum = 0
      for (let k = 1; k <= 4; k += 1) {
        const value = acfPeakNear(tau * k)
        if (Number.isNaN(value)) break
        score += value / k
        weightSum += 1 / k
      }
      return weightSum > 0 ? score / weightSum : 0
    }
    const bpmOf = (tau: number) => 60000 / (tau * slotMs)
    let rawTau = 0
    let rawBest = -Infinity
    for (let tau = minTau; tau <= maxTau; tau += 1) {
      const score = combScore(tau) * logGaussianPrior(bpmOf(tau), priorBpm, 1.2)
      if (score > rawBest) {
        rawBest = score
        rawTau = tau
      }
    }
    if (rawTau === 0) return
    const familyScore = (tau: number) =>
      combScore(tau) * logGaussianPrior(bpmOf(tau), priorBpm, 0.5)
    let chosen = rawTau
    for (let iteration = 0; iteration < 3; iteration += 1) {
      const family = [1 / 3, 1 / 2, 2 / 3, 1, 3 / 2, 2, 3]
        .map((ratio) => Math.round(chosen * ratio))
        .filter((tau) => tau >= minTau && tau <= maxTau)
      let bestTau = chosen
      let bestScore = -Infinity
      for (const tau of family) {
        const score = familyScore(tau)
        if (score > bestScore) {
          bestScore = score
          bestTau = tau
        }
      }
      if (bestTau === chosen) break
      chosen = bestTau
    }
    // 八度粘性:新估计与当前周期成整数倍 / 分数关系时,当前周期不明显更差就保持
    if (locked && periodSlots > 0) {
      const currentTau = Math.round(periodSlots)
      const ratio = chosen / currentTau
      const octaveRelated = [1 / 3, 1 / 2, 2 / 3, 3 / 2, 2, 3].some(
        (r) => Math.abs(ratio - r) < r * 0.08,
      )
      if (
        octaveRelated &&
        currentTau >= minTau &&
        currentTau <= maxTau &&
        familyScore(currentTau) >= familyScore(chosen) * OCTAVE_STICKINESS
      ) {
        chosen = currentTau
      }
    }
    const left = acf[chosen - 1] ?? 0
    const center = acf[chosen] ?? 0
    const right = acf[chosen + 1] ?? 0
    const refined = parabolicPeak(left, center, right)
    const peak = clamp(Math.max(center, refined.value), 0, 1)
    // 静默段历史里仍留着之前的周期内容,重估只允许把置信度往下压
    const quiet = hasOnset && nowMs - lastOnsetMs > ONSET_QUIET_MS
    confidence = quiet ? Math.min(confidence, peak) : peak
    if (!locked && !quiet && confidence >= LOCK_CONFIDENCE) locked = true
    if (locked && confidence < UNLOCK_CONFIDENCE) locked = false
    periodSlots = chosen + refined.offset
  }

  function getState(): TempoState {
    const periodMs = periodSlots * slotMs
    return {
      bpm: periodSlots > 0 ? 60000 / periodMs : 0,
      periodMs,
      confidence,
      locked,
    }
  }

  return { pushSample, getState, reset }
}
