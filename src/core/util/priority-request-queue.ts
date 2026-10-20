export type RequestPriority = 'foreground' | 'background'

/** Reserve capacity for interactive work; queued work can be promoted in place. */
export function createPriorityRequestQueue(
  concurrency = 4,
  backgroundConcurrency = 2,
  capacity = 32,
) {
  interface Entry {
    priority: RequestPriority
    start: (release: () => void) => void
    reject: (reason: unknown) => void
    state: 'queued' | 'active' | 'finished'
  }
  const queued: Entry[] = []
  const active = new Set<Entry>()
  function drain(): void {
    while (active.size < concurrency) {
      let index = queued.findIndex((entry) => entry.priority === 'foreground')
      if (index < 0) {
        if (
          [...active].filter((entry) => entry.priority === 'background').length >=
          backgroundConcurrency
        )
          return
        index = 0
      }
      const entry = queued.splice(index, 1)[0]
      if (!entry) return
      entry.state = 'active'
      active.add(entry)
      entry.start(() => {
        if (entry.state !== 'active') return
        entry.state = 'finished'
        active.delete(entry)
        drain()
      })
    }
  }
  function enqueue(priority: RequestPriority, start: Entry['start'], reject: Entry['reject']) {
    const entry: Entry = { priority, start, reject, state: 'queued' }
    if (queued.length >= capacity) {
      // A full speculative queue must not reject the current song.
      let index = -1
      if (priority === 'foreground')
        for (let candidate = queued.length - 1; candidate >= 0; candidate -= 1) {
          if (queued[candidate]?.priority === 'background') {
            index = candidate
            break
          }
        }
      if (index >= 0) {
        const removed = queued.splice(index, 1)[0]!
        removed.state = 'finished'
        removed.reject(new Error('Background lyrics queue superseded'))
      } else {
        entry.state = 'finished'
        reject(new Error('Lyrics request queue full'))
      }
    }
    if (entry.state === 'queued') queued.push(entry)
    drain()
    return {
      setPriority(priority: RequestPriority) {
        if (entry.state === 'finished' || entry.priority === priority) return
        entry.priority = priority
        drain()
      },
      cancel(reason: unknown) {
        if (entry.state !== 'queued') return
        entry.state = 'finished'
        queued.splice(queued.indexOf(entry), 1)
        reject(reason)
        drain()
      },
    }
  }
  return { enqueue }
}
