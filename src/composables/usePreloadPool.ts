import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { loadTrackLyrics } from '../services/lyrics'
import { usePlayerStore } from '../stores/player'
import type { PlayerSettings, Track } from '../core/types'
import { PRELOAD_TIMEOUTS, CACHE_CONSTANTS } from '../../shared/constants'
import { createTrackFailureLog, type PreloadDirection } from '../core/audio/preload'
import type { AudioBackend, AudioChannel } from '../core/audio/backend'
import type { BeatPreloadTarget } from '../core/analysis/beat-timeline'
import { LruCache } from '../core/util/lru-cache'
import type { PlaybackResourcePressure } from '../core/playback/resource-budget'

export type { PreloadDirection }

const PRELOAD_READY_TIMEOUT = PRELOAD_TIMEOUTS.COVER
const COVER_PRELOAD_CACHE_LIMIT = CACHE_CONSTANTS.COVER_PRELOAD_LIMIT
const COVER_PRELOAD_CACHE_TTL = CACHE_CONSTANTS.COVER_PRELOAD_TTL
const COVER_PRELOAD_CONCURRENCY = 4

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
export type CoverDecoder = (url: string, signal?: AbortSignal) => Promise<void>

const decodeViaImage: CoverDecoder = (url, signal) =>
  new Promise<void>((resolve, reject) => {
    const image = new Image()
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      image.onload = image.onerror = null
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve()
    }
    const abort = (): void => {
      image.removeAttribute('src')
      finish(new DOMException('Cover preload cancelled', 'AbortError'))
    }
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    image.onerror = () => finish(new Error('cover preload failed'))
    try {
      if (typeof image.decode === 'function') {
        image.src = url
        void image.decode().then(() => finish(), finish)
      } else {
        image.onload = () => finish()
        image.src = url
      }
    } catch (error) {
      finish(error)
    }
  })

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
  // Optional warming must never build an unbounded queue during rapid switching.
  if (coverPreloadInflight.size >= COVER_PRELOAD_CONCURRENCY) return Promise.resolve()
  const controller = new AbortController()
  const ready = new Promise<void>((resolve) => {
    let settled = false
    const finish = (success: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (success) rememberPreloadedCover(url)
      else controller.abort()
      resolve()
    }
    const timer = setTimeout(() => finish(false), PRELOAD_TIMEOUTS.COVER)
    try {
      void decodeCover(url, controller.signal).then(
        () => finish(true),
        () => finish(false),
      )
    } catch {
      finish(false)
    }
  }).finally(() => {
    coverPreloadInflight.delete(url)
  })
  coverPreloadInflight.set(url, ready)
  return ready
}

export async function preloadLyrics(track: Track, signal?: AbortSignal) {
  try {
    await loadTrackLyrics(track, signal ?? new AbortController().signal, undefined, 'background')
  } catch {
    // Lyrics failure must not block audio playback.
  }
}

export interface PreloadPoolOptions {
  backend: AudioBackend
  store: ReturnType<typeof usePlayerStore>
  settings: Ref<PlayerSettings>
  resourcePressure?: Readonly<Ref<PlaybackResourcePressure>>

  transitionInProgress: () => boolean
  isChannelProtected?: (channel: AudioChannel) => boolean
  /** Publishes the actual loaded slots; consumers must not predict shuffle again. */
  onTargetsChanged?: (targets: readonly BeatPreloadTarget[]) => void
}

export function usePreloadPool(options: PreloadPoolOptions) {
  const { backend, store, settings, transitionInProgress } = options
  const spares = backend.channels().slice(1)
  const [previousChannel, nextChannel] = spares
  // 契约要求后端至少给三路。给不够就在装配时当场报错,
  // 别拖到第一次预加载才在 undefined 上解引用 —— 那时候已经看不出是后端的问题了
  if (!previousChannel || !nextChannel) {
    throw new Error('usePreloadPool 需要后端提供至少 3 路通道:1 路出声 + 2 路预加载')
  }
  const preloadSlots: Record<PreloadDirection, PreloadSlot> = {
    previous: {
      channel: previousChannel,
      direction: 'previous',
      ready: null,
      track: null,
      cleanup: null,
    },
    next: {
      channel: nextChannel,
      direction: 'next',
      ready: null,
      track: null,
      cleanup: null,
    },
  }
  const preloadMessage = ref('')
  // 失败记录的 TTL 与放行规则在核心层,这里只是持有它
  const failureLog = createTrackFailureLog()
  const failedSources = new Map<string, string>()
  const transientFailures = new LruCache<string, { source: string; until: number }>(16)
  const pendingPreloadTimeouts = new Set<number>()
  const lyricPreloads = new Map<PreloadSlot, AbortController>()
  const suspendedLyrics = new Set<PreloadSlot>()
  const lyricHandoffs = new Set<AbortController>()
  const isPoolUnmounted = ref(false)
  let publishedTargets: readonly BeatPreloadTarget[] = []

  function refreshTargets(): void {
    const targets: BeatPreloadTarget[] = []
    const sources = new Set<string>()
    if (!isPoolUnmounted.value && settings.value.preloadNextTrack) {
      for (const direction of ['next', 'previous'] as const) {
        const { track, channel } = preloadSlots[direction]
        if (
          !track ||
          channel === backend.active() ||
          options.isChannelProtected?.(channel) ||
          channel.failed() ||
          isTrackFailed(track.id) ||
          track.audioUrl === store.currentTrack?.audioUrl ||
          sources.has(track.audioUrl) ||
          !store.queue.some(
            (candidate) => candidate.id === track.id && candidate.audioUrl === track.audioUrl,
          )
        )
          continue
        // AudioChannel returns the resolved media URL; keep the track's original
        // source as the analysis key so promotion reuses the active-song cache.
        try {
          if (channel.source() !== new URL(track.audioUrl, window.location.href).href) continue
        } catch {
          continue
        }
        const durationSeconds = channel.duration()
        targets.push({
          direction,
          source: track.audioUrl,
          title: track.title,
          ...(durationSeconds !== null ? { durationSeconds } : {}),
        })
        sources.add(track.audioUrl)
      }
    }
    if (
      targets.length === publishedTargets.length &&
      targets.every((target, index) => {
        const previous = publishedTargets[index]
        return (
          previous?.direction === target.direction &&
          previous.source === target.source &&
          previous.title === target.title &&
          previous.durationSeconds === target.durationSeconds
        )
      })
    )
      return
    publishedTargets = targets
    options.onTargetsChanged?.(targets)
  }

  function markTrackFailed(id: string) {
    failureLog.mark(id)
    const source = store.tracks.find((track) => track.id === id)?.audioUrl
    if (source !== undefined) failedSources.set(id, source)
    refreshTargets()
  }

  function clearFailedTrack(id: string) {
    failureLog.clear(id)
    failedSources.delete(id)
    refreshTargets()
  }

  function isTrackFailed(id: string): boolean {
    if (!failureLog.isFailed(id)) {
      failedSources.delete(id)
      return false
    }
    const failedSource = failedSources.get(id)
    if (
      failedSource !== undefined &&
      store.tracks.find((track) => track.id === id)?.audioUrl !== failedSource
    ) {
      failureLog.clear(id)
      failedSources.delete(id)
      return false
    }
    return true
  }

  // 预测规则在核心层,与真正切歌时的选曲共用同一套,不会出现"预加载的和实际播的不是同一首"
  function predictTrack(direction: PreloadDirection, manual = false): Track | null {
    return direction === 'next'
      ? store.peekNext(manual, isTrackFailed)
      : store.peekPrevious(isTrackFailed)
  }

  function predictNextTrack(manual = false): Track | null {
    return predictTrack('next', manual)
  }

  function predictPreviousTrack(): Track | null {
    return predictTrack('previous', true)
  }

  function cancelSlotLyrics(slot: PreloadSlot): void {
    lyricPreloads.get(slot)?.abort()
    lyricPreloads.delete(slot)
  }

  function startSlotLyrics(slot: PreloadSlot, track: Track): void {
    suspendedLyrics.delete(slot)
    cancelSlotLyrics(slot)
    const controller = new AbortController()
    lyricPreloads.set(slot, controller)
    void preloadLyrics(track, controller.signal).finally(() => {
      if (lyricPreloads.get(slot) === controller) lyricPreloads.delete(slot)
    })
  }

  /** Transfer ownership when audio handles rotate. Release incoming after foreground watchers attach. */
  function transferLyricsForPromotion(slot: PreloadSlot, reverseSlot: PreloadSlot): () => void {
    suspendedLyrics.delete(slot)
    suspendedLyrics.delete(reverseSlot)
    const incoming = lyricPreloads.get(slot)
    lyricPreloads.delete(slot)
    if (incoming) lyricHandoffs.add(incoming)
    cancelSlotLyrics(reverseSlot)
    if (
      !isPoolUnmounted.value &&
      settings.value.preloadNextTrack &&
      reverseSlot.track &&
      options.resourcePressure?.value !== 'buffering'
    )
      startSlotLyrics(reverseSlot, reverseSlot.track)
    return () => {
      if (!incoming) return
      lyricHandoffs.delete(incoming)
      incoming.abort()
    }
  }

  function clearSlot(slot: PreloadSlot, publish = true) {
    suspendedLyrics.delete(slot)
    cancelSlotLyrics(slot)
    if (slot.cleanup) {
      slot.cleanup()
      slot.cleanup = null
    }
    slot.track = null
    slot.ready = null
    // 已移出队列的缓存立即作废，但退休通道在切歌完成前仍需保留音频供回退。
    if (!options.isChannelProtected?.(slot.channel)) slot.channel.release()
    if (publish) refreshTargets()
  }

  function slotCanStart(slot: PreloadSlot, track: Track) {
    return (
      slot.track?.id === track.id &&
      slot.track.audioUrl === track.audioUrl &&
      slot.channel.canStart()
    )
  }

  function clearPreloads() {
    clearSlot(preloadSlots.previous, false)
    clearSlot(preloadSlots.next, false)
    refreshTargets()
  }

  /**
   * 清空两路预加载,并把它们的通道还原成装配时的划分。
   *
   * 出声通道被强行拨回 channels[0] 时(找不到当前曲目而停止播放)必须走这里:
   * 切过歌之后三路会轮转,某个槽手里可能正拿着 channels[0]。不还原的话
   * "出声通道与两个槽互不相同"这条前提就破了,随后一次 loadSlot 会 release 掉
   * 正在出声的那一路,再把别的歌以零增益加载进去 —— 按播放没声音或放错歌。
   */
  function resetSlotChannels() {
    clearPreloads()
    preloadSlots.previous.channel = previousChannel
    preloadSlots.next.channel = nextChannel
    refreshTargets()
  }

  function clearPreloadMessage() {
    preloadMessage.value = ''
  }

  function findSlotByTrack(track: Track): PreloadSlot | null {
    return (
      Object.values(preloadSlots).find(
        (slot) => slot.track?.id === track.id && slot.track.audioUrl === track.audioUrl,
      ) ?? null
    )
  }

  function loadSlot(direction: PreloadDirection, track: Track): Promise<boolean> {
    // 卸载后不再发起新的预加载，避免定时器或事件监听器泄漏。
    if (isPoolUnmounted.value) return Promise.resolve(false)
    const slot = preloadSlots[direction]
    if (options.isChannelProtected?.(slot.channel)) return Promise.resolve(false)
    if (slot.track?.id === track.id && slot.track.audioUrl === track.audioUrl && slot.ready) {
      if (suspendedLyrics.delete(slot)) startSlotLyrics(slot, track)
      return slot.ready
    }

    const duplicateSlot = findSlotByTrack(track)
    if (duplicateSlot && duplicateSlot !== slot) {
      if (options.isChannelProtected?.(duplicateSlot.channel)) return Promise.resolve(false)
      clearSlot(duplicateSlot)
    }

    clearSlot(slot)
    slot.track = track
    slot.channel.setGain(0)
    const channel = slot.channel
    const ready = new Promise<boolean>((resolve) => {
      let settled = false
      const stops: Array<() => void> = []
      const finish = (result: boolean) => {
        if (settled) return
        settled = true
        pendingPreloadTimeouts.delete(timeout)
        window.clearTimeout(timeout)
        for (const stop of stops) stop()
        if (slot.cleanup === cancel) slot.cleanup = null
        resolve(result)
      }
      const cancel = () => finish(false)
      const ownsSlot = () => slot.channel === channel && slot.track === track && !settled
      const timeout = window.setTimeout(() => {
        if (!ownsSlot()) return finish(false)
        transientFailures.set(track.id, { source: track.audioUrl, until: Date.now() + 15000 })
        finish(false)
        clearSlot(slot)
      }, PRELOAD_READY_TIMEOUT)
      pendingPreloadTimeouts.add(timeout)
      const handleReady = () => {
        if (isPoolUnmounted.value || !ownsSlot()) return
        finish(true)
        scheduleAdjacentPreload()
      }
      stops.push(channel.on('canplay', handleReady), channel.on('loadeddata', handleReady))
      slot.cleanup = cancel
    })
    slot.ready = ready
    channel.setPreload('auto')
    channel.load(track.audioUrl)
    refreshTargets()
    if (direction === 'next') {
      void preloadCover(track.cover)
    }
    startSlotLyrics(slot, track)
    return ready
  }

  function preloadAdjacentTracks() {
    if (!settings.value.preloadNextTrack || transitionInProgress() || navigator.onLine === false)
      return
    const pressure = options.resourcePressure?.value ?? 'normal'
    if (pressure === 'buffering') {
      for (const slot of Object.values(preloadSlots)) {
        if (slot.channel === backend.active() || options.isChannelProtected?.(slot.channel))
          continue
        if (lyricPreloads.has(slot)) suspendedLyrics.add(slot)
        cancelSlotLyrics(slot)
        // An unfinished speculative request must give the active song its connection back.
        if (slot.track && !slot.channel.canStart()) clearSlot(slot)
        else slot.channel.setPreload('none')
      }
      return
    }
    const previousTrack = predictPreviousTrack()
    const nextTrack = predictNextTrack()
    const sameNeighbor =
      previousTrack?.id === nextTrack?.id && previousTrack?.audioUrl === nextTrack?.audioUrl
    if (nextTrack && nextTrack.id !== store.currentTrack?.id && canWarm(nextTrack)) {
      void loadSlot('next', nextTrack)
      preloadSlots.next.channel.setPreload('auto')
    }
    const canLoadPrevious =
      pressure === 'normal' &&
      (!options.resourcePressure ||
        !nextTrack ||
        nextTrack.id === store.currentTrack?.id ||
        slotCanStart(preloadSlots.next, nextTrack))
    // In a two-song queue both directions name the same song. Keep it in the
    // next slot instead of releasing and loading it twice on each refresh.
    if (previousTrack && previousTrack.id !== store.currentTrack?.id && !sameNeighbor) {
      if (canLoadPrevious && canWarm(previousTrack)) void loadSlot('previous', previousTrack)
      else if (!options.isChannelProtected?.(preloadSlots.previous.channel)) {
        if (lyricPreloads.has(preloadSlots.previous)) suspendedLyrics.add(preloadSlots.previous)
        cancelSlotLyrics(preloadSlots.previous)
        if (!preloadSlots.previous.channel.canStart()) clearSlot(preloadSlots.previous)
        else preloadSlots.previous.channel.setPreload('none')
      }
    } else {
      clearSlot(preloadSlots.previous)
    }
    if (!nextTrack || nextTrack.id === store.currentTrack?.id) {
      clearSlot(preloadSlots.next)
    }
  }

  let scheduledHandle = 0

  function canWarm(track: Track): boolean {
    const failed = transientFailures.get(track.id)
    return !failed || failed.source !== track.audioUrl || Date.now() >= failed.until
  }

  function scheduleAdjacentPreload() {
    if (isPoolUnmounted.value) return
    if (scheduledHandle) return
    scheduledHandle = window.setTimeout(() => {
      scheduledHandle = 0
      preloadAdjacentTracks()
    }, 0)
  }

  // Slot ownership changes as channels rotate. Subscribe to stable handles and
  // resolve their current slot at event time, including errors after canplay.
  const stopTargetListeners = backend.channels().flatMap((channel) => [
    ...(['loadedmetadata', 'durationchange', 'canplay', 'loadeddata'] as const).map((event) =>
      channel.on(event, refreshTargets),
    ),
    channel.on('error', () => {
      if (
        isPoolUnmounted.value ||
        channel === backend.active() ||
        options.isChannelProtected?.(channel)
      )
        return
      const slot = Object.values(preloadSlots).find(
        (candidate) => candidate.channel === channel && candidate.track,
      )
      if (!slot?.track) return
      const reason = channel.classifyFailure(new Error('preload failed'))
      if (
        navigator.onLine === false ||
        reason === 'network' ||
        reason === 'not-allowed' ||
        reason === 'aborted'
      ) {
        // An optional download failing says nothing about whether the song is playable.
        transientFailures.set(slot.track.id, {
          source: slot.track.audioUrl,
          until: Date.now() + 15000,
        })
      } else markTrackFailed(slot.track.id)
      preloadMessage.value = '预加载歌曲暂时无法播放，当前播放不受影响'
      clearSlot(slot)
      scheduleAdjacentPreload()
    }),
  ])
  watch(() => settings.value.preloadNextTrack, refreshTargets, { flush: 'sync' })
  if (options.resourcePressure) watch(options.resourcePressure, scheduleAdjacentPreload)
  const reconnect = (): void => {
    transientFailures.clear()
    scheduleAdjacentPreload()
  }
  window.addEventListener('online', reconnect)

  onBeforeUnmount(() => {
    isPoolUnmounted.value = true
    window.removeEventListener('online', reconnect)
    for (const stop of stopTargetListeners) stop()
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
    for (const controller of lyricHandoffs) controller.abort()
    lyricHandoffs.clear()
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
    resetSlotChannels,
    clearSlot,
    transferLyricsForPromotion,
    clearPreloadMessage,
    findSlotByTrack,
    slotCanStart,
    loadSlot,
    preloadAdjacentTracks,
    scheduleAdjacentPreload,
    refreshTargets,
  }
}
