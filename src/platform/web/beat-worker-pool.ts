import type { BeatThisModelId } from '../../core/analysis/beat-this-models'

const IDLE_TIMEOUT_MS = 60_000

interface Entry {
  worker?: Worker
  ready: boolean
  busy: boolean
  controller: AbortController
  timer?: number
}

export interface BeatWorkerLease {
  readonly worker: Worker | undefined
  readonly ready: boolean
  readonly signal: AbortSignal
  attach(worker: Worker): void
  release(keep: boolean): void
}

// Only two model IDs exist. A busy entry is never evicted to make another
// worker: simultaneous requests for that model wait for its exclusive lease.
const entries = new Map<BeatThisModelId, Entry>()
const waiters = new Set<() => void>()

function changed(): void {
  for (const listener of [...waiters]) listener()
}

function closeIdleWorker(entry: Entry, done: () => void): void {
  const worker = entry.worker!
  // Release GPU allocations before terminating an idle worker. Broken workers
  // still have a bounded lifetime if their disposal acknowledgment never comes.
  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    window.clearTimeout(entry.timer)
    worker.onmessage = null
    worker.terminate()
    done()
  }
  entry.timer = window.setTimeout(finish, 1_000)
  worker.onmessage = (event: MessageEvent<{ type: string }>): void => {
    if (event.data.type !== 'disposed') return
    finish()
  }
  try {
    worker.postMessage({ type: 'dispose' })
  } catch {
    finish()
  }
}

function discard(id: BeatThisModelId, entry: Entry, graceful: boolean): void {
  if (entries.get(id) !== entry) return
  window.clearTimeout(entry.timer)
  // A closing worker still owns one slot until disposal or its hard deadline.
  entry.busy = true
  entry.controller.abort()
  const finish = (): void => {
    if (entries.get(id) === entry) entries.delete(id)
    changed()
  }
  if (entry.worker) {
    if (graceful) {
      closeIdleWorker(entry, finish)
      return
    }
    entry.worker.terminate()
  }
  finish()
}

/** Model removal invalidates both idle sessions and builds reading those assets. */
export function invalidateBeatModelSessions(id?: BeatThisModelId): void {
  for (const [key, entry] of [...entries]) if (!id || key === id) discard(key, entry, false)
}

if (import.meta.hot) import.meta.hot.dispose(() => invalidateBeatModelSessions())

export async function acquireBeatModelSession(
  id: BeatThisModelId,
  signal: AbortSignal,
): Promise<BeatWorkerLease> {
  for (;;) {
    signal.throwIfAborted()
    let entry = entries.get(id)
    if (!entry?.busy) {
      if (!entry) {
        entry = { ready: false, busy: false, controller: new AbortController() }
        entries.set(id, entry)
      }
      window.clearTimeout(entry.timer)
      entry.busy = true
      const owned = entry
      let released = false
      return {
        get worker() {
          return owned.worker
        },
        get ready() {
          return owned.ready
        },
        signal: owned.controller.signal,
        attach(worker): void {
          owned.controller.signal.throwIfAborted()
          owned.worker = worker
        },
        release(keep): void {
          if (released) return
          released = true
          if (entries.get(id) !== owned || owned.controller.signal.aborted) return
          if (!keep || !owned.worker) {
            discard(id, owned, false)
            return
          }
          owned.ready = true
          owned.busy = false
          owned.worker.onerror = owned.worker.onmessageerror = (): void => discard(id, owned, false)
          owned.timer = window.setTimeout(() => discard(id, owned, true), IDLE_TIMEOUT_MS)
          changed()
        },
      }
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        waiters.delete(wake)
        signal.removeEventListener('abort', abort)
      }
      const wake = (): void => {
        finish()
        resolve()
      }
      const abort = (): void => {
        finish()
        reject(new DOMException('Aborted', 'AbortError'))
      }
      waiters.add(wake)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}
