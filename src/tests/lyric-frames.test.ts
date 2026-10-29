import { describe, expect, it, vi } from 'vitest'
import { createLyricFrames } from '../platform/web/lyric-frames'

function fixture() {
  let next = 0
  const callbacks = new Map<number, FrameRequestCallback>()
  const host = {
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      callbacks.set(++next, callback)
      return next
    }),
    cancelAnimationFrame: vi.fn((id: number) => {
      callbacks.delete(id)
    }),
  }
  const frames = createLyricFrames(host)
  const flush = (time: number) => {
    const batch = [...callbacks.values()]
    callbacks.clear()
    batch.forEach((callback) => callback(time))
  }
  return { frames, host, flush, callbacks }
}

describe('lyric frame transactions', () => {
  it('coalesces independent work, lets new later phases join and shares one timestamp', () => {
    const { frames, host, flush, callbacks } = fixture()
    const order: string[] = []
    frames.request('motion', (time) => order.push(`motion:${time}`))
    frames.request('scene', (time) => {
      order.push(`scene:${time}`)
      frames.request('paint', (time) => order.push(`paint:${time}`))
    })
    frames.request('layout', (time) => order.push(`layout:${time}`))
    expect(host.requestAnimationFrame).toHaveBeenCalledTimes(1)
    flush(16)
    expect(order).toEqual(['layout:16', 'scene:16', 'motion:16', 'paint:16'])
    expect(callbacks.size).toBe(0)
  })

  it('defers repeated and earlier phases to the next frame instead of spinning', () => {
    const { frames, flush, callbacks } = fixture()
    const order: string[] = []
    frames.request('motion', () => {
      order.push('motion')
      frames.request('scene', () => order.push('scene'))
      frames.request('motion', () => order.push('next-motion'))
    })
    flush(8)
    expect(order).toEqual(['motion'])
    expect(callbacks.size).toBe(1)
    flush(16)
    expect(order).toEqual(['motion', 'scene', 'next-motion'])
    expect(callbacks.size).toBe(0)
  })

  it('honors cancellation during a transaction and releases the native callback on disposal', () => {
    const { frames, flush, callbacks } = fixture()
    const paint = vi.fn()
    const handle = frames.request('paint', paint)
    frames.request('scene', () => frames.cancel(handle))
    flush(16)
    expect(paint).not.toHaveBeenCalled()
    frames.request('paint', paint)
    frames.dispose()
    expect(callbacks.size).toBe(0)
    expect(frames.request('paint', paint)).toBe(0)
  })
})
