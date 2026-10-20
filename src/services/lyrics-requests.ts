import {
  createPriorityRequestQueue,
  type RequestPriority,
} from '../core/util/priority-request-queue'
import {
  LYRICS_MAX_CONCURRENT_REQUESTS,
  LYRICS_MAX_BACKGROUND_REQUESTS,
  LYRICS_MAX_QUEUED_REQUESTS,
} from '../config/lyrics'

interface PriorityScope {
  priority: RequestPriority
  listeners: Set<() => void>
  subscribers: Set<() => RequestPriority>
}
const scopes = new WeakMap<AbortSignal, PriorityScope>()
const requests = createPriorityRequestQueue(
  LYRICS_MAX_CONCURRENT_REQUESTS,
  LYRICS_MAX_BACKGROUND_REQUESTS,
  LYRICS_MAX_QUEUED_REQUESTS,
)

/** Associate priority with the existing cancellation contract across provider adapters. */
export function initializeLyricsPriority(
  signal: AbortSignal,
  priority: RequestPriority = 'background',
): void {
  scopes.set(signal, { priority, listeners: new Set(), subscribers: new Set() })
}

function scope(signal: AbortSignal): PriorityScope {
  let value = scopes.get(signal)
  if (!value) {
    value = { priority: 'foreground', listeners: new Set(), subscribers: new Set() }
    scopes.set(signal, value)
  }
  return value
}

/** Promotion propagates into already queued mirror/native/text requests, without restarting IO. */
export function subscribeLyricsPriority(target: AbortSignal, source?: AbortSignal): () => void {
  const destination = scope(target)
  const origin = source ? scope(source) : undefined
  const current = (): RequestPriority => origin?.priority ?? 'foreground'
  const update = () => {
    const priority = [...destination.subscribers].some((read) => read() === 'foreground')
      ? 'foreground'
      : 'background'
    if (destination.priority === priority) return
    destination.priority = priority
    for (const listener of destination.listeners) listener()
  }
  destination.subscribers.add(current)
  update()
  origin?.listeners.add(update)
  return () => {
    origin?.listeners.delete(update)
    destination.subscribers.delete(current)
    update()
  }
}

export function inheritLyricsPriority(target: AbortSignal, source: AbortSignal): void {
  scopes.set(target, scope(source))
}

/** One budget for all lyric transports, including response body reads. */
export function acquireLyricsRequest(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const priority = scope(signal)
    let releaseRequest: (() => void) | undefined
    let rejected = false
    const ticket = requests.enqueue(
      priority.priority,
      (release) => {
        releaseRequest = release
        resolve(() => {
          cleanup()
          release()
        })
      },
      (reason) => {
        rejected = true
        cleanup()
        reject(reason)
      },
    )
    function cleanup(): void {
      signal.removeEventListener('abort', abort)
      priority.listeners.delete(promote)
    }
    function abort(): void {
      cleanup()
      ticket.cancel(signal.reason)
      // The active transport owns its permit until its body/abort handling settles.
    }
    function promote(): void {
      ticket.setPriority(priority.priority)
    }
    if (rejected) return
    if (!releaseRequest) signal.addEventListener('abort', abort, { once: true })
    priority.listeners.add(promote)
    if (signal.aborted) abort()
  })
}
