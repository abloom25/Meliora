import { listenMediaQuery } from './media-query'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
const mediaQuery =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null

let cached = mediaQuery?.matches ?? false
const listeners = new Set<(value: boolean) => void>()

function notify(value: boolean) {
  cached = value
  listeners.forEach((fn) => fn(value))
}

if (mediaQuery) {
  const handler = (event: MediaQueryListEvent | MediaQueryList) => notify(event.matches)
  listenMediaQuery(mediaQuery, handler)
}

export function isReducedMotion(): boolean {
  return cached
}

export function onReducedMotionChange(fn: (value: boolean) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
