import { onBeforeUnmount, watch, type Ref } from 'vue'
import type { Track } from '../../core/types'
import { createListeningCounter, listeningTrackKey } from '../../core/playback/listening-stats'
import {
  clearListeningHistory,
  initializeListeningHistory,
  listeningHistoryGeneration,
  listeningStatsSummary,
  recordListening,
  saveListeningHistory,
} from './listening-history'

/** Counts the active media clock, independently of visual effects and debug settings. */
export function useListeningStats(options: {
  track: Ref<Track | null>
  players: readonly HTMLAudioElement[]
  getActiveAudio: () => HTMLAudioElement
  isPlaying: Ref<boolean>
}) {
  initializeListeningHistory()
  const counter = createListeningCounter()
  let track = options.track.value
  let active = options.getActiveAudio()
  let epoch = listeningHistoryGeneration()
  const stalled = new WeakSet<HTMLAudioElement>()
  function sample(event?: Event): void {
    const audio = options.getActiveAudio()
    if (event?.target && event.target !== audio) return
    const current = options.track.value
    const nextEpoch = listeningHistoryGeneration()
    if (
      active !== audio ||
      (track ? listeningTrackKey(track) : '') !== (current ? listeningTrackKey(current) : '') ||
      epoch !== nextEpoch
    ) {
      counter.reset()
      active = audio
      track = current
      epoch = nextEpoch
    }
    if (!track) return
    // `stalled` concerns network loading; already buffered audio may keep playing
    // and never emit another `playing`. Only `waiting` marks playback starvation.
    if (event?.type === 'waiting') stalled.add(audio)
    if (event?.type === 'playing') stalled.delete(audio)
    const added = counter.sample({
      timeSeconds: audio.currentTime,
      durationSeconds: audio.duration,
      playing:
        options.isPlaying.value &&
        !audio.paused &&
        !audio.ended &&
        !stalled.has(audio) &&
        audio.readyState >= 2,
      seeking: audio.seeking || event?.type === 'seeking' || event?.type === 'seeked',
      playbackRate: audio.playbackRate,
      nowMs: performance.now(),
    })
    recordListening(track, added.seconds, added.qualified)
    if (event?.type === 'ended') counter.reset()
    if (event?.type === 'pause' || event?.type === 'ended') saveListeningHistory(true)
  }
  const events = [
    'playing',
    'pause',
    'ended',
    'timeupdate',
    'seeking',
    'seeked',
    'ratechange',
    'waiting',
    'stalled',
  ] as const
  for (const audio of options.players)
    for (const event of events) audio.addEventListener(event, sample)
  const stop = watch(
    () => [options.track.value, options.isPlaying.value],
    () => sample(),
    { flush: 'sync' },
  )
  const timer = setInterval(sample, 1000)
  const save = (): void => {
    sample()
    saveListeningHistory(true)
  }
  window.addEventListener('pagehide', save)
  onBeforeUnmount(() => {
    save()
    stop()
    clearInterval(timer)
    window.removeEventListener('pagehide', save)
    for (const audio of options.players)
      for (const event of events) audio.removeEventListener(event, sample)
  })
  sample()
  return {
    stats: listeningStatsSummary,
    clear: clearListeningHistory,
    /** Explicit replay/previous-to-start intent; ordinary slider seeks do not reset a visit. */
    restartVisit: (): void => {
      counter.reset()
      sample()
    },
  }
}
