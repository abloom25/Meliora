import { onBeforeUnmount, ref, type Ref } from 'vue'
import { loadLyricsText } from '../services/lyrics'
import { usePlayerStore } from '../stores/player'
import type { PlayerSettings, Track } from '../types/music'

const PRELOAD_READY_TIMEOUT = 9000
export type PreloadDirection = 'previous' | 'next'

export interface PreloadSlot {
  audio: HTMLAudioElement
  direction: PreloadDirection
  ready: Promise<boolean> | null
  track: Track | null
  cleanup: (() => void) | null
}

export function preloadCover(url?: string) {
  if (!url) return Promise.resolve()
  const image = new Image()
  image.src = url
  return image.decode?.().catch(() => undefined) ?? Promise.resolve()
}

export async function preloadLyrics(url?: string) {
  if (!url) return
  try {
    await loadLyricsText(url)
  } catch {
    // Lyrics failure must not block audio playback.
  }
}

export interface PreloadPoolOptions {
  players: readonly HTMLAudioElement[]
  store: ReturnType<typeof usePlayerStore>
  settings: Ref<PlayerSettings>
  getActiveAudio: () => HTMLAudioElement
  transitionInProgress: () => boolean
}

export function usePreloadPool(options: PreloadPoolOptions) {
  const { players, store, settings, transitionInProgress } = options
  const preloadSlots: Record<PreloadDirection, PreloadSlot> = {
    previous: {
      audio: players[1],
      direction: 'previous',
      ready: null,
      track: null,
      cleanup: null,
    },
    next: {
      audio: players[2],
      direction: 'next',
      ready: null,
      track: null,
      cleanup: null,
    },
  }
  const preloadMessage = ref('')
  const failedTrackIds = new Set<string>()
  const pendingPreloadTimeouts = new Set<number>()
  const isPoolUnmounted = ref(false)

  function findCachedTrack(direction: PreloadDirection): Track | null {
    const track = preloadSlots[direction].track
    if (!track || track.id === store.currentTrack?.id || failedTrackIds.has(track.id)) return null
    return track
  }

  function predictTrack(direction: PreloadDirection, manual = false): Track | null {
    const queue = store.queue
    if (!queue.length) return null

    // 优先复用已缓存的预加载槽（命中时无需重新预测）
    const cachedTrack = findCachedTrack(direction)
    if (cachedTrack) return cachedTrack

    // 单一真相源：统一走 store.peekNext/peekPrevious，消除 shuffle 双抽样不一致
    const predicted = direction === 'next' ? store.peekNext(manual) : store.peekPrevious()
    if (!predicted) return null
    if (failedTrackIds.has(predicted.id)) return null
    return predicted
  }

  function predictNextTrack(manual = false): Track | null {
    return predictTrack('next', manual)
  }

  function predictPreviousTrack(): Track | null {
    return predictTrack('previous', true)
  }

  function clearSlot(slot: PreloadSlot) {
    if (slot.cleanup) {
      slot.cleanup()
      slot.cleanup = null
    }
    slot.track = null
    slot.ready = null
    slot.audio.pause()
    slot.audio.removeAttribute('src')
    slot.audio.load()
  }

  function slotCanStart(slot: PreloadSlot, track: Track) {
    return (
      slot.track?.id === track.id &&
      slot.audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      !slot.audio.error
    )
  }

  function clearPreloads() {
    clearSlot(preloadSlots.previous)
    clearSlot(preloadSlots.next)
  }

  function clearPreloadMessage() {
    preloadMessage.value = ''
  }

  function findSlotByTrack(track: Track): PreloadSlot | null {
    return Object.values(preloadSlots).find((slot) => slot.track?.id === track.id) ?? null
  }

  function loadSlot(direction: PreloadDirection, track: Track): Promise<boolean> {
    // 卸载后不再发起新的预加载，避免定时器或事件监听器泄漏。
    if (isPoolUnmounted.value) return Promise.resolve(false)
    const slot = preloadSlots[direction]
    if (slot.track?.id === track.id && slot.ready) return slot.ready

    const duplicateSlot = findSlotByTrack(track)
    if (duplicateSlot && duplicateSlot !== slot) clearSlot(duplicateSlot)

    clearSlot(slot)
    slot.track = track
    slot.audio.volume = 0
    slot.ready = new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingPreloadTimeouts.delete(timeout)
        if (isPoolUnmounted.value) {
          cleanup()
          resolve(false)
          return
        }
        if (slot.track?.id === track.id) {
          slot.track = null
          slot.ready = null
        }
        cleanup()
        resolve(false)
      }, PRELOAD_READY_TIMEOUT)
      pendingPreloadTimeouts.add(timeout)
      const handleReady = () => {
        if (isPoolUnmounted.value || slot.track?.id !== track.id) return
        cleanup()
        resolve(true)
      }
      const handleError = () => {
        if (isPoolUnmounted.value || slot.track?.id !== track.id) return
        cleanup()
        failedTrackIds.add(track.id)
        preloadMessage.value = `预加载歌曲暂时无法播放，当前播放不受影响`
        slot.track = null
        slot.ready = null
        resolve(false)
        scheduleAdjacentPreload()
      }
      const cleanup = () => {
        pendingPreloadTimeouts.delete(timeout)
        window.clearTimeout(timeout)
        slot.audio.removeEventListener('canplay', handleReady)
        slot.audio.removeEventListener('loadeddata', handleReady)
        slot.audio.removeEventListener('error', handleError)
        slot.cleanup = null
      }
      slot.cleanup = cleanup
      slot.audio.addEventListener('canplay', handleReady, { once: true })
      slot.audio.addEventListener('loadeddata', handleReady, { once: true })
      slot.audio.addEventListener('error', handleError, { once: true })
    })
    slot.audio.src = track.audioUrl
    slot.audio.load()
    if (direction === 'next') {
      void preloadCover(track.cover)
    }
    void preloadLyrics(track.lyricsUrl)
    return slot.ready
  }

  function preloadAdjacentTracks() {
    if (!settings.value.preloadNextTrack || transitionInProgress()) return
    const previousTrack = predictPreviousTrack()
    const nextTrack = predictNextTrack()
    if (previousTrack && previousTrack.id !== store.currentTrack?.id) {
      void loadSlot('previous', previousTrack)
    } else {
      clearSlot(preloadSlots.previous)
    }
    if (nextTrack && nextTrack.id !== store.currentTrack?.id) {
      void loadSlot('next', nextTrack)
    } else {
      clearSlot(preloadSlots.next)
    }
  }

  let scheduledHandle = 0

  function scheduleAdjacentPreload() {
    if (scheduledHandle) return
    scheduledHandle = window.setTimeout(() => {
      scheduledHandle = 0
      preloadAdjacentTracks()
    }, 0)
  }

  onBeforeUnmount(() => {
    isPoolUnmounted.value = true
    if (scheduledHandle) {
      window.clearTimeout(scheduledHandle)
      scheduledHandle = 0
    }
    // 清理所有挂起的预加载超时定时器，避免卸载后触发状态变更。
    if (pendingPreloadTimeouts.size) {
      for (const timeout of pendingPreloadTimeouts) window.clearTimeout(timeout)
      pendingPreloadTimeouts.clear()
    }
    clearPreloads()
  })

  return {
    preloadSlots,
    preloadMessage,
    failedTrackIds,
    predictNextTrack,
    predictPreviousTrack,
    clearPreloads,
    clearSlot,
    clearPreloadMessage,
    findSlotByTrack,
    slotCanStart,
    loadSlot,
    preloadAdjacentTracks,
    scheduleAdjacentPreload,
  }
}
