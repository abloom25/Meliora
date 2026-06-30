import { onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePlayerStore } from '../stores/player'
import type { Track } from '../types/music'
import { useBeatAnalyser } from './useBeatAnalyser'
import { useEqualizer } from './useEqualizer'
import {
  usePreloadPool,
  preloadCover,
  preloadLyrics,
  type PreloadDirection,
  type PreloadSlot,
} from './usePreloadPool'

const CROSSFADE_DURATION = 650
const FADE_OUT_DURATION = 180
const FADE_IN_DURATION = 360
const MEDIA_ERR_NETWORK = 2
const MEDIA_ERR_DECODE = 3
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4

function createAudio(
  preload: HTMLMediaElement['preload'],
  crossOrigin: 'anonymous' | undefined = 'anonymous',
) {
  const audio = new Audio()
  audio.preload = preload
  if (crossOrigin) audio.crossOrigin = crossOrigin
  return audio
}

type PlayerState = 'idle' | 'switching'

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export interface UseAudioPlayerOptions {
  /**
   * 可选：返回需要每帧同步 `--beat-level` CSS 变量的目标节点列表。
   * 仅作为透传给 useBeatAnalyser 的 getBeatTargets。
   */
  getBeatTargets?: () => readonly (HTMLElement | null | undefined)[]
}

export function useAudioPlayer(options: UseAudioPlayerOptions = {}) {
  const store = usePlayerStore()
  const { currentTrack, isPlaying, currentTime, duration, settings } = storeToRefs(store)
  const players: HTMLAudioElement[] = [
    createAudio('metadata'),
    createAudio('auto'),
    createAudio('auto'),
  ]
  let activeAudio = players[0]
  const playerState = ref<PlayerState>('idle')
  let automaticCrossfadeStarted = false
  // 按 audio 元素独立的动画通道:每个元素持有自己的 animationId,
  // 同一元素上后启动的动画会取消前一个(同一声道不应同时跑两个 fade),
  // 但不同元素之间互不干扰 —— 旧元素的 fade-out 不会被新元素的 fade-in 取消,
  // 修复手动切歌时旧音频未及时衰减导致的叠放。
  // 计数器从 1 起,0 表示"无动画/已 invalidate"。
  const gainAnimations = new WeakMap<HTMLAudioElement, number>()
  let switchAbortController: AbortController | null = null
  const pendingPlayerTimeouts = new Set<number>()
  // 当 active audio 还没有有效 duration 时，记录用户请求的 seek 时间，
  // 等到 durationchange / loadedmetadata 后再真正写入 audio.currentTime。
  const pendingSeekTime = ref<number | null>(null)
  let beatAnalysisDegraded = false
  let degradationWarned = false
  // 前向声明：onTainted 回调需在 usePreloadPool 之后才能绑定（依赖 preloadSlots）。
  let taintedHandler: ((audio: HTMLAudioElement) => void) | null = null

  function createSwitchAbort(): AbortController {
    switchAbortController?.abort()
    const controller = new AbortController()
    switchAbortController = controller
    return controller
  }

  function isSwitchAborted(controller: AbortController): boolean {
    return controller.signal.aborted || switchAbortController !== controller
  }

  function schedulePlayerTimeout(callback: () => void, delay: number): number {
    const handle = window.setTimeout(() => {
      pendingPlayerTimeouts.delete(handle)
      callback()
    }, delay)
    pendingPlayerTimeouts.add(handle)
    return handle
  }

  const { bindFilters: bindEqFilters } = useEqualizer({ settings })
  const { beatLevel, spectrumLevels, startBeatAnalysis, stopBeatAnalysis } = useBeatAnalyser({
    players,
    getActiveAudio: () => activeAudio,
    isPlaying,
    getBeatTargets: options.getBeatTargets,
    onEqFiltersReady: bindEqFilters,
    onTainted: (audio) => taintedHandler?.(audio),
  })

  const {
    preloadSlots,
    preloadMessage,
    failedTrackIds,
    predictNextTrack,
    clearPreloads,
    clearSlot,
    clearPreloadMessage,
    findSlotByTrack,
    slotCanStart,
    loadSlot,
    scheduleAdjacentPreload,
  } = usePreloadPool({
    players,
    store,
    settings,
    getActiveAudio: () => activeAudio,
    transitionInProgress: () => playerState.value !== 'idle',
  })

  // 收尾被 tainted 重建替换下来的旧 audio:移除其事件监听、停止播放并清空 src,
  // 避免新旧元素同时播放同一源(双重播放)以及元素/网络流泄漏。
  function teardownReplacedAudio(audio: HTMLAudioElement) {
    for (let i = audioListeners.length - 1; i >= 0; i -= 1) {
      const entry = audioListeners[i]
      if (entry.audio === audio) {
        audio.removeEventListener(entry.type, entry.listener)
        audioListeners.splice(i, 1)
      }
    }
    cancelGainAnimation(audio)
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }

  function rebuildAudioWithoutCors(audio: HTMLAudioElement): HTMLAudioElement {
    const wasActive = audio === activeAudio
    const preload = audio.preload
    const currentTime = audio.currentTime
    const wasPaused = audio.paused
    const currentSrc = audio.currentSrc || audio.src

    // 创建无 crossOrigin 的新 audio，牺牲节拍分析保播放
    const newAudio = createAudio(preload, undefined)

    if (wasActive) {
      setPlayerVolume(newAudio, audioGain(audio))
      activeAudio = newAudio
      // 等 metadata 就绪后 seek 到原位置，避免降级后播放进度回 0
      const onLoadedMetadata = () => {
        if (Number.isFinite(currentTime) && currentTime > 0) {
          try {
            newAudio.currentTime = currentTime
          } catch {
            // seek 失败忽略
          }
        }
        if (!wasPaused) {
          void newAudio.play().catch(() => {
            // 播放失败忽略，至少保证元素就位
          })
        }
        newAudio.removeEventListener('loadedmetadata', onLoadedMetadata)
      }
      newAudio.addEventListener('loadedmetadata', onLoadedMetadata)
    }

    if (currentSrc) {
      newAudio.src = currentSrc
      newAudio.load()
    }

    return newAudio
  }

  function degradeBeatAnalysis() {
    if (beatAnalysisDegraded) return
    beatAnalysisDegraded = true
    if (!degradationWarned) {
      console.warn(
        '[useAudioPlayer] 音频源不支持 CORS,节拍分析已降级(播放不受影响)',
        activeAudio.currentSrc || activeAudio.src,
      )
      degradationWarned = true
    }
    stopBeatAnalysis()
  }

  taintedHandler = (audio) => {
    const rebuilt = rebuildAudioWithoutCors(audio)
    const index = players.indexOf(audio)
    if (index >= 0) players[index] = rebuilt
    // 重建后的 audio 需要重新绑定事件监听器
    bindAudioEventListeners(rebuilt)

    // 若被重建的是预加载 slot 的 audio,旧元素上的 canplay/error 就绪监听
    // (由 usePreloadPool.loadSlot 注册)已随旧元素失效,slot 只能靠 9s 超时 resolve。
    // 这里清掉旧 slot 状态并把引用切到新元素,随后重新调度预加载,
    // 让 loadSlot 在新元素上重新注册就绪监听,恢复 preload 命中率。
    let slotDirection: PreloadDirection | null = null
    if (preloadSlots.previous.audio === audio) slotDirection = 'previous'
    else if (preloadSlots.next.audio === audio) slotDirection = 'next'

    if (slotDirection) {
      const slot = preloadSlots[slotDirection]
      slot.audio = rebuilt
      clearSlot(slot)
      scheduleAdjacentPreload()
    } else {
      // active audio 重建:仅同步引用,无 slot 状态需迁移
    }

    // 最后收尾旧元素(移到 rebuilt 引用切换之后,避免 clearSlot 等操作访问已暂停元素)
    teardownReplacedAudio(audio)
    degradeBeatAnalysis()
  }

  function guardedStartBeatAnalysis() {
    if (beatAnalysisDegraded) return
    void startBeatAnalysis()
  }

  function setPlayerVolume(audio: HTMLAudioElement, gain: number) {
    audio.volume = Math.max(0, Math.min(1, settings.value.volume * gain))
  }

  function audioGain(audio: HTMLAudioElement) {
    return settings.value.volume > 0 ? clamp(audio.volume / settings.value.volume, 0, 1) : 1
  }

  // 取消某个 audio 上正在进行的动画(若有):将其当前 animationId 归零,
  // 使该 audio 上挂起的 rAF step 在下一帧自检时提前 resolve 并停止。
  function cancelGainAnimation(audio: HTMLAudioElement) {
    gainAnimations.set(audio, 0)
  }

  function animateGain(
    audios: HTMLAudioElement[],
    updaters: Array<(eased: number) => void>,
    duration: number,
  ): Promise<void> {
    const animationId = Math.max(1, ...audios.map((a) => (gainAnimations.get(a) ?? 0) + 1))
    for (const a of audios) gainAnimations.set(a, animationId)
    const startedAt = performance.now()
    return new Promise<void>((resolve) => {
      function applyAll(eased: number) {
        for (const update of updaters) update(eased)
      }

      function step(now: number) {
        // 任一涉及元素被新动画接管即整体停止;0 表示被 cancelGainAnimation 显式取消。
        if (audios.some((a) => gainAnimations.get(a) !== animationId)) {
          resolve()
          return
        }
        const raw = Math.min(1, (now - startedAt) / duration)
        const eased = raw * raw * (3 - 2 * raw)
        applyAll(eased)
        if (raw >= 1) {
          resolve()
          return
        }
        if (document.hidden) {
          applyAll(1)
          resolve()
          return
        }
        window.requestAnimationFrame(step)
      }

      if (document.hidden) {
        applyAll(1)
        resolve()
        return
      }
      window.requestAnimationFrame(step)
    })
  }

  function crossfadePlayers(oldAudio: HTMLAudioElement, newAudio: HTMLAudioElement) {
    return animateGain(
      [oldAudio, newAudio],
      [
        (eased) => setPlayerVolume(oldAudio, 1 - eased),
        (eased) => setPlayerVolume(newAudio, eased),
      ],
      CROSSFADE_DURATION,
    ).then(() => {
      setPlayerVolume(oldAudio, 0)
      setPlayerVolume(newAudio, 1)
    })
  }

  function fadePlayer(audio: HTMLAudioElement, fromGain: number, toGain: number, duration: number) {
    return animateGain(
      [audio],
      [(eased) => setPlayerVolume(audio, fromGain + (toGain - fromGain) * eased)],
      duration,
    ).then(() => {
      setPlayerVolume(audio, toGain)
    })
  }

  function syncMediaSession() {
    if (!('mediaSession' in navigator)) return
    if (!currentTrack.value) {
      try {
        navigator.mediaSession.metadata = null
        navigator.mediaSession.playbackState = 'none'
      } catch {
        // Safari 旧版本对 mediaSession 赋值可能抛错
      }
      return
    }
    const track = currentTrack.value
    // Safari 15-16 有 mediaSession 对象但无 MediaMetadata 构造函数,需先检测
    if (typeof MediaMetadata !== 'undefined') {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: track.album || 'Meliora',
          artwork: track.cover ? [{ src: track.cover }] : [],
        })
      } catch {
        // 部分浏览器对 artwork 格式有要求,失败时忽略
      }
    }
    try {
      navigator.mediaSession.playbackState = isPlaying.value ? 'playing' : 'paused'
    } catch {
      // Safari 旧版本对 playbackState 赋值可能抛错
    }
  }

  function stopPlaybackForMissingTrack() {
    switchAbortController?.abort()
    for (const audio of players) {
      cancelGainAnimation(audio)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.volume = 0
    }
    activeAudio = players[0]
    setPlayerVolume(activeAudio, 1)
    playerState.value = 'idle'
    automaticCrossfadeStarted = false
    pendingSeekTime.value = null
    currentTime.value = 0
    duration.value = 0
    isPlaying.value = false
    clearPreloads()
    clearPreloadMessage()
    stopBeatAnalysis()
    syncMediaSession()
  }

  function describePlaybackError(error: unknown, audio: HTMLAudioElement) {
    const reason = error as DOMException
    if (reason.name === 'AbortError') return ''
    if (reason.name === 'NotAllowedError') return '浏览器阻止了播放，请再次点击播放'

    if (!audio.currentSrc && !audio.src) return '当前歌曲没有可用的音频地址'
    if (audio.error?.code === MEDIA_ERR_NETWORK) return '当前歌曲音频加载失败，请稍后再试'
    if (audio.error?.code === MEDIA_ERR_DECODE) return '浏览器无法解码当前音频'
    if (audio.error?.code === MEDIA_ERR_SRC_NOT_SUPPORTED)
      return '当前歌曲音频源暂时不可用或格式不支持'
    if (reason.name === 'NotSupportedError') return '当前歌曲音频源暂时不可用或格式不支持'
    return '当前歌曲无法播放，请稍后再试'
  }

  async function play() {
    if (!currentTrack.value) {
      const first = store.queue[0] ?? store.tracks[0]
      if (!first) return
      store.selectTrack(first, store.queue.length ? store.queue : store.tracks)
      await Promise.resolve()
    }
    try {
      setPlayerVolume(activeAudio, 1)
      await activeAudio.play()
      isPlaying.value = true
      store.errorMessage = ''
      guardedStartBeatAnalysis()
    } catch (error) {
      isPlaying.value = false
      store.errorMessage = describePlaybackError(error, activeAudio)
    }
  }

  function pause() {
    for (const audio of players) cancelGainAnimation(audio)
    activeAudio.pause()
    preloadSlots.previous.audio.pause()
    preloadSlots.next.audio.pause()
    isPlaying.value = false
  }

  function toggle() {
    if (isPlaying.value) pause()
    else void play()
  }

  function seek(time: number) {
    if (!Number.isFinite(time)) return
    const safeTime = Math.max(0, time)
    // 当 active audio 还没有有效 duration 时，写入 currentTime 不会生效。
    // 把目标时间记录到 pendingSeekTime，等 metadata 就绪后再 flush，
    // 同时立即把 UI 的 currentTime 同步过去，避免进度条跳回原位。
    if (!Number.isFinite(activeAudio.duration) || activeAudio.duration === 0) {
      pendingSeekTime.value = safeTime
      currentTime.value = safeTime
      return
    }
    activeAudio.currentTime = Math.max(0, Math.min(safeTime, activeAudio.duration || safeTime))
    currentTime.value = activeAudio.currentTime
    pendingSeekTime.value = null
  }

  // 当 audio 的 duration 终于可用时，把之前记下的 pendingSeekTime 真正写入。
  function flushPendingSeek(audio: HTMLAudioElement) {
    if (audio !== activeAudio) return
    if (pendingSeekTime.value == null) return
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return
    const target = clamp(pendingSeekTime.value, 0, audio.duration)
    audio.currentTime = target
    currentTime.value = target
    pendingSeekTime.value = null
  }

  function replaceActiveWithSlot(slot: PreloadSlot, direction: PreloadDirection) {
    const oldAudio = activeAudio
    const oldTrack = currentTrack.value
    const newAudio = slot.audio
    const reverseSlot = preloadSlots[direction === 'next' ? 'previous' : 'next']
    const spareAudio = reverseSlot.audio
    activeAudio = newAudio
    slot.audio = spareAudio
    slot.track = null
    slot.ready = null
    reverseSlot.audio = oldAudio
    reverseSlot.track = oldTrack
    reverseSlot.ready = oldTrack ? Promise.resolve(true) : null
    return { oldAudio, oldTrack, newAudio }
  }

  interface SwitchOptions {
    shouldPlay: boolean
    direction: PreloadDirection
    waitForReady: boolean
    updateStore: () => void
  }

  async function switchToTrack(
    track: Track,
    queue: Track[],
    options: SwitchOptions,
  ): Promise<boolean> {
    const { shouldPlay, direction, waitForReady, updateStore } = options
    if (playerState.value !== 'idle') return false
    playerState.value = 'switching'
    // try/finally 兜底:同步体或 waitForReady 的 await 期间若抛出任何异常,
    // 必须把 playerState 复位为 idle,否则后续所有 next/previous 在入口处
    // 早返回(playerState !== 'idle'),播放器将永久砖化至刷新。
    const controller = createSwitchAbort()
    try {
      const wasPlaying = isPlaying.value
      const useCrossfade = settings.value.smoothTrackChange && wasPlaying && shouldPlay
      const slot = findSlotByTrack(track) ?? preloadSlots[direction]

      if (waitForReady) {
        const ready =
          slot.track?.id === track.id
            ? await (slot.ready ?? Promise.resolve(slotCanStart(slot, track)))
            : await loadSlot(direction, track)
        if (!ready || isSwitchAborted(controller)) {
          if (!ready) {
            failedTrackIds.add(track.id)
            if (shouldPlay && settings.value.skipOnError && queue.length > 1) {
              preloadMessage.value = `已跳过暂时无法播放的歌曲，正在继续播放`
              schedulePlayerTimeout(() => void next(false), 80)
            }
          }
          playerState.value = 'idle'
          return false
        }
      } else if (slot.track?.id !== track.id || !slot.audio.src) {
        clearSlot(slot)
        slot.track = track
        slot.ready = null
        slot.audio.volume = 0
        slot.audio.src = track.audioUrl
        slot.audio.load()
        void preloadCover(track.cover)
        void preloadLyrics(track.lyricsUrl)
      }

      // ===== 极简同步阶段：只做 audio 引用切换 + reactivity =====
      // 所有非必要工作（syncMediaSession / 旧 audio 收尾 / currentTime 重置 / scheduleAdjacentPreload）
      // 全部推迟到 microtask 之后执行，最大化降低连点感知延迟。
      for (const audio of players) cancelGainAnimation(audio)
      const oldGain = audioGain(activeAudio)
      const oldAudioRef = activeAudio
      if (useCrossfade) {
        void fadePlayer(oldAudioRef, oldGain, 0, FADE_OUT_DURATION)
      }

      const { oldAudio, newAudio } = replaceActiveWithSlot(slot, direction)
      // 仅在必要时重置 currentTime，避免对预加载 slot（已经是 0）做重复浏览器调用。
      if (newAudio.currentTime > 0.01) newAudio.currentTime = 0
      setPlayerVolume(newAudio, useCrossfade ? 0 : 1)
      pendingSeekTime.value = null

      // 同步写入 reactivity：UI 立刻刷新到新歌（标题/封面/进度归零）。
      clearPreloadMessage()
      updateStore()
      currentTime.value = 0
      duration.value = Number.isFinite(newAudio.duration) ? newAudio.duration : 0
      isPlaying.value = shouldPlay
      automaticCrossfadeStarted = false
      playerState.value = 'idle'

      if (!shouldPlay) {
        // 暂停状态切歌：极简同步路径（不需要 play()）
        oldAudio.pause()
        oldAudio.currentTime = 0
        oldAudio.volume = 0
        // 后台刷新 mediaSession + 调度预加载，避免阻塞主流程
        queueMicrotask(() => {
          if (isSwitchAborted(controller)) return
          syncMediaSession()
          scheduleAdjacentPreload()
        })
        return true
      }

      // 异步启动新音频；不阻塞主流程。
      // mediaSession + 预加载调度推到 microtask，与 play() 启动并行进行。
      queueMicrotask(() => {
        if (isSwitchAborted(controller)) return
        syncMediaSession()
        scheduleAdjacentPreload()
      })

      newAudio
        .play()
        .then(() => {
          // 启动期间用户又点了别的歌：本次播放作废，让新流程接管收尾
          if (isSwitchAborted(controller)) return
          currentTime.value = newAudio.currentTime
          duration.value = Number.isFinite(newAudio.duration) ? newAudio.duration : 0
          isPlaying.value = true
          store.errorMessage = ''
          if (useCrossfade) {
            const fadeInPromise =
              waitForReady && oldAudio !== newAudio
                ? crossfadePlayers(oldAudio, newAudio)
                : fadePlayer(newAudio, 0, 1, FADE_IN_DURATION)
            void fadeInPromise.finally(() => {
              if (isSwitchAborted(controller)) return
              oldAudio.pause()
              oldAudio.currentTime = 0
              oldAudio.volume = 0
            })
          } else {
            oldAudio.pause()
            oldAudio.currentTime = 0
            oldAudio.volume = 0
          }
        })
        .catch((error) => {
          if (isSwitchAborted(controller)) return
          failedTrackIds.add(track.id)
          store.errorMessage = describePlaybackError(error, newAudio)
          newAudio.pause()
          if (settings.value.skipOnError && queue.length > 1) {
            preloadMessage.value = `已跳过暂时无法播放的歌曲，正在继续播放`
            activeAudio = oldAudio
            const reverseSlot = preloadSlots[direction === 'next' ? 'previous' : 'next']
            reverseSlot.audio = newAudio
            reverseSlot.track = null
            reverseSlot.ready = null
            clearSlot(reverseSlot)
            isPlaying.value = shouldPlay
            schedulePlayerTimeout(() => void next(true), 0)
          } else {
            preloadMessage.value = ''
            oldAudio.pause()
            oldAudio.currentTime = 0
            oldAudio.volume = 0
            isPlaying.value = false
          }
        })

      return true
    } finally {
      // 兜底复位:正常路径已在上方将 playerState 置回 'idle';
      // 此处仅捕获抛出异常时残留的 'switching' 状态,防止播放器砖化。
      if (playerState.value === 'switching') playerState.value = 'idle'
    }
  }

  async function selectAndPlay(track: Track, queue: Track[]): Promise<void> {
    await switchToTrack(track, queue, {
      shouldPlay: true,
      direction: 'next',
      waitForReady: false,
      updateStore: () => store.selectTrack(track, queue),
    })
  }

  async function next(manual = true) {
    const track = predictNextTrack(manual)
    if (!track) {
      pause()
      seek(0)
      return
    }
    await switchToTrack(track, store.queue, {
      shouldPlay: isPlaying.value,
      direction: 'next',
      waitForReady: !manual,
      updateStore: () => store.nextTrack(manual, track.id),
    })
  }

  async function previous() {
    if (activeAudio.currentTime > 5) {
      seek(0)
      return
    }
    const queue = store.queue
    const candidates: Track[] = []
    for (let offset = 1; offset <= queue.length; offset += 1) {
      const index = (store.currentIndex - offset + queue.length) % queue.length
      const candidate = queue[index]
      if (candidate && !failedTrackIds.has(candidate.id)) {
        candidates.push(candidate)
      }
    }
    for (const track of candidates) {
      const switched = await switchToTrack(track, queue, {
        shouldPlay: isPlaying.value,
        direction: 'previous',
        waitForReady: false,
        updateStore: () => store.previousTrack(track.id),
      })
      if (switched) return
    }
  }

  watch(
    currentTrack,
    (track, previousTrack) => {
      if (!track) {
        stopPlaybackForMissingTrack()
        return
      }
      if (playerState.value !== 'idle') return
      const resolvedUrl = new URL(track.audioUrl, window.location.href).href
      if (activeAudio.src === resolvedUrl) return
      activeAudio.src = track.audioUrl
      activeAudio.load()
      automaticCrossfadeStarted = false
      // 切换到全新音频源时旧的 pending seek 时间也要丢弃
      pendingSeekTime.value = null
      syncMediaSession()
      scheduleAdjacentPreload()
      if (previousTrack && isPlaying.value) void play()
    },
    { immediate: true, flush: 'sync' },
  )

  watch(
    () => settings.value.volume,
    () => {
      setPlayerVolume(activeAudio, 1)
    },
    { immediate: true },
  )
  watch(() => settings.value.playMode, clearPreloads)
  watch(
    () => settings.value.preloadNextTrack,
    (enabled) => {
      if (!enabled) clearPreloads()
      else scheduleAdjacentPreload()
    },
  )
  watch(
    () => store.queueVersion,
    () => {
      failedTrackIds.clear()
      clearPreloads()
      scheduleAdjacentPreload()
    },
  )
  watch(isPlaying, syncMediaSession)

  function handleTimeUpdate(audio: HTMLAudioElement) {
    if (audio !== activeAudio) return
    currentTime.value = audio.currentTime
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      const remaining = audio.duration - audio.currentTime
      const nextSlot = preloadSlots.next
      if (
        settings.value.smoothTrackChange &&
        nextSlot.track &&
        nextSlot.ready &&
        !automaticCrossfadeStarted &&
        remaining <= CROSSFADE_DURATION / 1000
      ) {
        automaticCrossfadeStarted = true
        void next(false)
      }
    }
    if ('mediaSession' in navigator && Number.isFinite(audio.duration)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate,
          position: Math.min(audio.currentTime, audio.duration),
        })
      } catch {
        // Browsers can reject position updates during media transitions.
      }
    }
  }

  type AudioListenerEntry = {
    audio: HTMLAudioElement
    type: string
    listener: EventListener
  }
  const audioListeners: AudioListenerEntry[] = []

  function bindAudioListener(audio: HTMLAudioElement, type: string, listener: EventListener) {
    audio.addEventListener(type, listener)
    audioListeners.push({ audio, type, listener })
  }

  function bindAudioEventListeners(audio: HTMLAudioElement) {
    const onTimeUpdate: EventListener = () => handleTimeUpdate(audio)
    const onDurationChange: EventListener = () => {
      if (audio === activeAudio) {
        duration.value = Number.isFinite(audio.duration) ? audio.duration : 0
        flushPendingSeek(audio)
        scheduleAdjacentPreload()
      }
    }
    const onLoadedMetadata: EventListener = () => {
      if (audio === activeAudio) {
        duration.value = Number.isFinite(audio.duration) ? audio.duration : 0
        flushPendingSeek(audio)
      }
    }
    const onCanPlay: EventListener = () => {
      if (audio === activeAudio) scheduleAdjacentPreload()
    }
    const onPlay: EventListener = () => {
      if (audio === activeAudio) {
        isPlaying.value = true
        guardedStartBeatAnalysis()
      }
    }
    const onPause: EventListener = () => {
      if (audio === activeAudio && playerState.value === 'idle') {
        isPlaying.value = false
        stopBeatAnalysis()
      }
    }
    const onEnded: EventListener = () => {
      if (audio === activeAudio && playerState.value === 'idle') void next(false)
    }
    const onError: EventListener = () => {
      if (audio !== activeAudio) return
      const failedTrack = currentTrack.value
      // 过渡期间失败也要正确释放锁，否则后续所有切歌操作都会被永久阻止。
      const wasTransitioning = playerState.value !== 'idle'
      playerState.value = 'idle'
      automaticCrossfadeStarted = false
      const willSkip = Boolean(failedTrack) && settings.value.skipOnError && store.queue.length > 1
      if (failedTrack) {
        failedTrackIds.add(failedTrack.id)
        if (wasTransitioning) {
          console.warn(
            '[useAudioPlayer] active audio error during transition',
            failedTrack.id,
            audio.error,
          )
        }
      } else if (wasTransitioning) {
        console.warn('[useAudioPlayer] active audio error during transition', audio.error)
      }
      if (willSkip) {
        // 仅在真的会跳到下一首时提示"已跳过…继续播放",避免 skipOnError 关闭或
        // 单曲队列时误报"继续播放"而实际已停止。
        preloadMessage.value = `已跳过暂时无法播放的歌曲，正在继续播放`
        store.errorMessage = ''
        schedulePlayerTimeout(() => void next(false), 80)
      } else {
        // 不跳过:透传描述性错误,让用户看到真实失败原因(网络/解码/源不支持等),
        // 而非清空消息让播放器静默停止。
        store.errorMessage = describePlaybackError(new Error('media error'), audio)
      }
    }

    bindAudioListener(audio, 'timeupdate', onTimeUpdate)
    bindAudioListener(audio, 'durationchange', onDurationChange)
    bindAudioListener(audio, 'loadedmetadata', onLoadedMetadata)
    bindAudioListener(audio, 'canplay', onCanPlay)
    bindAudioListener(audio, 'play', onPlay)
    bindAudioListener(audio, 'pause', onPause)
    bindAudioListener(audio, 'ended', onEnded)
    bindAudioListener(audio, 'error', onError)
  }

  for (const audio of players) {
    bindAudioEventListeners(audio)
  }

  const MEDIA_SESSION_ACTIONS: MediaSessionAction[] = [
    'play',
    'pause',
    'previoustrack',
    'nexttrack',
    'seekto',
    'seekbackward',
    'seekforward',
  ]

  // Safari 15-16 对部分 MediaSessionAction 不支持,setActionHandler 会抛 TypeError,
  // 用统一包装函数兜底,避免初始化阶段整体失败。
  function safeSetActionHandler(
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null,
  ) {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch {
      // 忽略不支持的动作
    }
  }

  if ('mediaSession' in navigator) {
    safeSetActionHandler('play', () => void play())
    safeSetActionHandler('pause', pause)
    safeSetActionHandler('previoustrack', () => void previous())
    safeSetActionHandler('nexttrack', () => void next())
    safeSetActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) seek(details.seekTime)
    })
    safeSetActionHandler('seekbackward', (details) =>
      seek(activeAudio.currentTime - (details.seekOffset || 10)),
    )
    safeSetActionHandler('seekforward', (details) =>
      seek(activeAudio.currentTime + (details.seekOffset || 10)),
    )
  }

  onBeforeUnmount(() => {
    switchAbortController?.abort()
    switchAbortController = null
    for (const timeout of pendingPlayerTimeouts) window.clearTimeout(timeout)
    pendingPlayerTimeouts.clear()
    stopBeatAnalysis()
    for (const audio of players) cancelGainAnimation(audio)
    for (const { audio, type, listener } of audioListeners) {
      audio.removeEventListener(type, listener)
    }
    audioListeners.length = 0
    for (const audio of players) {
      audio.pause()
      audio.src = ''
    }
    if ('mediaSession' in navigator) {
      for (const action of MEDIA_SESSION_ACTIONS) {
        try {
          navigator.mediaSession.setActionHandler(action, null)
        } catch {
          // 某些浏览器对部分 action 不支持，setActionHandler(action, null) 会抛错，忽略即可。
        }
      }
    }
  })

  return {
    beatLevel,
    spectrumLevels,
    preloadMessage,
    play,
    pause,
    toggle,
    seek,
    next,
    previous,
    selectAndPlay,
  }
}
