import { createBeatVisualRenderer } from '../platform/web/beat-visuals'
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { usePlayerStore } from '../stores/player'
import type { Track } from '../core/types'
import type { AudioChannel } from '../core/audio/backend'
import type { LyricPlaybackState } from '../core/lyrics/render-schedule'
import type { BeatPreloadTarget } from '../core/analysis/beat-timeline'
import { sanitizeBeatFlashRate } from '../core/analysis/beat-envelope'
import { shouldUseIOSBackgroundSafeAudio } from '../platform/web/browser'
import { createWebAudioBackend } from '../platform/web/audio-backend'
import {
  describePlaybackFailure,
  resolveFailureAction,
  type PlaybackFailureReason,
} from '../core/audio/failure'
import { previousMeansRestart, resolveSeek, shouldStartAutoCrossfade } from '../core/audio/timeline'
import { useBeatAnalyser } from '../platform/web/useBeatAnalyser'
import { useEqualizer } from './useEqualizer'
import {
  usePreloadPool,
  preloadCover,
  type PreloadDirection,
  type PreloadSlot,
} from './usePreloadPool'
import { FADE_IN_DURATION_MS, FADE_OUT_DURATION_MS } from '../core/audio/fade'
import { createAudioGain } from '../platform/web/audio-gain'
import { createPlaybackTransition } from '../platform/web/playback-transition'
import { createMediaSession } from '../platform/web/media-session'
import { useAudioPreloadDebug } from '../platform/web/useAudioPreloadDebug'
import { useBeatComparison } from '../platform/web/useBeatComparison'
import { useBeatThisModels } from '../platform/web/useBeatThisModels'
import { useJsonDownload } from '../platform/web/useJsonDownload'
import { APP_VERSION } from '../generated/app-version'
import { useListeningStats } from '../platform/web/useListeningStats'
import { createPlaybackRecovery } from '../platform/web/playback-recovery'
import { usePlaybackBudget } from '../platform/web/usePlaybackBudget'
import { createPlaybackCoordinator } from '../platform/web/playback-coordinator'
import { refreshListeningHistory } from '../platform/web/listening-history'
import { usePlaybackPreferences } from '../platform/web/usePlaybackPreferences'
import { createPlaybackSync } from '../platform/web/playback-sync'

export interface UseAudioPlayerOptions {
  /** Only observe diagnostic data while its panel is visible. */
  debugEnabled?: Readonly<Ref<boolean>>
  /** Comparison work is available only on its visible diagnostic tab. */
  beatComparisonEnabled?: Readonly<Ref<boolean>>
  /**
   * 可选：返回需要每帧同步 `--beat-level` CSS 变量的目标节点列表。
   * 由节拍渲染适配器消费，与分析器的采样逻辑分离。
   */
  getBeatTargets?: () => readonly (HTMLElement | null | undefined)[]
  /**
   * 可选：返回队列小频谱 meter 节点(`--spectrum-level-N` 写入目标)。
   * 由节拍渲染适配器消费，与分析器的采样逻辑分离。
   */
  getSpectrumTargets?: () => readonly (HTMLElement | null | undefined)[]
}

export function useAudioPlayer(options: UseAudioPlayerOptions = {}) {
  const store = usePlayerStore()
  const { currentTrack, isPlaying, currentTime, duration, settings } = storeToRefs(store)
  usePlaybackPreferences(settings)
  const followingTab = ref(false)
  const detachedTabPosition = ref<number | null>(null)
  const localPlaying = computed(() => isPlaying.value && !followingTab.value)
  let tabSync: ReturnType<typeof createPlaybackSync> | null = null
  const debugEnabled = computed(() => import.meta.env.DEV && options.debugEnabled?.value === true)
  const comparisonEnabled = computed(
    () => debugEnabled.value && options.beatComparisonEnabled?.value === true,
  )
  if (!['basic', 'beat-this-small', 'beat-this-standard'].includes(settings.value.beatAnalysisMode))
    settings.value.beatAnalysisMode = 'basic'
  const iosBackgroundSafeAudio = shouldUseIOSBackgroundSafeAudio()
  const backend = createWebAudioBackend({
    backgroundSafe: iosBackgroundSafeAudio,
    initialVolume: settings.value.volume,
    // 跨源素材被 Web Audio 拒绝后频谱不可用,队列小频谱要回退成序号
    onSpectrumLost: () => {
      spectrumAvailable.value = false
    },
  })
  const channels = backend.channels()
  const transition = createPlaybackTransition()
  const { cancelGainAnimation, clearGainAnimationFrames, crossfadePlayers, fadePlayer } =
    createAudioGain()
  let automaticCrossfadeStarted = false
  let playbackVersion = 0
  let allowInterruptedStart = false
  let disposed = false
  let committingSwitch = false
  let retiringChannel: AudioChannel | null = null
  let pendingStart: { channel: AudioChannel; fail: (error: unknown) => void } | null = null
  const pendingPlayerTimeouts = new Set<number>()
  // 当 active audio 还没有有效 duration 时，记录用户请求的 seek 时间，
  // 等到 durationchange / loadedmetadata 后再真正写入 audio.currentTime。
  const pendingSeekTime = ref<number | null>(null)
  let beatAnalysisDegraded = false
  // iOS 后台安全模式或 CORS 降级后没有节拍分析:队列小频谱应回退显示序号,
  // 而不是一排静止的柱子
  const spectrumAvailable = ref(!iosBackgroundSafeAudio)
  let degradationWarned = false
  const lyricPlaybackListeners = new Set<() => void>()
  const waitingChannels = new Set<AudioChannel>()
  const coordination = createPlaybackCoordinator({
    onLost() {
      listening.flush()
      pauseLocal()
      preloadMessage.value = '已在另一个页面播放'
    },
    onClaim: refreshListeningHistory,
  })
  coordination.setEnabled(settings.value.tabCoordination)
  store.setPlaybackSessionGuard(coordination.canPersist)
  let recoveryPosition: number | null = null
  let recoveryAttempt = 0
  let waitingTimeout: number | undefined
  const recovery = createPlaybackRecovery({
    retry: retryCurrentAudio,
    onPhase(phase) {
      if (phase === 'idle') {
        if (store.errorMessage.startsWith('网络')) store.errorMessage = ''
      } else if (phase === 'exhausted') {
        recoveryAttempt += 1
        backend.active().pause()
        isPlaying.value = false
        stopBeatAnalysis()
        store.errorMessage = '网络暂时无法恢复，已保留进度，点击播放可重试'
      } else {
        store.errorMessage =
          phase === 'offline' ? '网络已断开，连接恢复后继续播放' : '网络暂时中断，正在尝试恢复播放'
      }
    },
  })

  function notifyLyricsPlayback(): void {
    if (disposed) return
    for (const listener of lyricPlaybackListeners) listener()
    tabSync?.publish()
  }

  function getLyricsPlaybackState(): LyricPlaybackState {
    const shared = followingTab.value ? tabSync?.read() : null
    if (shared)
      return {
        timeSeconds: shared.position,
        playing: shared.playing && shared.advancing,
        playbackRate: shared.playbackRate,
        seeking: shared.seeking,
      }
    if (detachedTabPosition.value !== null)
      return {
        timeSeconds: detachedTabPosition.value,
        playing: false,
        playbackRate: 1,
        seeking: false,
      }
    const channel = backend.active()
    const audio = backend.elementOf(channel)
    return {
      timeSeconds: channel.currentTime(),
      playing:
        !disposed &&
        isPlaying.value &&
        !audio.paused &&
        !audio.ended &&
        !waitingChannels.has(channel) &&
        audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
      playbackRate: audio.playbackRate,
      seeking: audio.seeking,
    }
  }

  function subscribeLyricsPlayback(listener: () => void): () => void {
    if (disposed) return () => undefined
    lyricPlaybackListeners.add(listener)
    return () => lyricPlaybackListeners.delete(listener)
  }

  function schedulePlayerTimeout(callback: () => void, delay: number): number {
    const version = playbackVersion
    const handle = window.setTimeout(() => {
      pendingPlayerTimeouts.delete(handle)
      if (!disposed && version === playbackVersion) callback()
    }, delay)
    pendingPlayerTimeouts.add(handle)
    return handle
  }

  function mountActiveAudioForIOS() {
    backend.prepareActive()
  }

  const { bindFilters: bindEqFilters } = useEqualizer({ settings })
  const beatVisuals = createBeatVisualRenderer(options)
  const listening = useListeningStats({
    canRecord: coordination.owns,
    track: currentTrack,
    players: channels.map((channel) => backend.elementOf(channel)),
    getActiveAudio: () => backend.elementOf(backend.active()),
    isPlaying,
  })
  const adjacentBeatTargets = shallowRef<readonly BeatPreloadTarget[]>([])
  const budget = usePlaybackBudget({
    enabled: computed(() => settings.value.adaptivePerformance),
    playing: localPlaying,
    source: computed(() => currentTrack.value?.audioUrl ?? ''),
    getActiveAudio: () => backend.elementOf(backend.active()),
    subscribe: subscribeLyricsPlayback,
  })
  const {
    beatLevel,
    spectrumLevels,
    startBeatAnalysis,
    stopBeatAnalysis,
    preanalysis,
    resetBeatTracking,
    debugSnapshot,
  } = useBeatAnalyser({
    resourcePressure: budget.pressure,
    visualIntervalMs: budget.visualIntervalMs,
    observeVisualFrame: budget.observeFrame,
    track: currentTrack,
    // 频谱要真实元素,这是 Web 后端的专有出口
    players: channels.map((channel) => backend.elementOf(channel)),
    getActiveAudio: () => backend.elementOf(backend.active()),
    isPlaying: localPlaying,
    debugEnabled,
    debugSampleIntervalMs: computed(() => (comparisonEnabled.value ? 1000 / 30 : 100)),
    mode: computed(() => settings.value.beatAnalysisMode),
    beatFlashRate: computed(() => settings.value.beatFlashRate),
    beatVisualDelay: computed(() => settings.value.beatVisualDelay),
    source: computed(() => currentTrack.value?.audioUrl ?? ''),
    durationSeconds: duration,
    adjacent: adjacentBeatTargets,
    preloadEnabled: computed(
      () =>
        settings.value.preloadNextTrack &&
        !followingTab.value &&
        detachedTabPosition.value === null,
    ),
    enabled: computed(
      () =>
        settings.value.beatFlash &&
        !followingTab.value &&
        !iosBackgroundSafeAudio &&
        spectrumAvailable.value,
    ),
    unavailableReason: computed(() =>
      iosBackgroundSafeAudio
        ? '此设备使用后台播放兼容模式，暂不支持背景预分析'
        : !spectrumAvailable.value
          ? '当前音源无法读取音频数据，背景预分析暂不可用'
          : null,
    ),
    onBeat: beatVisuals.renderBeat,
    onSpectrum: beatVisuals.renderSpectrum,
    onEqFiltersReady: bindEqFilters,
    onTainted: (audio) => {
      backend.degradeForTaint(audio)
      notifyLyricsPlayback()
      degradeBeatAnalysis()
    },
  })

  const comparisonModels = useBeatThisModels()
  const beatComparison = useBeatComparison({
    source: computed(() => currentTrack.value?.audioUrl ?? ''),
    durationSeconds: duration,
    flashRate: computed(() => sanitizeBeatFlashRate(settings.value.beatFlashRate)),
    enabled: comparisonEnabled,
    debug: debugSnapshot ?? shallowRef(null),
    liveTimeline: preanalysis.timeline,
    liveMode: computed(() => settings.value.beatAnalysisMode),
    modelAvailable: computed(() => ({
      small: comparisonModels.status.value.small.phase === 'ready',
      standard: comparisonModels.status.value.standard.phase === 'ready',
    })),
    getPlaybackSeconds: () => backend.active().currentTime(),
    getPlaybackState: () => {
      const audio = backend.elementOf(backend.active())
      return {
        timeSeconds: audio.currentTime,
        playing:
          isPlaying.value &&
          !audio.paused &&
          !audio.ended &&
          audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA,
        playbackRate: audio.playbackRate,
        seeking: audio.seeking,
      }
    },
    acquirePause: (signal) => preanalysis.acquirePause(signal, { foregroundFirst: true }),
  })
  const comparisonDownload = useJsonDownload()
  watch(() => currentTrack.value?.audioUrl, comparisonDownload.clearError, { flush: 'sync' })

  async function exportBeatComparison(): Promise<boolean> {
    if (beatComparison.recordingStats.value.sampleCount === 0) return false
    const source = currentTrack.value?.audioUrl
    const exportedAtIso = new Date().toISOString()
    const stamp = exportedAtIso.replace(/[:.]/g, '-')
    return comparisonDownload.download(() => {
      if (
        currentTrack.value?.audioUrl !== source ||
        beatComparison.recordingStats.value.sampleCount === 0
      )
        throw new Error('Comparison source changed')
      return beatComparison.exportData({
        exportedAtIso,
        title: currentTrack.value?.title,
        artist: currentTrack.value?.artist,
        appVersion: APP_VERSION,
        playbackRate: backend.elementOf(backend.active()).playbackRate,
        requestedSampleIntervalMs: 1000 / 30,
        beatBrightness: settings.value.beatBrightness,
        beatVisualDelayMs: settings.value.beatVisualDelay,
        beatFlashEnabled: settings.value.beatFlash,
      })
    }, `meliora-beat-comparison-${stamp}.json`)
  }

  const {
    preloadSlots,
    preloadMessage,
    markTrackFailed,
    clearFailedTrack,
    isTrackFailed,
    predictNextTrack,
    clearPreloads,
    resetSlotChannels,
    clearSlot,
    transferLyricsForPromotion,
    clearPreloadMessage,
    findSlotByTrack,
    slotCanStart,
    loadSlot,
    scheduleAdjacentPreload,
    refreshTargets,
  } = usePreloadPool({
    backend,
    store,
    settings: computed(() =>
      followingTab.value || detachedTabPosition.value !== null
        ? { ...settings.value, preloadNextTrack: false }
        : settings.value,
    ),
    transitionInProgress: () => transition.isPreparing() || retiringChannel !== null,
    isChannelProtected: (channel) => channel === retiringChannel,
    onTargetsChanged: (targets) => {
      adjacentBeatTargets.value = targets
    },
  })

  const audioPreloadDebug = useAudioPreloadDebug({
    enabled: debugEnabled,
    getElements: () => channels.map((channel) => backend.elementOf(channel)),
    getSlots: () =>
      (['previous', 'next'] as const).map((direction) => {
        const slot = preloadSlots[direction]
        return {
          direction,
          channel: slot.channel,
          audio: backend.elementOf(slot.channel),
          track: slot.track,
          protected: slot.channel === retiringChannel,
        }
      }),
  })
  watch(
    [
      () => debugSnapshot?.value,
      adjacentBeatTargets,
      currentTrack,
      spectrumAvailable,
      isPlaying,
      () => settings.value.preloadNextTrack,
    ],
    audioPreloadDebug.refresh,
    { flush: 'post' },
  )

  watch(
    () => currentTrack.value?.id,
    () => resetBeatTracking(),
  )

  // 用户的新操作接管播放；旧 Promise、跳歌定时器和增益动画不再有写入权。
  function invalidatePlayback(resetRecovery = true): void {
    allowInterruptedStart = false
    clearWaitingTimeout()
    if (resetRecovery) {
      recovery.cancel()
      recoveryPosition = null
    }
    recoveryAttempt += 1
    const wasPreparing = transition.isPreparing()
    playbackVersion += 1
    pendingStart = null
    transition.cancel()
    for (const timeout of pendingPlayerTimeouts) window.clearTimeout(timeout)
    pendingPlayerTimeouts.clear()
    retiringChannel = null
    if (wasPreparing) clearPreloads()
    for (const channel of channels) {
      cancelGainAnimation(channel)
      if (channel !== backend.active()) {
        channel.pause()
        channel.setGain(0)
      }
    }
    backend.active().setGain(1)
    automaticCrossfadeStarted = false
    refreshTargets()
  }

  function finishOutgoing(channel: AudioChannel): void {
    channel.pause()
    channel.setGain(0)
    if (retiringChannel === channel) retiringChannel = null
    refreshTargets()
    scheduleAdjacentPreload()
  }

  // 跨源污染的善后全部在后端内部完成:换掉底层元素、迁移播放位置、重挂监听,
  // 通道句柄与其上的订阅都不变,所以这里只需要把频谱标记为不可用。
  // 预加载槽持有的也是句柄,不需要迁移引用
  function degradeBeatAnalysis() {
    if (beatAnalysisDegraded) return
    beatAnalysisDegraded = true
    spectrumAvailable.value = false
    if (!degradationWarned) {
      console.warn(
        '[useAudioPlayer] 音频源不支持 CORS,节拍分析已降级(播放不受影响)',
        backend.active().source(),
      )
      degradationWarned = true
    }
    stopBeatAnalysis()
  }

  function guardedStartBeatAnalysis() {
    if (iosBackgroundSafeAudio) return
    if (beatAnalysisDegraded) return
    void startBeatAnalysis()
  }

  function stopPlaybackForMissingTrack() {
    invalidatePlayback()
    for (const channel of channels) {
      cancelGainAnimation(channel)
      channel.release()
      channel.setGain(0)
    }
    backend.setActive(channels[0]!)
    notifyLyricsPlayback()
    backend.active().setGain(1)
    automaticCrossfadeStarted = false
    pendingSeekTime.value = null
    currentTime.value = 0
    duration.value = 0
    isPlaying.value = false
    // 出声通道被拨回 channels[0],预加载槽必须跟着还原:
    // 切过歌之后 channels[0] 可能正被某个槽占着,不还原就会被预加载抢走
    resetSlotChannels()
    clearPreloadMessage()
    stopBeatAnalysis()
    syncMediaSession()
  }

  // 平台错误先归一成平台无关的原因,文案由核心层给
  function describePlaybackError(error: unknown, channel: AudioChannel) {
    return describePlaybackFailure(channel.classifyFailure(error))
  }

  function handleRecoverableFailure(channel: AudioChannel, reason: PlaybackFailureReason): boolean {
    // Offline loads may fail before the browser has enough data to detect a format.
    if (navigator.onLine === false && (reason === 'unsupported' || reason === 'unknown'))
      reason = 'network'
    if (reason !== 'network' && reason !== 'not-allowed') return false
    const position = pendingSeekTime.value ?? (channel.currentTime() || currentTime.value)
    const wantedPlayback = isPlaying.value
    invalidatePlayback(reason !== 'network')
    clearFailedTrack(currentTrack.value?.id ?? '')
    if (reason === 'not-allowed' || !wantedPlayback) {
      channel.pause()
      isPlaying.value = false
      stopBeatAnalysis()
      store.errorMessage = describePlaybackFailure(reason)
      return true
    }
    recoveryPosition = Math.max(0, position)
    currentTime.value = recoveryPosition
    waitingChannels.add(channel)
    stopBeatAnalysis()
    recovery.fail()
    channel.pause()
    notifyLyricsPlayback()
    return true
  }

  function retryCurrentAudio(): void {
    if (disposed || !currentTrack.value || !isPlaying.value) return recovery.cancel()
    const channel = backend.active()
    const position = recoveryPosition ?? currentTime.value
    const attempt = ++recoveryAttempt
    const version = playbackVersion
    const isCurrent = () =>
      !disposed &&
      attempt === recoveryAttempt &&
      version === playbackVersion &&
      channel === backend.active()
    channel.load(currentTrack.value.audioUrl)
    channel.seek(position)
    pendingSeekTime.value = channel.duration() === null ? position : null
    currentTime.value = position
    void channel
      .play()
      .then(() => {
        if (!isCurrent()) return
        recovery.settled()
        recoveryPosition = null
        waitingChannels.delete(channel)
        isPlaying.value = true
        store.clearResume()
        guardedStartBeatAnalysis()
        notifyLyricsPlayback()
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return
        const reason = channel.classifyFailure(error)
        if (handleRecoverableFailure(channel, reason)) return
        recovery.cancel()
        if (reason !== 'aborted') handleActiveChannelError(channel)
      })
  }

  function clearWaitingTimeout(): void {
    if (waitingTimeout === undefined) return
    window.clearTimeout(waitingTimeout)
    pendingPlayerTimeouts.delete(waitingTimeout)
    waitingTimeout = undefined
  }

  function watchStarvedPlayback(channel: AudioChannel): void {
    clearWaitingTimeout()
    if (!isPlaying.value || recovery.active()) return
    if (navigator.onLine === false) {
      handleRecoverableFailure(channel, 'network')
      return
    }
    waitingTimeout = schedulePlayerTimeout(() => {
      waitingTimeout = undefined
      if (channel === backend.active() && isPlaying.value && waitingChannels.has(channel)) {
        handleRecoverableFailure(channel, 'network')
      }
    }, 12000)
  }

  async function play(): Promise<void> {
    if (disposed) return
    if (tabSync?.command({ action: 'play' })) return
    const retryPosition = recoveryPosition ?? detachedTabPosition.value
    detachedTabPosition.value = null
    invalidatePlayback()
    if (!currentTrack.value) {
      const first = store.queue[0] ?? store.tracks[0]
      if (!first) return
      store.selectTrack(first, store.queue.length ? store.queue : store.tracks)
    }
    coordination.claim()
    const version = playbackVersion
    const channel = backend.active()
    if (retryPosition !== null || channel.failed()) {
      const position = retryPosition ?? currentTime.value
      channel.load(currentTrack.value!.audioUrl)
      channel.seek(position)
      pendingSeekTime.value = channel.duration() === null ? position : null
    }
    const source = channel.source()
    const trackId = currentTrack.value?.id
    const isCurrent = () =>
      !disposed &&
      version === playbackVersion &&
      channel === backend.active() &&
      channel.source() === source &&
      currentTrack.value?.id === trackId
    isPlaying.value = true
    try {
      channel.setGain(1)
      await channel.play()
      if (!isCurrent()) return
      isPlaying.value = true
      store.errorMessage = ''
      store.clearResume()
      guardedStartBeatAnalysis()
    } catch (error) {
      if (!isCurrent()) return
      if (handleRecoverableFailure(channel, channel.classifyFailure(error))) return
      allowInterruptedStart = channel.classifyFailure(error) === 'aborted'
      isPlaying.value = false
      store.errorMessage = describePlaybackError(error, channel)
    }
  }

  function pauseLocal(): void {
    invalidatePlayback()
    clearPreloads()
    for (const channel of channels) channel.pause()
    isPlaying.value = false
    stopBeatAnalysis()
  }

  function pause(): void {
    if (tabSync?.command({ action: 'pause' })) return
    pauseLocal()
  }

  function toggle() {
    if (isPlaying.value) pause()
    else void play()
  }

  function replayCurrentTrack() {
    if (!currentTrack.value) return
    listening.restartVisit()
    automaticCrossfadeStarted = false
    pendingSeekTime.value = null
    backend.active().seek(0)
    currentTime.value = 0
    void play()
  }

  function seek(time: number) {
    if (!Number.isFinite(time)) return
    if (tabSync?.command({ action: 'seek', position: Math.max(0, time) })) return
    if (detachedTabPosition.value !== null) {
      const target = Math.max(0, duration.value > 0 ? Math.min(time, duration.value) : time)
      detachedTabPosition.value = target
      currentTime.value = target
      notifyLyricsPlayback()
      return
    }
    if (Number.isFinite(time) && transition.isPreparing()) invalidatePlayback()
    automaticCrossfadeStarted = false
    // 时长未知时通道会自己记下目标位置、等时长可用再落位;
    // 界面要立刻反映用户意图,所以两种结果都同步 currentTime
    const channel = backend.active()
    const resolution = resolveSeek(time, channel.duration())
    if (resolution.kind === 'ignore') return
    if (retiringChannel) {
      // End the audible overlap without cancelling the incoming play() result:
      // it still owns startup failure handling and analysis initialization.
      cancelGainAnimation(channel)
      cancelGainAnimation(retiringChannel)
      channel.setGain(1)
      finishOutgoing(retiringChannel)
    }
    store.clearResume()
    channel.seek(resolution.time)
    if (recovery.active()) recoveryPosition = resolution.time
    currentTime.value = resolution.time
    pendingSeekTime.value = resolution.kind === 'pending' ? resolution.time : null
    notifyLyricsPlayback()
    tabSync?.publish(true)
  }

  // 时长终于可用时,把界面上的进度对到通道真正落到的位置
  function flushPendingSeek(channel: AudioChannel) {
    if (channel !== backend.active()) return
    if (pendingSeekTime.value === null) return
    if (channel.duration() === null) return
    currentTime.value = channel.currentTime()
    pendingSeekTime.value = null
  }

  // 出声通道与预加载槽换位:新曲目那一路转正,旧的退到反方向的槽里
  // (往回切时它就是"下一首",已经加载好可以直接用)
  function replaceActiveWithSlot(slot: PreloadSlot, direction: PreloadDirection) {
    const outgoing = backend.active()
    const oldTrack = currentTrack.value
    const incoming = slot.channel
    const reverseSlot = preloadSlots[direction === 'next' ? 'previous' : 'next']
    const spare = reverseSlot.channel
    slot.cleanup?.()
    reverseSlot.cleanup?.()
    backend.setActive(incoming)
    notifyLyricsPlayback()
    slot.channel = spare
    slot.track = null
    slot.ready = null
    reverseSlot.channel = outgoing
    reverseSlot.track = oldTrack
    reverseSlot.ready = oldTrack ? Promise.resolve(true) : null
    const releaseIncomingLyrics = transferLyricsForPromotion(slot, reverseSlot)
    return { outgoing, oldTrack, incoming, releaseIncomingLyrics }
  }

  interface SwitchOptions {
    shouldPlay: boolean
    direction: PreloadDirection
    waitForReady: boolean
    updateStore: () => void
  }

  async function switchToTrack(track: Track, switchOptions: SwitchOptions): Promise<boolean> {
    const { shouldPlay, direction: requestedDirection, waitForReady, updateStore } = switchOptions
    if (disposed || transition.isPreparing()) return false
    detachedTabPosition.value = null
    if (shouldPlay) coordination.claim()
    invalidatePlayback()
    const controller = transition.begin()
    if (!controller) return false
    // 异常时也释放准备阶段；任务身份继续保护异步播放与淡入淡出的回调。
    try {
      const wasPlaying = isPlaying.value
      const useCrossfade =
        !iosBackgroundSafeAudio && settings.value.smoothTrackChange && wasPlaying && shouldPlay
      const slot = findSlotByTrack(track) ?? preloadSlots[requestedDirection]
      const direction = slot.direction

      if (waitForReady) {
        const ready =
          slot.track?.id === track.id && slot.track.audioUrl === track.audioUrl
            ? await (slot.ready ?? Promise.resolve(slotCanStart(slot, track)))
            : await loadSlot(direction, track)
        if (!transition.isCurrent(controller)) return false
        if (!ready) {
          clearFailedTrack(track.id)
          if (!backend.active().ended()) {
            store.errorMessage = describePlaybackFailure('network')
            transition.release(controller)
            return false
          }
          // The previous song has ended. Commit the intended next song so its
          // ordinary startup/recovery path owns offline waiting and retry.
          clearSlot(slot)
          slot.track = track
          slot.ready = null
          slot.channel.setGain(0)
          slot.channel.load(track.audioUrl)
        }
      } else if (
        slot.track?.id !== track.id ||
        slot.track.audioUrl !== track.audioUrl ||
        !slot.channel.source()
      ) {
        clearSlot(slot)
        slot.track = track
        slot.ready = null
        slot.channel.setGain(0)
        slot.channel.load(track.audioUrl)
        void preloadCover(track.cover)
      }

      // ===== 极简同步阶段:只做通道切换 + reactivity =====
      // 其余工作(syncMediaSession / 旧通道收尾 / 预加载调度)全部推迟到 microtask 之后,
      // 把连点时的感知延迟压到最低。
      for (const channel of channels) cancelGainAnimation(channel)
      const previous = backend.active()
      const previousGain = previous.gain()
      if (useCrossfade) {
        void fadePlayer(previous, previousGain, 0, FADE_OUT_DURATION_MS)
      }

      const { outgoing, oldTrack, incoming, releaseIncomingLyrics } = replaceActiveWithSlot(
        slot,
        direction,
      )
      retiringChannel = outgoing
      const outgoingSource = outgoing.source()
      mountActiveAudioForIOS()
      // 统一收尾被取消的上一次切换遗留的出声通道:旧切换在任务身份检查处
      // 提前 return,跳过了它负责的暂停;而本次开头的 cancelGainAnimation 又会把那一路
      // 进行中的淡出停在半路。除本次这两路外一律静音暂停,保证不会留下还在响的通道。
      for (const channel of channels) {
        if (channel === incoming || channel === outgoing) continue
        cancelGainAnimation(channel)
        channel.pause()
        channel.seek(0)
        channel.setGain(0)
      }
      // 预加载好的那一路本来就在 0,只有必要时才回绕
      if (incoming.currentTime() > 0.01) incoming.seek(0)
      incoming.setGain(useCrossfade ? 0 : 1)
      pendingSeekTime.value = null

      // 同步写入 reactivity：UI 立刻刷新到新歌（标题/封面/进度归零）。
      clearPreloadMessage()
      const previousJourney = store.captureQueueJourney()
      committingSwitch = true
      try {
        updateStore()
      } finally {
        committingSwitch = false
        // LyricsPanel's track watcher joins the shared request before the speculative
        // subscriber is released; the rotated spare slot must no longer own it.
        void nextTick(releaseIncomingLyrics)
      }
      currentTime.value = 0
      duration.value = incoming.duration() ?? 0
      isPlaying.value = shouldPlay
      refreshTargets()
      automaticCrossfadeStarted = false
      transition.release(controller)

      if (!shouldPlay) {
        // 暂停状态切歌：极简同步路径（不需要 play()）
        finishOutgoing(outgoing)
        // 后台刷新 mediaSession + 调度预加载，避免阻塞主流程
        queueMicrotask(() => {
          if (!transition.isCurrent(controller)) return
          syncMediaSession()
          scheduleAdjacentPreload()
        })
        return true
      }

      // 异步启动新音频；不阻塞主流程。
      // mediaSession + 预加载调度推到 microtask，与 play() 启动并行进行。
      queueMicrotask(() => {
        if (!transition.isCurrent(controller)) return
        syncMediaSession()
        scheduleAdjacentPreload()
      })

      let startSettled = false
      const failStart = (error: unknown): void => {
        if (startSettled || !transition.isCurrent(controller)) return
        startSettled = true
        pendingStart = null
        // 先把失败原因归一出来:后面的 clearSlot 会清掉通道的 src,
        // 事后再 classifyFailure 只会得到"没有可用的音频地址"这种不准确的结论
        const reason = incoming.classifyFailure(error)
        if (handleRecoverableFailure(incoming, reason)) return
        // 后端主动中止不拉黑曲目，也不触发失败跳过。
        if (reason === 'aborted') {
          // A CORS element replacement may abort the old startup and then emit
          // play on the same logical channel. Explicit pause/takeover clears this.
          allowInterruptedStart = true
          cancelGainAnimation(incoming)
          cancelGainAnimation(outgoing)
          incoming.setGain(1)
          finishOutgoing(outgoing)
          isPlaying.value = false
          return
        }
        markTrackFailed(track.id)
        const skipOnError = settings.value.skipOnError
        store.errorMessage = describePlaybackFailure(reason)
        incoming.pause()
        cancelGainAnimation(incoming)
        cancelGainAnimation(outgoing)
        const canFallBack = Boolean(
          oldTrack &&
          outgoing.source() === outgoingSource &&
          store.queue.some((candidate) => candidate.id === oldTrack.id),
        )
        if (skipOnError && canFallBack && oldTrack) {
          // 先迁移槽位再提交 store，避免同步 watcher 把出声通道当成预加载释放。
          const reverseSlot = preloadSlots[direction === 'next' ? 'previous' : 'next']
          reverseSlot.cleanup?.()
          backend.setActive(outgoing)
          notifyLyricsPlayback()
          retiringChannel = null
          outgoing.setGain(1)
          reverseSlot.channel = incoming
          reverseSlot.track = null
          reverseSlot.ready = null
          clearSlot(reverseSlot)
          committingSwitch = true
          try {
            store.restoreQueueJourney(previousJourney, oldTrack)
          } finally {
            committingSwitch = false
          }
          currentTime.value = outgoing.currentTime()
          duration.value = outgoing.duration() ?? 0
          refreshTargets()
          mountActiveAudioForIOS()
        } else {
          store.restoreQueueJourney(previousJourney, null)
          finishOutgoing(outgoing)
        }
        // 回退已经做完(store 也指回了旧曲目),此刻的 predictNextTrack(true) 才与
        // 随后真正调度的 next(true) 是同一结果。跳过 / 回退 / 停止的取舍交给
        // core/audio/failure,由它保证提示语和实际发生的事一致
        const action = resolveFailureAction(reason, {
          skipOnError,
          hasNextTrack: Boolean(predictNextTrack(true)),
          canFallBack,
        })
        if (action.kind === 'skip') {
          preloadMessage.value = action.notice
          isPlaying.value = shouldPlay
          schedulePlayerTimeout(() => void next(true), 0)
        } else if (action.kind === 'fall-back') {
          // 显式恢复旧通道；失败原因保留为提示，避免成功播放后被清空。
          preloadMessage.value = action.notice
          isPlaying.value = shouldPlay
          if (shouldPlay) void play()
        } else {
          preloadMessage.value = ''
          finishOutgoing(outgoing)
          isPlaying.value = false
        }
      }
      pendingStart = { channel: incoming, fail: failStart }
      void incoming
        .play()
        .then(() => {
          // 启动期间用户又点了别的歌：本次播放作废，让新流程接管收尾
          if (startSettled || !transition.isCurrent(controller)) return
          startSettled = true
          pendingStart = null
          // 播放成功即解除失败标记：手动点选曾被拉黑的曲目时立即恢复
          clearFailedTrack(track.id)
          currentTime.value = incoming.currentTime()
          duration.value = incoming.duration() ?? 0
          isPlaying.value = true
          store.errorMessage = ''
          guardedStartBeatAnalysis()
          if (useCrossfade && retiringChannel === outgoing) {
            const fadeInPromise =
              waitForReady && outgoing !== incoming
                ? crossfadePlayers(outgoing, incoming)
                : fadePlayer(incoming, 0, 1, FADE_IN_DURATION_MS)
            void fadeInPromise.then((completed) => {
              if (!completed || !transition.isCurrent(controller)) return
              finishOutgoing(outgoing)
            })
          } else {
            finishOutgoing(outgoing)
          }
        })
        .catch(failStart)

      return true
    } finally {
      // 只有当前任务能释放锁，过期任务的 finally 不得干扰后续切歌。
      transition.release(controller)
    }
  }

  async function selectAndPlay(track: Track, queue: Track[]): Promise<void> {
    if (
      tabSync?.command({
        action: 'select',
        trackId: track.id,
        queueIds: queue.map((item) => item.id),
      })
    )
      return
    invalidatePlayback()
    await switchToTrack(track, {
      shouldPlay: true,
      direction: 'next',
      waitForReady: false,
      updateStore: () => store.selectTrack(track, queue),
    })
  }

  async function selectQueuedAndPlay(track: Track): Promise<void> {
    if (tabSync?.command({ action: 'select', trackId: track.id })) return
    if (!store.queue.some((item) => item.id === track.id)) return
    invalidatePlayback()
    await switchToTrack(track, {
      shouldPlay: true,
      direction: 'next',
      waitForReady: false,
      updateStore: () => store.selectQueuedTrack(track),
    })
  }

  async function next(manual = true) {
    if (manual && tabSync?.command({ action: 'next' })) return
    if (manual) invalidatePlayback()
    const track = predictNextTrack(manual)
    if (!track) {
      pause()
      seek(0)
      return
    }
    await switchToTrack(track, {
      shouldPlay: isPlaying.value,
      direction: 'next',
      waitForReady: !manual,
      updateStore: () => store.nextTrack(manual, track.id),
    })
  }

  async function previous() {
    if (tabSync?.command({ action: 'previous' })) return
    invalidatePlayback()
    if (previousMeansRestart(backend.active().currentTime())) {
      listening.restartVisit()
      seek(0)
      return
    }
    const candidate = store.peekPrevious(isTrackFailed)
    if (candidate) {
      await switchToTrack(candidate, {
        shouldPlay: isPlaying.value,
        direction: 'previous',
        waitForReady: false,
        updateStore: () => store.previousTrack(candidate.id),
      })
    }
  }

  const mediaSession = createMediaSession({
    currentTrack: () => currentTrack.value,
    isPlaying: () => isPlaying.value,
    currentTime: () => getLyricsPlaybackState().timeSeconds,
    play,
    pause,
    seek,
    next,
    previous,
  })
  const syncMediaSession = mediaSession.sync

  watch(
    () => [currentTrack.value, currentTrack.value?.audioUrl] as const,
    ([track], previousValue) => {
      if (followingTab.value) return
      const previousTrack = previousValue?.[0]
      if (detachedTabPosition.value !== null && previousTrack?.id === track?.id) return
      detachedTabPosition.value = null
      if (!track) {
        stopPlaybackForMissingTrack()
        return
      }
      if (committingSwitch) return
      let resolvedUrl: string
      try {
        resolvedUrl = new URL(track.audioUrl, window.location.href).href
      } catch {
        // 畸形 audioUrl:new URL 抛 TypeError,不能让 watch 回调中断整个 reactivity 链。
        // 标记失败让后续 next/previous 自动跳过,并给出可见错误而不是静默卡住。
        markTrackFailed(track.id)
        store.errorMessage = '当前歌曲没有可用的音频地址'
        return
      }
      if (backend.active().source() === resolvedUrl && previousTrack?.id === track.id) return
      invalidatePlayback()
      mountActiveAudioForIOS()
      backend.active().load(track.audioUrl)
      refreshTargets()
      automaticCrossfadeStarted = false
      // 切换到全新音频源时旧的 pending seek 时间也要丢弃
      pendingSeekTime.value = null
      const resume = store.getResumePosition(track)
      if (resume !== null) {
        backend.active().seek(resume)
        currentTime.value = resume
        pendingSeekTime.value = backend.active().duration() === null ? resume : null
      }
      syncMediaSession()
      scheduleAdjacentPreload()
      if (previousTrack && isPlaying.value) void play()
    },
    { immediate: true, flush: 'sync' },
  )

  watch(
    () => settings.value.volume,
    (volume) => {
      // 总音量作用于所有通道:正在淡入淡出的那一路也要按新的总音量重算
      backend.setMasterVolume(volume)
    },
    { immediate: true },
  )
  watch(
    () => settings.value.playMode,
    () => {
      if (transition.isPreparing()) invalidatePlayback()
      clearPreloads()
      scheduleAdjacentPreload()
    },
    { flush: 'sync' },
  )
  watch(
    () => settings.value.preloadNextTrack,
    (enabled) => {
      if (!enabled) {
        if (transition.isPreparing()) invalidatePlayback()
        clearPreloads()
      } else scheduleAdjacentPreload()
    },
    { flush: 'sync' },
  )
  watch(
    () => store.queueVersion,
    () => {
      if (followingTab.value) return
      if (!committingSwitch) invalidatePlayback()
      clearPreloads()
      scheduleAdjacentPreload()
    },
    { flush: 'sync' },
  )
  watch(isPlaying, syncMediaSession)
  watch([isPlaying, () => currentTrack.value?.audioUrl], notifyLyricsPlayback, { flush: 'post' })

  function handleTimeUpdate(channel: AudioChannel) {
    if (followingTab.value || detachedTabPosition.value !== null || channel !== backend.active())
      return
    if (pendingSeekTime.value === null) currentTime.value = channel.currentTime()
    const nextSlot = preloadSlots.next
    if (
      isPlaying.value &&
      shouldStartAutoCrossfade(channel.currentTime(), channel.duration(), {
        smoothTrackChange: settings.value.smoothTrackChange,
        nextTrackReady: Boolean(nextSlot.track && slotCanStart(nextSlot, nextSlot.track)),
        alreadyStarted: automaticCrossfadeStarted,
        // iOS 后台安全模式只有一路出声,不能提前叠着放
        supportsOverlap: backend.supportsOverlap(),
      })
    ) {
      automaticCrossfadeStarted = true
      void next(false)
    }
    mediaSession.syncPosition(channel.currentTime(), channel.duration())
  }

  // 每一路通道的订阅。通道是稳定句柄,后端内部换实现时这些订阅照常有效,
  // 不需要像以前那样在重建元素后重新绑一遍
  const channelSubscriptions: Array<() => void> = []

  function bindChannel(channel: AudioChannel) {
    const isActive = () =>
      !followingTab.value && detachedTabPosition.value === null && channel === backend.active()

    const syncDuration = () => {
      if (!isActive()) return
      duration.value = channel.duration() ?? 0
      flushPendingSeek(channel)
      notifyLyricsPlayback()
    }

    channelSubscriptions.push(
      channel.on('timeupdate', () => handleTimeUpdate(channel)),
      channel.on('durationchange', () => {
        if (!isActive()) return
        syncDuration()
        scheduleAdjacentPreload()
      }),
      channel.on('loadedmetadata', syncDuration),
      channel.on('canplay', () => {
        if (isActive()) {
          clearWaitingTimeout()
          scheduleAdjacentPreload()
        }
      }),
      channel.on('play', () => {
        if (followingTab.value || detachedTabPosition.value !== null) {
          channel.pause()
          return
        }
        if (isActive() && isPlaying.value && coordination.canPersist()) coordination.claim()
        if (isActive() && ((!isPlaying.value && !allowInterruptedStart) || !coordination.owns())) {
          channel.pause()
          return
        }
        if (isActive()) {
          allowInterruptedStart = false
          isPlaying.value = true
        }
      }),
      channel.on('playing', () => {
        if (followingTab.value || detachedTabPosition.value !== null) {
          channel.pause()
          return
        }
        if (isActive() && isPlaying.value && coordination.canPersist()) coordination.claim()
        if (isActive() && ((!isPlaying.value && !allowInterruptedStart) || !coordination.owns())) {
          channel.pause()
          return
        }
        waitingChannels.delete(channel)
        if (isActive() && allowInterruptedStart) {
          allowInterruptedStart = false
          isPlaying.value = true
        }
        if (isActive()) clearWaitingTimeout()
        if (isActive()) recovery.settled()
        if (isActive()) guardedStartBeatAnalysis()
        if (isActive()) notifyLyricsPlayback()
      }),
      channel.on('waiting', () => {
        waitingChannels.add(channel)
        if (isActive()) watchStarvedPlayback(channel)
        if (isActive()) notifyLyricsPlayback()
        if (isActive()) tabSync?.publish(true)
      }),
      channel.on('emptied', () => {
        waitingChannels.delete(channel)
        if (isActive()) notifyLyricsPlayback()
      }),
      channel.on('pause', () => {
        if (!isActive() || transition.isPreparing() || recovery.active()) return
        // 自然播完时浏览器先派 pause 再派 ended:这里若把 isPlaying 置 false,
        // ended 里的 next(false) 会以 shouldPlay=false 切歌但不播放。
        // 手动暂停走 pause() 直接置位,不受这条守卫影响
        if (channel.ended()) return
        isPlaying.value = false
        stopBeatAnalysis()
      }),
      channel.on('ended', () => {
        if (!isActive() || transition.isPreparing() || !isPlaying.value || !coordination.owns())
          return
        if (settings.value.playMode === 'single') {
          replayCurrentTrack()
          return
        }
        void next(false)
      }),
      channel.on('error', () => {
        if (!isActive() || !coordination.canPersist()) return
        handleActiveChannelError(channel)
      }),
    )
    for (const event of [
      'timeupdate',
      'play',
      'pause',
      'ended',
      'seeking',
      'seeked',
      'ratechange',
      'canplay',
      'loadeddata',
      'error',
    ] as const) {
      channelSubscriptions.push(
        channel.on(event, () => {
          if (event === 'canplay' || event === 'loadeddata') waitingChannels.delete(channel)
          if (isActive()) notifyLyricsPlayback()
          if (isActive() && event !== 'timeupdate') tabSync?.publish(true)
        }),
      )
    }
  }

  function handleActiveChannelError(channel: AudioChannel) {
    // 同一次启动的媒体 error 与 play rejection 共用一次失败处理。
    if (pendingStart?.channel === channel) {
      pendingStart.fail(new Error('media error'))
      return
    }
    const reason = channel.classifyFailure(new Error('media error'))
    if (handleRecoverableFailure(channel, reason)) return
    const failedTrack = currentTrack.value
    // 过渡期间失败也要释放锁,否则后续所有切歌都会被永久挡在入口
    const wasTransitioning = transition.isPreparing()
    invalidatePlayback()
    automaticCrossfadeStarted = false
    if (failedTrack) markTrackFailed(failedTrack.id)
    if (wasTransitioning) {
      console.warn('[useAudioPlayer] 切歌过程中当前音频出错', failedTrack?.id ?? '(无曲目)')
    }
    // 决策必须与随后调度的 next(false) 得出同一结果:先标记失败再预测后继,
    // 否则单曲循环下会预测到刚被拉黑的当前曲目,提示"正在继续播放"而实际已经停了
    const action = resolveFailureAction(reason, {
      skipOnError: Boolean(failedTrack) && settings.value.skipOnError,
      hasNextTrack: Boolean(predictNextTrack(false)),
      // 出错的就是正在出声的这一路,没有"刚才那一首"可以退回去
      canFallBack: false,
    })
    if (action.kind === 'skip') {
      preloadMessage.value = action.notice
      store.errorMessage = ''
      schedulePlayerTimeout(() => void next(false), 80)
    } else {
      pause()
      // 不跳过时透传真实原因(网络/解码/源不支持),别让播放器静默停住
      store.errorMessage = describePlaybackFailure(reason)
    }
  }

  for (const channel of channels) bindChannel(channel)
  mountActiveAudioForIOS()

  tabSync = createPlaybackSync({
    coordinator: coordination,
    getSnapshot: () => {
      const track = currentTrack.value
      if (!track) return null
      const clock = getLyricsPlaybackState()
      return {
        track,
        position: pendingSeekTime.value ?? clock.timeSeconds,
        duration: duration.value,
        playing: isPlaying.value,
        advancing: clock.playing,
        playbackRate: clock.playbackRate,
        seeking: clock.seeking,
      }
    },
    onSnapshot(state) {
      if (!followingTab.value) {
        followingTab.value = true
        listening.flush()
        pauseLocal()
        for (const channel of channels) channel.release()
        pendingSeekTime.value = null
        detachedTabPosition.value = null
      }
      store.setSyncedTrack(state.track)
      store.clearResume()
      currentTime.value = state.position
      duration.value = state.duration
      isPlaying.value = state.playing
      store.errorMessage = ''
      preloadMessage.value = ''
      notifyLyricsPlayback()
      syncMediaSession()
      mediaSession.syncPosition(state.position, state.duration)
    },
    onTick(state) {
      currentTime.value = state.position
    },
    onStop(state) {
      // Leaving sync or losing the owner never starts audio without a user gesture.
      pauseLocal()
      detachedTabPosition.value = state.position
      followingTab.value = false
      currentTime.value = state.position
      pendingSeekTime.value = null
      notifyLyricsPlayback()
    },
    async onCommand(command) {
      switch (command.action) {
        case 'play':
          await play()
          break
        case 'pause':
          pause()
          break
        case 'seek':
          seek(command.position)
          break
        case 'next':
          await next()
          break
        case 'previous':
          await previous()
          break
        case 'select': {
          const track = store.tracks.find((item) => item.id === command.trackId)
          if (!track) break
          if (command.queueIds) {
            const byId = new Map(store.tracks.map((item) => [item.id, item]))
            const queue = command.queueIds
              .map((id) => byId.get(id))
              .filter((item): item is Track => !!item)
            await selectAndPlay(track, queue)
          } else await selectQueuedAndPlay(track)
          break
        }
      }
    },
  })
  watch(
    () => [settings.value.tabCoordination, settings.value.syncTabPlayback] as const,
    ([coordinated, sync]) => {
      if (!coordinated || !sync) tabSync?.setEnabled(false)
      coordination.setEnabled(coordinated)
      if (coordinated && isPlaying.value && !followingTab.value) coordination.claim()
      tabSync?.setEnabled(coordinated && sync)
    },
    { immediate: true, flush: 'post' },
  )
  watch([currentTrack, isPlaying, duration], () => tabSync?.publish(true), { flush: 'post' })

  const saveSession = () => {
    if (!coordination.canPersist()) return
    if (pendingSeekTime.value === null && currentTrack.value) {
      const channel = backend.active()
      try {
        if (channel.source() === new URL(currentTrack.value.audioUrl, window.location.href).href)
          currentTime.value = channel.currentTime()
      } catch {
        /* Invalid sources are handled by the track watcher. */
      }
    }
    store.persistPlaybackSession()
  }
  const handlePageHide = (): void => {
    saveSession()
    listening.flush()
    tabSync?.release()
    coordination.release()
    pauseLocal()
  }
  window.addEventListener('pagehide', handlePageHide)

  onBeforeUnmount(() => {
    try {
      window.removeEventListener('pagehide', handlePageHide)
      saveSession()
      listening.flush()
      tabSync?.dispose()
      coordination.dispose()
      disposed = true
      recovery.dispose()
      lyricPlaybackListeners.clear()
      waitingChannels.clear()
      invalidatePlayback()

      // 清理所有挂起的 timeout
      const timeoutsToClear = Array.from(pendingPlayerTimeouts)
      for (const timeout of timeoutsToClear) {
        try {
          window.clearTimeout(timeout)
        } catch (error) {
          console.warn('Failed to clear timeout:', error)
        }
      }
      pendingPlayerTimeouts.clear()

      // 停止节拍分析
      stopBeatAnalysis()

      // 停掉所有淡入淡出与它们占用的动画帧
      for (const channel of channels) cancelGainAnimation(channel)
      clearGainAnimationFrames()

      // 退订通道事件
      for (const stop of channelSubscriptions) {
        try {
          stop()
        } catch (error) {
          console.warn('退订通道事件失败:', error)
        }
      }
      channelSubscriptions.length = 0

      // 后端自己负责停播、清源、拆掉 iOS 宿主
      try {
        backend.dispose()
      } catch (error) {
        console.warn('释放播放后端失败:', error)
      }

      mediaSession.dispose()
    } catch (error) {
      console.error('Error during cleanup:', error)
    }
  })

  return {
    beatLevel,
    listeningStats: listening.stats,
    clearListeningHistory: listening.clear,
    getPlaybackSeconds: () => getLyricsPlaybackState().timeSeconds,
    getLyricsPlaybackState,
    subscribeLyricsPlayback,
    beatBuildStatus: preanalysis.status,
    beatDebug: debugSnapshot ?? shallowRef(null),
    beatSchedulerDebug: preanalysis.debugSnapshot ?? shallowRef(null),
    beatComparison: beatComparison.snapshot,
    canCompareBeats: beatComparison.canStart,
    startBeatComparison: beatComparison.start,
    stopBeatComparison: beatComparison.stop,
    beatComparisonRecording: beatComparison.recordingStats,
    exportBeatComparison,
    beatComparisonExporting: comparisonDownload.exporting,
    beatComparisonExportError: comparisonDownload.error,
    audioPreloadDebug: audioPreloadDebug.state,
    retryBeatBuild: preanalysis.retry,
    spectrumLevels,
    spectrumAvailable,
    preloadMessage,
    play,
    pause,
    toggle,
    seek,
    next,
    previous,
    selectAndPlay,
    selectQueuedAndPlay,
  }
}
