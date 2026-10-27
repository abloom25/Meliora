export type PlaybackResourcePressure = 'normal' | 'constrained' | 'buffering'

/** Measure real RAF spacing, before any intentional visual throttling. */
export function createFrameBudget() {
  let previous = 0
  let start = 0
  let frames = 0
  let late = 0
  let veryLate = 0
  let badWindows = 0
  let goodWindows = 0
  let level = 0
  function resetWindow(): void {
    previous = start = frames = late = veryLate = badWindows = goodWindows = 0
  }
  return {
    reset: resetWindow,
    sample(now: number): number {
      if (!Number.isFinite(now)) return level
      const delta = previous ? now - previous : 0
      previous = now
      if (!start || delta <= 0 || delta > 1000) {
        start = now
        frames = late = veryLate = 0
        return level
      }
      frames += 1
      if (delta > 32) late += 1
      if (delta > 60) veryLate += 1
      if (now - start < 1000) return level
      const bad = late / frames > 0.25
      badWindows = bad ? badWindows + 1 : 0
      goodWindows = late / frames < 0.1 ? goodWindows + 1 : 0
      if (badWindows >= 2) {
        level = Math.max(level, veryLate / frames > 0.15 ? 2 : 1)
        badWindows = goodWindows = 0
      } else if (goodWindows >= 6) {
        level = Math.max(0, level - 1)
        goodWindows = 0
      }
      start = now
      frames = late = veryLate = 0
      return level
    },
  }
}

/** Hysteresis prevents analysis starting/stopping around a single buffer threshold. */
export function shouldConserveAudioBuffer(input: {
  wasConstrained: boolean
  playing: boolean
  waiting: boolean
  bufferedSeconds: number
  remainingSeconds: number
}): boolean {
  if (!input.playing) return false
  if (input.waiting) return true
  if (input.bufferedSeconds === Infinity) return false
  if (!Number.isFinite(input.bufferedSeconds)) return input.wasConstrained
  if (input.remainingSeconds <= input.bufferedSeconds + 0.25) return false
  return input.bufferedSeconds < (input.wasConstrained ? 8 : 3)
}
