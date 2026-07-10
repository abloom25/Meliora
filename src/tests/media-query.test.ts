import { describe, expect, it, vi } from 'vitest'
import { listenMediaQuery, type MediaQueryChangeHandler } from '../utils/media-query'

describe('listenMediaQuery', () => {
  it('uses modern change listeners when available', () => {
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const query = {
      matches: false,
      media: '(max-width: 720px)',
      onchange: null,
      addEventListener,
      removeEventListener,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList
    const handler = vi.fn()

    const stop = listenMediaQuery(query, handler)
    stop()

    expect(addEventListener).toHaveBeenCalledWith('change', handler)
    expect(removeEventListener).toHaveBeenCalledWith('change', handler)
  })

  it('falls back to legacy Safari addListener/removeListener', () => {
    const addListener = vi.fn()
    const removeListener = vi.fn()
    const query = {
      matches: false,
      media: '(display-mode: standalone)',
      onchange: null,
      addListener,
      removeListener,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList
    const handler: MediaQueryChangeHandler = vi.fn()

    const stop = listenMediaQuery(query, handler)
    stop()

    expect(addListener).toHaveBeenCalledWith(handler)
    expect(removeListener).toHaveBeenCalledWith(handler)
  })
})
