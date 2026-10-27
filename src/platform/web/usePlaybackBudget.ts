import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import {
  createFrameBudget,
  shouldConserveAudioBuffer,
  type PlaybackResourcePressure,
} from '../../core/playback/resource-budget'

export function usePlaybackBudget(options: {
  enabled?: Readonly<Ref<boolean>>
  playing: Ref<boolean>
  source: Readonly<Ref<string>>
  getActiveAudio: () => HTMLAudioElement
  subscribe: (listener: () => void) => () => void
}) {
  let frames = createFrameBudget()
  const enabled = computed(() => options.enabled?.value !== false)
  const level = ref(0)
  const buffering = ref(false)
  const hidden = ref(document.hidden)
  function refresh(): void {
    if (!enabled.value) return
    const audio = options.getActiveAudio()
    let ahead: number
    try {
      ahead =
        !audio.buffered.length && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
          ? Infinity
          : 0
      for (let index = 0; index < audio.buffered.length; index++) {
        if (
          audio.buffered.start(index) <= audio.currentTime + 0.05 &&
          audio.buffered.end(index) > audio.currentTime
        ) {
          ahead = (audio.buffered.end(index) - audio.currentTime) / (audio.playbackRate || 1)
          break
        }
      }
    } catch {
      ahead = Number.NaN
    }
    buffering.value = shouldConserveAudioBuffer({
      wasConstrained: buffering.value,
      playing: options.playing.value,
      waiting: !audio.ended && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
      bufferedSeconds: ahead,
      remainingSeconds: Number.isFinite(audio.duration)
        ? Math.max(0, (audio.duration - audio.currentTime) / (audio.playbackRate || 1))
        : Infinity,
    })
  }
  const stop = options.subscribe(refresh)
  watch(
    enabled,
    () => {
      frames = createFrameBudget()
      level.value = 0
      buffering.value = false
      refresh()
    },
    { flush: 'sync' },
  )
  watch(
    [options.playing, options.source],
    () => {
      frames.reset()
      refresh()
    },
    { flush: 'post' },
  )
  const visibility = (): void => {
    hidden.value = document.hidden
    frames.reset()
    refresh()
  }
  document.addEventListener('visibilitychange', visibility)
  onBeforeUnmount(() => {
    stop()
    document.removeEventListener('visibilitychange', visibility)
  })
  return {
    pressure: computed<PlaybackResourcePressure>(() =>
      !enabled.value
        ? 'normal'
        : buffering.value
          ? 'buffering'
          : level.value || hidden.value
            ? 'constrained'
            : 'normal',
    ),
    visualIntervalMs: computed(() =>
      !enabled.value ? 0 : level.value >= 2 ? 50 : level.value ? 1000 / 30 : 0,
    ),
    observeFrame(now: number): void {
      if (enabled.value && !hidden.value && options.playing.value) level.value = frames.sample(now)
    },
  }
}
