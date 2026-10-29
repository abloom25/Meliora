export interface PlaybackProgressSample {
  identity: string
  position: number
  ended: boolean
}

/** Observe actual progress even when a browser leaves play() pending without media events. */
export function createPlaybackWatchdog(options: {
  read: () => PlaybackProgressSample | null
  onStall: (reload: boolean) => void
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let previous: PlaybackProgressSample | null = null
  let sampledAt = 0
  let stationaryMs = 0
  let resumed = false
  let running = false
  function reset(): void {
    previous = null
    sampledAt = 0
    stationaryMs = 0
    resumed = false
  }
  function tick(): void {
    timer = undefined
    if (!running) return
    const now = performance.now()
    const sample = options.read()
    const elapsed = now - sampledAt
    if (!sample || sample.ended || !Number.isFinite(sample.position)) reset()
    else {
      if (
        !previous ||
        previous.identity !== sample.identity ||
        elapsed > 5000 ||
        elapsed < 0 ||
        Math.abs(sample.position - previous.position) > 0.01
      ) {
        stationaryMs = 0
        resumed = false
      } else stationaryMs += elapsed
      previous = { ...sample }
      sampledAt = now
      if (stationaryMs >= (resumed ? 6000 : 12000)) {
        stationaryMs = 0
        const reload = resumed
        resumed = true
        options.onStall(reload)
      }
    }
    if (running) timer = setTimeout(tick, 1000)
  }
  return {
    reset,
    start(): void {
      if (running) return
      running = true
      reset()
      tick()
    },
    stop(): void {
      running = false
      clearTimeout(timer)
      timer = undefined
      reset()
    },
  }
}
