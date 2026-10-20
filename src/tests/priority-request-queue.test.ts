import { describe, expect, it, vi } from 'vitest'
import { createPriorityRequestQueue } from '../core/util/priority-request-queue'

describe('request priority budget', () => {
  it('reserves capacity for foreground and promotes queued and active work in place', () => {
    const queue = createPriorityRequestQueue(4, 2)
    const order: string[] = []
    const releases = new Map<string, () => void>()
    const add = (id: string, priority: 'foreground' | 'background') =>
      queue.enqueue(
        priority,
        (release) => {
          order.push(id)
          releases.set(id, release)
        },
        vi.fn(),
      )
    const first = add('background-1', 'background')
    add('background-2', 'background')
    add('background-3', 'background')
    const fourth = add('background-4', 'background')
    expect(order).toEqual(['background-1', 'background-2'])
    fourth.setPriority('foreground')
    add('current', 'foreground')
    expect(order).toEqual(['background-1', 'background-2', 'background-4', 'current'])
    first.setPriority('foreground')
    releases.get('current')!()
    expect(order.at(-1)).toBe('background-3')
    for (const release of releases.values()) release()
  })

  it('lets foreground overtake queued prefetch and replaces speculative overflow', () => {
    const queue = createPriorityRequestQueue(1, 1, 2)
    let release!: () => void
    queue.enqueue(
      'foreground',
      (done) => {
        release = done
      },
      vi.fn(),
    )
    const rejected = vi.fn()
    const next = vi.fn()
    queue.enqueue('background', next, vi.fn())
    queue.enqueue('background', vi.fn(), rejected)
    const current = vi.fn()
    queue.enqueue('foreground', current, vi.fn())
    expect(rejected).toHaveBeenCalledOnce()
    release()
    expect(current).toHaveBeenCalledOnce()
    expect(next).not.toHaveBeenCalled()
  })

  it('removes cancelled queued work without releasing another active request', () => {
    const queue = createPriorityRequestQueue(1, 1)
    let release!: () => void
    queue.enqueue(
      'foreground',
      (done) => {
        release = done
      },
      vi.fn(),
    )
    const start = vi.fn()
    const reject = vi.fn()
    const ticket = queue.enqueue('foreground', start, reject)
    ticket.cancel('cancelled')
    ticket.cancel('cancelled again')
    release()
    release()
    expect(start).not.toHaveBeenCalled()
    expect(reject).toHaveBeenCalledExactlyOnceWith('cancelled')
  })
})
