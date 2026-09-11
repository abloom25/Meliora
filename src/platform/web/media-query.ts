export type MediaQueryChangeHandler = (event: MediaQueryListEvent | MediaQueryList) => void

type LegacyMediaQueryList = MediaQueryList & {
  addListener?: (listener: MediaQueryChangeHandler) => void
  removeListener?: (listener: MediaQueryChangeHandler) => void
}

export function listenMediaQuery(
  mediaQuery: MediaQueryList,
  handler: MediaQueryChangeHandler,
): () => void {
  const legacyMediaQuery = mediaQuery as LegacyMediaQueryList

  if (typeof legacyMediaQuery.addEventListener === 'function') {
    legacyMediaQuery.addEventListener('change', handler)
    return () => legacyMediaQuery.removeEventListener('change', handler)
  }

  if (typeof legacyMediaQuery.addListener === 'function') {
    legacyMediaQuery.addListener(handler)
    return () => legacyMediaQuery.removeListener?.(handler)
  }

  return () => {}
}
