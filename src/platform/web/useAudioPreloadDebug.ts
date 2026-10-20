import { onBeforeUnmount, readonly, shallowRef, watch, type Ref } from 'vue'
import type { AudioChannel } from '../../core/audio/backend'
import type { AudioPreloadDebug } from '../../core/analysis/player-debug'
import type { BeatTimeRange } from '../../core/analysis/beat-timeline'
import type { Track } from '../../core/types'

interface DebugAudioSlot {
  direction: 'previous' | 'next'
  channel: AudioChannel
  audio: HTMLAudioElement
  track: Track | null
  protected: boolean
}

const SAMPLE_INTERVAL_MS = 100
const MEDIA_EVENTS = [
  'progress',
  'loadedmetadata',
  'durationchange',
  'canplay',
  'emptied',
  'loadstart',
  'error',
  'pause',
  'playing',
] as const

function bufferedRanges(audio: HTMLAudioElement): BeatTimeRange[] {
  const ranges: BeatTimeRange[] = []
  try {
    // A media source may be cleared between two reads of its live TimeRanges.
    const buffered = audio.buffered
    for (let index = 0; index < Math.min(buffered.length, 64); index += 1) {
      const startSeconds = buffered.start(index)
      const endSeconds = buffered.end(index)
      if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && endSeconds > startSeconds)
        ranges.push({ startSeconds, endSeconds })
    }
  } catch {
    // Diagnostics must never interrupt a channel rotation or playback.
  }
  return ranges
}

function snapshot(slot: DebugAudioSlot): AudioPreloadDebug {
  const { channel, audio, track } = slot
  const hasSource = Boolean(channel.source())
  const failed = hasSource && (channel.failed() || Boolean(audio.error))
  const canStart = hasSource && channel.canStart()
  const duration = channel.duration()
  const currentTime = channel.currentTime()
  const error = failed
    ? ({ 1: '请求已中止', 2: '音频网络错误', 3: '音频解码失败', 4: '音频源不可用' }[
        audio.error?.code ?? 0
      ] ?? '音频加载失败')
    : null
  return {
    direction: slot.direction,
    channelId: channel.id,
    trackId: track?.id ?? null,
    title: track?.title ?? null,
    artist: track?.artist ?? null,
    phase: slot.protected
      ? 'protected'
      : !track || !hasSource
        ? 'empty'
        : failed
          ? 'error'
          : canStart
            ? 'ready'
            : 'loading',
    currentTimeSeconds: Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0,
    durationSeconds:
      duration !== null && Number.isFinite(duration) && duration > 0 ? duration : null,
    canStart,
    failed,
    bufferedRanges: hasSource ? bufferedRanges(audio) : [],
    readyState: audio.readyState,
    networkState: audio.networkState,
    error,
  }
}

/** Observes existing media elements without fetching, playing, or predicting tracks. */
export function useAudioPreloadDebug(options: {
  enabled: Readonly<Ref<boolean>>
  getSlots: () => readonly DebugAudioSlot[]
  getElements: () => readonly HTMLAudioElement[]
}) {
  const state = shallowRef<readonly AudioPreloadDebug[]>([])
  const observed = new Set<HTMLAudioElement>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastRead = -Infinity
  let disposed = false

  function cancelPending(): void {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function synchronizeElements(): void {
    const current = new Set(options.getElements())
    for (const audio of observed) {
      if (current.has(audio)) continue
      for (const event of MEDIA_EVENTS) audio.removeEventListener(event, refresh)
      observed.delete(audio)
    }
    for (const audio of current) {
      if (observed.has(audio)) continue
      for (const event of MEDIA_EVENTS) audio.addEventListener(event, refresh)
      observed.add(audio)
    }
  }

  function read(): void {
    cancelPending()
    if (disposed || !options.enabled.value || document.hidden) return
    synchronizeElements()
    state.value = options.getSlots().map(snapshot)
    lastRead = performance.now()
  }

  function refresh(): void {
    if (disposed || !options.enabled.value || document.hidden) return
    const remaining = SAMPLE_INTERVAL_MS - (performance.now() - lastRead)
    if (remaining <= 0) read()
    else if (timer === null) timer = setTimeout(read, remaining)
  }

  function visibilityChanged(): void {
    if (document.hidden) cancelPending()
    else read()
  }

  function detach(): void {
    cancelPending()
    for (const audio of observed)
      for (const event of MEDIA_EVENTS) audio.removeEventListener(event, refresh)
    observed.clear()
    document.removeEventListener('visibilitychange', visibilityChanged)
    lastRead = -Infinity
  }

  watch(
    options.enabled,
    (enabled) => {
      detach()
      if (enabled) {
        document.addEventListener('visibilitychange', visibilityChanged)
        read()
      } else state.value = []
    },
    { immediate: true, flush: 'sync' },
  )

  onBeforeUnmount(() => {
    disposed = true
    detach()
  })

  return { state: readonly(state), refresh }
}
