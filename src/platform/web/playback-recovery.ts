export type PlaybackRecoveryPhase = 'idle' | 'offline' | 'retrying' | 'exhausted'

/** One bounded recovery cycle per playback intent. Events and play() rejection share it. */
export function createPlaybackRecovery(options: {
  retry: () => void
  onPhase: (phase: PlaybackRecoveryPhase) => void
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let attempts = 0
  let pending = false
  let attempting = false
  let phase: PlaybackRecoveryPhase = 'idle'
  let disposed = false
  const online = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false
  function setPhase(next: PlaybackRecoveryPhase): void {
    phase = next
    options.onPhase(next)
  }
  function clearTimer(): void {
    clearTimeout(timer)
    timer = undefined
  }
  function schedule(): void {
    clearTimer()
    attempting = false
    if (!pending || disposed) return
    if (!online()) {
      setPhase('offline')
      return
    }
    if (attempts >= 2) {
      pending = false
      setPhase('exhausted')
      return
    }
    setPhase('retrying')
    timer = setTimeout(
      () => {
        timer = undefined
        if (!online()) return schedule()
        attempts += 1
        attempting = true
        // Native play() can remain pending indefinitely when the connection stalls.
        timer = setTimeout(schedule, 12000)
        options.retry()
      },
      attempts === 0 ? 800 : 2000,
    )
  }
  function fail(): void {
    if (disposed) return
    if (pending) {
      if (attempting) schedule()
      return
    }
    pending = true
    schedule()
  }
  function settled(): void {
    clearTimer()
    pending = false
    attempting = false
    if (phase !== 'idle') setPhase('idle')
  }
  function cancel(): void {
    settled()
    attempts = 0
  }
  const connectionChanged = (): void => {
    if (pending) schedule()
  }
  window.addEventListener('online', connectionChanged)
  window.addEventListener('offline', connectionChanged)
  return {
    fail,
    settled,
    cancel,
    active: () => pending,
    dispose(): void {
      disposed = true
      clearTimer()
      window.removeEventListener('online', connectionChanged)
      window.removeEventListener('offline', connectionChanged)
    },
  }
}
