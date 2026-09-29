export type HapticStyle =
  | 'light'
  | 'medium'
  | 'heavy'
  | 'selection'
  | 'success'
  | 'warning'
  | 'error'

const HAPTIC_PATTERNS: Record<HapticStyle, number | number[]> = {
  light: 9,
  medium: 16,
  heavy: [8, 22, 10],
  selection: 6,
  success: [7, 34, 13],
  warning: [20, 40, 20],
  error: [30, 60, 30, 60, 30],
}

function isPhoneDevice(): boolean {
  const userAgent = navigator.userAgent
  const platform = navigator.platform
  const coarsePointer = window.matchMedia('(pointer: coarse)').matches
  const touchPoints = navigator.maxTouchPoints || 0
  const iPadDesktopMode = platform === 'MacIntel' && touchPoints > 1
  const phoneLike =
    /iPhone|iPod|Windows Phone/i.test(userAgent) ||
    /Android.*Mobile/i.test(userAgent) ||
    (coarsePointer && touchPoints > 0 && Math.min(window.screen.width, window.screen.height) <= 520)
  return !iPadDesktopMode && phoneLike
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useHaptic() {
  function triggerHaptic(style: HapticStyle = 'light'): void {
    if (!isPhoneDevice() || !('vibrate' in navigator) || prefersReducedMotion()) {
      return
    }
    navigator.vibrate(HAPTIC_PATTERNS[style])
  }

  function withHaptic<A extends unknown[], R>(
    fn: (...args: A) => R,
    style: HapticStyle = 'light',
  ): (...args: A) => R {
    return (...args: A) => {
      triggerHaptic(style)
      return fn(...args)
    }
  }

  return { triggerHaptic, withHaptic }
}
