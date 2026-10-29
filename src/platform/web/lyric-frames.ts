export type LyricFramePhase = 'layout' | 'scene' | 'motion' | 'paint'
const PHASES: LyricFramePhase[] = ['layout', 'scene', 'motion', 'paint']

/** One browser frame per document host; later phases can join the current transaction. */
export function createLyricFrames(
  host: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>,
) {
  const pending = new Map<number, { phase: LyricFramePhase; callback: FrameRequestCallback }>()
  let sequence = 0
  let frame = 0
  let flushing = false
  let disposed = false

  function schedule(): void {
    if (!disposed && !flushing && !frame && pending.size) frame = host.requestAnimationFrame(flush)
  }

  function flush(time: number): void {
    frame = 0
    flushing = true
    try {
      for (const phase of PHASES) {
        const batch = [...pending].filter(([, task]) => task.phase === phase)
        for (const [id, task] of batch) {
          if (!pending.delete(id)) continue
          task.callback(time)
        }
      }
    } finally {
      flushing = false
      schedule()
    }
  }

  function cancel(id: number): void {
    pending.delete(id)
    if (!pending.size && frame) {
      host.cancelAnimationFrame(frame)
      frame = 0
    }
  }

  return {
    request(phase: LyricFramePhase, callback: FrameRequestCallback): number {
      if (disposed) return 0
      const id = ++sequence
      pending.set(id, { phase, callback })
      schedule()
      return id
    },
    cancel,
    dispose(): void {
      disposed = true
      pending.clear()
      if (frame) host.cancelAnimationFrame(frame)
      frame = 0
    },
  }
}
