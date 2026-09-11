// 节奏包络(DOM-free 纯模块):把"打击成分低频功率"连续地映射成 0–1 的背景亮度。
// 这是一个表现效果,不做击点判定:输入是每帧的功率,输出是一条快起慢落的包络,
// 判断错了也只是稍微亮一点或暗一点,不会露出"多闪一下 / 漏一拍"这种硬伤。
//   1. 正向通量:只取功率相对上一帧的上升量,底鼓的"咚"是一根尖峰,持续的低音铺底不贡献;
//   2. 自适应定标:地板快速跟低、慢速跟高,峰值瞬时抬升、数秒衰减,每首歌都落在 0–1;
//   3. γ 压缩:中等强度的击点也提到较亮,每一拍看起来差不多,眼睛才认得出"在打拍子";
//   4. 密度闸门:按「闪烁频率」档位限制两次起音的最小间距,闸门内的上升被按住不放,
//      包络照常衰减,于是密集的八分音符低音只呈现为整拍脉冲;
//   5. 起音约 6ms(一帧内到位,是"击"而不是"亮起来"),释放跟随拍长:快歌短促,慢歌留光。
// 在真歌上的离线实验(EDM / 合成器流行 / 放克 / 说唱 / 软摇滚 / 民谣 / 钢琴 / 抒情 / 流行)
// 显示这条包络在有鼓的歌上拍点覆盖 ~90%、拍外误闪 <0.3 次/s、占空 25% 左右。

export const BEAT_FLASH_RATE_STEPS = [0.5, 1, 2, 4] as const
/** 闪烁密度:每拍最多闪几次(0.5 = 每 2 拍一次,4 = 每 ¼ 拍一次) */
export type BeatFlashRate = (typeof BEAT_FLASH_RATE_STEPS)[number]

export function sanitizeBeatFlashRate(value: unknown, fallback: BeatFlashRate = 1): BeatFlashRate {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback
  let best: BeatFlashRate = fallback
  let bestDistance = Number.POSITIVE_INFINITY
  for (const step of BEAT_FLASH_RATE_STEPS) {
    const distance = Math.abs(Math.log2(step) - Math.log2(numeric))
    if (distance < bestDistance) {
      bestDistance = distance
      best = step
    }
  }
  return best
}

export interface BeatEnvelopeOptions {
  /** 起音时间常数(s),默认 0.006 */
  attackTau?: number
  /** 释放时间常数 = 拍长 × 该比例,默认 0.3 */
  releaseRatio?: number
  /** 释放时间常数下限 / 上限(s),默认 0.08 / 0.5 */
  minRelease?: number
  maxRelease?: number
  /** γ 压缩指数,默认 0.6 */
  gamma?: number
  /** 地板向上 / 向下跟踪的时间常数(s),默认 2 / 0.2 */
  floorUpTau?: number
  floorDownTau?: number
  /** 峰值衰减时间常数(s),默认 1.8 */
  peakTau?: number
  /**
   * 峰值定标的下限(与 power 同量纲)。默认按线性功率给:analyser 的 -100dB 底噪
   * 平方后约 1e-10,-70dB 约 1e-7;低于此的"上升"视为静音,不会被放大成满幅闪光
   */
  minPeak?: number
}

export interface BeatEnvelopeInput {
  /** 当前帧的低频打击功率(线性域,任意量纲) */
  power: number
  /** 距上一帧的秒数 */
  dtSeconds: number
  /** 当前时刻(ms),用于密度闸门 */
  nowMs: number
  /** 拍长(ms);未锁定时传 0,按 500ms 处理 */
  periodMs: number
  rate: BeatFlashRate
}

export interface BeatEnvelope {
  update(input: BeatEnvelopeInput): number
  level(): number
  reset(): void
}

const FALLBACK_PERIOD_MS = 500
// 闸门用的拍长上限:尺子估成半速时闸门会把隔一个的底鼓挡掉,封顶后慢歌最多放过八分音符,
// 这个方向的错看不出来
const GATE_PERIOD_CAP_MS = 500
const SPACING_RATIO = 0.8
const MIN_SPACING_MS = 90
// 判定"一次起音":目标亮度高出当前亮度这么多
const RISE_THRESHOLD = 0.25
// 闸门内明显更强的击点仍然放行:因果闸门先到先得,否则拍前的一个弱低音会把正拍的底鼓挡掉
const ACCENT_MARGIN = 0.25

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function smoothingAlpha(dtSeconds: number, tauSeconds: number) {
  return 1 - Math.exp(-dtSeconds / tauSeconds)
}

export function createBeatEnvelope(options: BeatEnvelopeOptions = {}): BeatEnvelope {
  const attackTau = options.attackTau ?? 0.006
  const releaseRatio = options.releaseRatio ?? 0.3
  const minRelease = options.minRelease ?? 0.08
  const maxRelease = options.maxRelease ?? 0.5
  const gamma = options.gamma ?? 0.6
  const floorUpTau = options.floorUpTau ?? 2
  const floorDownTau = options.floorDownTau ?? 0.2
  const peakTau = options.peakTau ?? 1.8
  const minPeak = options.minPeak ?? 1e-7

  let previousPower = 0
  let floor = 0
  let peak = 0
  let level = 0
  let lastRiseAt = -Infinity
  let lastRiseTarget = 0

  return {
    update({ power, dtSeconds, nowMs, periodMs, rate }) {
      const dt = clamp(dtSeconds, 0.001, 0.1)
      const flux = Math.max(0, power - previousPower)
      previousPower = power
      floor += (flux - floor) * smoothingAlpha(dt, flux < floor ? floorDownTau : floorUpTau)
      peak = Math.max(flux, peak * Math.exp(-dt / peakTau), minPeak)
      const span = Math.max(peak - floor, peak * 0.15, 1e-9)
      const normalized = clamp((flux - floor) / span, 0, 1)
      let target = Math.pow(normalized, gamma)
      // 密度闸门:间距内的上升按住不放,包络继续按释放曲线走
      const period = periodMs > 0 ? periodMs : FALLBACK_PERIOD_MS
      const spacing = Math.max(
        MIN_SPACING_MS,
        (Math.min(period, GATE_PERIOD_CAP_MS) / rate) * SPACING_RATIO,
      )
      if (target > level + RISE_THRESHOLD) {
        const gated = nowMs - lastRiseAt < spacing && target < lastRiseTarget + ACCENT_MARGIN
        if (gated) {
          target = Math.min(target, level)
        } else {
          lastRiseAt = nowMs
          lastRiseTarget = target
        }
      }
      const release = clamp((period / 1000) * releaseRatio, minRelease, maxRelease)
      level += (target - level) * smoothingAlpha(dt, target > level ? attackTau : release)
      return level
    },
    level() {
      return level
    },
    reset() {
      previousPower = 0
      floor = 0
      peak = 0
      level = 0
      lastRiseAt = -Infinity
      lastRiseTarget = 0
    },
  }
}
