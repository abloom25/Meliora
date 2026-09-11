import { onBeforeUnmount, ref, type Ref } from 'vue'
import { loadTrackLyrics } from '../services/lyrics'
import { usePlayerStore } from '../stores/player'
import type { PlayerSettings, Track } from '../core/types'
import { PRELOAD_TIMEOUTS, CACHE_CONSTANTS } from '../../shared/constants'
import {
  createTrackFailureLog,
  predictPreloadTrack,
  type PreloadDirection,
} from '../core/audio/preload'
import type { QueueState } from '../core/audio/queue'
import type { AudioBackend, AudioChannel } from '../core/audio/backend'

export type { PreloadDirection }

const PRELOAD_READY_TIMEOUT = PRELOAD_TIMEOUTS.COVER
const COVER_PRELOAD_CACHE_LIMIT = CACHE_CONSTANTS.COVER_PRELOAD_LIMIT
const COVER_PRELOAD_CACHE_TTL = CACHE_CONSTANTS.COVER_PRELOAD_TTL

export interface PreloadSlot {
  /** 这一路预加载占用的播放通道。是稳定句柄,后端内部换实现不影响这里 */
  channel: AudioChannel
  direction: PreloadDirection
  ready: Promise<boolean> | null
  track: Track | null
  cleanup: (() => void) | null
}

const coverPreloadInflight = new Map<string, Promise<void>>()
const coverPreloadCache = new Map<string, number>()

function rememberPreloadedCover(url: string) {
  coverPreloadCache.delete(url)
  coverPreloadCache.set(url, Date.now())

  while (coverPreloadCache.size > COVER_PRELOAD_CACHE_LIMIT) {
    const oldestUrl = coverPreloadCache.keys().next().value
    if (!oldestUrl) break
    coverPreloadCache.delete(oldestUrl)
  }
}

function isCoverRecentlyPreloaded(url: string) {
  const cachedAt = coverPreloadCache.get(url)
  if (cachedAt === undefined) return false

  if (Date.now() - cachedAt > COVER_PRELOAD_CACHE_TTL) {
    coverPreloadCache.delete(url)
    return false
  }

  rememberPreloadedCover(url)
  return true
}

/** 解码一张封面。默认走浏览器的 Image;桌面端可以换成自己的图片预热 */
export type CoverDecoder = (url: string) => Promise<void>

const decodeViaImage: CoverDecoder = (url) => {
  const image = new Image()
  if (typeof image.decode === 'function') {
    image.src = url
    try {
      return image.decode()
    } catch (error) {
      return Promise.reject(error)
    }
  }
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('cover preload failed'))
  })
  image.src = url
  return loaded
}

let decodeCover: CoverDecoder = decodeViaImage

/** 替换封面解码方式。传 null 恢复为浏览器的 Image */
export function setCoverDecoder(decoder: CoverDecoder | null): void {
  decodeCover = decoder ?? decodeViaImage
}

export function preloadCover(url?: string): Promise<void> {
  if (!url) return Promise.resolve()
  if (isCoverRecentlyPreloaded(url)) return Promise.resolve()

  const pending = coverPreloadInflight.get(url)
  if (pending) return pending

  const ready = decodeCover(url)
    .then(() => {
      rememberPreloadedCover(url)
    })
    .catch(() => undefined)
    .finally(() => {
      coverPreloadInflight.delete(url)
    })
  coverPreloadInflight.set(url, ready)
  return ready
}

export async function preloadLyrics(track: Track) {
  try {
    await loadTrackLyrics(track)
  } catch {
    // Lyrics failure must not block audio playback.
  }
}

export interface PreloadPoolOptions {
  backend: AudioBackend
  store: ReturnType<typeof usePlayerStore>
  settings: Ref<PlayerSettings>

  transitionInProgress: () => boolean
}

export function usePreloadPool(options: PreloadPoolOptions) {
  const { backend, store, settings, transitionInProgress } = options
  const spares = backend.channels().slice(1)
  const preloadSlots: Record<PreloadDirection, PreloadSlot> = {
    previous: {
      channel: spares[0]!,
      direction: 'previous',
      ready: null,
      track: null,
      cleanup: null,
    },
    next: {
      channel: spares[1]!,
      direction: 'next',
      ready: null,
      track: null,
      cleanup: null,
    },
  }
  const preloadMessage = ref('')
  // 失败记录的 TTL 与放行规则在核心层,这里只是持有它
  const failureLog = createTrackFailureLog()
  const pendingPreloadTimeouts = new Set<number>()
  const isPoolUnmounted = ref(false)

  function markTrackFailed(id: string) {
    failureLog.mark(id)
  }

  function clearFailedTrack(id: string) {
    failureLog.clear(id)
  }

  function isTrackFailed(id: string): boolean {
    return failureLog.isFailed(id)
  }

  function queueState(): QueueState {
    return {
      queue: store.queue,
      currentIndex: store.currentIndex,
      playMode: store.settings.playMode,
    }
  }

  // 预测规则在核心层,与真正切歌时的选曲共用同一套,不会出现"预加载的和实际播的不是同一首"
  function predictTrack(direction: PreloadDirection, manual = false): Track | null {
    return predictPreloadTrack(queueState(), store.currentTrack?.id ?? null, direction, {
      manual,
      isFailed: isTrackFailed,
      cachedTrack: preloadSlots[direction].track,
    })
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
    slot.channel.release()
  }

  function slotCanStart(slot: PreloadSlot, track: Track) {
    return slot.track?.id === track.id && slot.channel.canStart()
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
    slot.channel.setGain(0)
    slot.ready = new Promise<boolean>((resolve) => {
      const timeout = window.setTimeout(() => {
        pendingPreloadTimeouts.delete(timeout)
        if (isPoolUnmounted.value) {
          cleanup()
          resolve(false)
          return
        }
        if (slot.track?.id === track.id) {
          // 超时未就绪:完整释放 slot(pause + 移除 src + load 中止下载),
          // 否则慢速响应的连接会一直挂着占用带宽。clearSlot 内部幂等调用 cleanup。
          clearSlot(slot)
        } else {
          cleanup()
        }
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
        markTrackFailed(track.id)
        preloadMessage.value = `预加载歌曲暂时无法播放，当前播放不受影响`
        slot.track = null
        slot.ready = null
        resolve(false)
        scheduleAdjacentPreload()
      }
      const stops = [
        slot.channel.on('canplay', handleReady),
        slot.channel.on('loadeddata', handleReady),
        slot.channel.on('error', handleError),
      ]
      const cleanup = () => {
        pendingPreloadTimeouts.delete(timeout)
        window.clearTimeout(timeout)
        for (const stop of stops) stop()
        slot.cleanup = null
      }
      slot.cleanup = cleanup
    })
    slot.channel.load(track.audioUrl)
    if (direction === 'next') {
      void preloadCover(track.cover)
    }
    void preloadLyrics(track)
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
    failureLog,
    markTrackFailed,
    clearFailedTrack,
    isTrackFailed,
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
