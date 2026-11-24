import type { BeatTimeline } from '../analysis/beat-timeline'
import { continuousBeatCoverage } from '../analysis/beat-scheduling'

export interface MixSilence {
  leading: number
  trailing: number
}

export interface MixAnalysis {
  timeline: BeatTimeline | null
  silence?: MixSilence
}

export interface MixTransition {
  startAt: number
  offset: number
  seconds: number
}

// 只跳过连续近乎数字零的采样，留下 50ms 保护极弱的起音和混响。
export function measureMixSilence(
  channels: readonly Float32Array[],
  sampleRate: number,
): MixSilence {
  const length = channels[0]?.length ?? 0
  const limit = Math.min(Math.floor(sampleRate * 3), Math.floor(length / 5))
  function measure(fromEnd: boolean): number {
    let count = limit
    for (const channel of channels) {
      let i = 0
      while (i < count && Math.abs(channel[fromEnd ? length - 1 - i : i]!) < 0.0001) i++
      count = i
    }
    return sampleRate > 0 ? Math.max(0, count / sampleRate - 0.05) : 0
  }
  return { leading: measure(false), trailing: measure(true) }
}

// 在八秒窗口里，以两端的实测强峰为锚点尝试不同拍数。
// 同时要求大多数强峰落在网格上、网格上大多数拍都有实测支持，避免把漏拍误判为倍速。
function fitBeatGrid(peaks: number[], levels: Float32Array, step: number) {
  const strengths = peaks.map((frame) => levels[frame]!).sort((a, b) => a - b)
  const threshold = (strengths[Math.floor(strengths.length * 0.75)] ?? 0) * 0.55
  const times = peaks.filter((frame) => levels[frame]! >= threshold).map((frame) => frame * step)
  let bestScore = 0
  let grid = { period: 0, beats: [] as number[] }
  if (times.length < 5) return grid

  for (const first of times.slice(0, 3)) {
    for (const last of times.slice(-3)) {
      const span = last - first
      for (
        let count = Math.max(4, Math.ceil(span / 1.01));
        count <= Math.floor(span / 0.295);
        count++
      ) {
        const period = span / count
        const tolerance = Math.min(period * 0.15, Math.max(0.035, step * 1.5))
        const matches: number[] = []
        let score = 0
        for (const time of times) {
          const delta = time - first
          const error = Math.abs(delta - Math.round(delta / period) * period)
          if (error > tolerance) continue
          matches.push(time)
          score += 1 - 0.5 * (error / tolerance) ** 2
        }
        if (matches.length < 5 || matches.length < times.length * 0.7) continue
        const slots = 1 + Math.round((matches.at(-1)! - matches[0]!) / period)
        const coverage = matches.length / slots
        score *= coverage
        if (coverage >= 0.65 && score > bestScore) {
          bestScore = score
          grid = { period, beats: matches }
        }
      }
    }
  }
  return grid
}

// 只读连续分析过的区间。窗口中未构建的零值没有音量或节奏含义。
function readEdge(timeline: BeatTimeline | null, start: number, end: number) {
  if (!timeline || end - start < 1 || timeline.stepSeconds <= 0) return null
  const ranges = timeline.completedRanges ?? [
    { startSeconds: 0, endSeconds: timeline.builtUntilSeconds ?? timeline.durationSeconds },
  ]
  if (continuousBeatCoverage(ranges, start, timeline.durationSeconds) + 0.03 < end - start)
    return null
  const step = timeline.stepSeconds
  const levels = timeline.levels[1]
  const first = Math.ceil(start / step)
  const last = Math.min(Math.floor(end / step), levels.length - 1, timeline.sustain.length - 1)
  if (first >= last) return null
  let energy = 0
  const peaks: number[] = []
  for (let i = first; i <= last; i++) {
    energy += timeline.sustain[i]!
    const level = levels[i]!
    if (level < 0.12 || level <= (levels[i - 1] ?? 0) || level < (levels[i + 1] ?? 0)) continue
    const previous = peaks.at(-1)
    if (previous === undefined || (i - previous) * step >= 0.18) peaks.push(i)
    else if (level > levels[previous]!) peaks[peaks.length - 1] = i
  }
  return { energy: energy / (last - first + 1), ...fitBeatGrid(peaks, levels, step) }
}

/** 选曲尾衔接点，让新歌的第一拍尽量落在旧歌实测的拍点上，不改变原速。 */
export function planSmartMix(
  duration: number,
  nextDuration: number,
  outgoing: MixAnalysis,
  incoming: MixAnalysis,
  currentTime = 0,
): MixTransition | null {
  if (![duration, nextDuration].every((value) => Number.isFinite(value) && value >= 3)) return null
  const end = duration - Math.min(outgoing.silence?.trailing ?? 0, duration / 5)
  const offset = Math.min(incoming.silence?.leading ?? 0, nextDuration / 5)
  const tail = readEdge(outgoing.timeline, Math.max(0, end - 8), end)
  const head = readEdge(incoming.timeline, offset, Math.min(nextDuration, offset + 8))
  const limit = Math.min(5, end / 4, (nextDuration - offset) / 4)
  let seconds = Math.min(limit, 1.25)
  if (tail && head) {
    const busy = Math.max(tail.energy, head.energy)
    seconds = Math.min(limit, busy > 0.45 ? 1.5 : 3)
    if (tail.period && head.period) {
      // 两首歌在重叠期里漂移超过约 1/8 拍时，缩短叠拍，避免鼓点打架。
      const drift = Math.abs(tail.period - head.period)
      const maxSeconds = drift > 0 ? (tail.period * head.period) / (8 * drift) : Infinity
      const overlapLimit = Math.min(limit, maxSeconds)
      if (overlapLimit >= 2 * head.period) {
        const firstBeat = head.beats[0]! - offset
        const secondBeat = head.beats[1]! - offset
        const preferred = end - Math.min(overlapLimit, (busy > 0.45 ? 4 : 8) * tail.period)
        const candidates = tail.beats
          .map((beat) => beat - firstBeat)
          .filter(
            (time) =>
              time >= Math.max(end - overlapLimit, currentTime - 0.045) &&
              time <= end - Math.max(0.65, secondBeat) &&
              tail.beats.some((beat) => Math.abs(beat - (time + secondBeat)) <= tail.period / 8),
          )
        if (candidates.length) {
          const startAt = candidates.reduce((a, b) =>
            Math.abs(a - preferred) <= Math.abs(b - preferred) ? a : b,
          )
          return { startAt, seconds: end - startAt, offset }
        }
      }
      seconds = Math.min(seconds, 1)
    }
  }
  return { startAt: end - seconds, seconds, offset }
}

export function equalPowerGains(progress: number): { incoming: number; outgoing: number } {
  const t = Math.min(1, Math.max(0, progress))
  return {
    incoming: Math.sin((t * Math.PI) / 2),
    outgoing: t === 1 ? 0 : Math.cos((t * Math.PI) / 2),
  }
}
