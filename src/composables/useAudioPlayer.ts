import { createBeatVisualRenderer } from '../platform/web/beat-visuals'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePlayerStore } from '../stores/player'
import type { Track } from '../core/types'
import type { AudioChannel } from '../core/audio/backend'
import { shouldUseIOSBackgroundSafeAudio } from '../platform/web/browser'
import { createWebAudioBackend } from '../platform/web/audio-backend'
import { describePlaybackFailure, resolveFailureAction } from '../core/audio/failure'
import { previousMeansRestart, resolveSeek, shouldStartAutoCrossfade } from '../core/audio/timeline'
import { useBeatAnalyser } from '../platform/web/useBeatAnalyser'
import { useEqualizer } from './useEqualizer'
import {
  usePreloadPool,
  preloadCover,
  preloadLyrics,
  type PreloadDirection,
  type PreloadSlot,
} from './usePreloadPool'
import { FADE_IN_DURATION_MS, FADE_OUT_DURATION_MS } from '../core/audio/fade'
import { createAudioGain } from '../platform/web/audio-gain'
import { createPlaybackTransition } from '../platform/web/playback-transition'
import { createMediaSession } from '../platform/web/media-session'

export interface UseAudioPlayerOptions {
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
  const pendingPlayerTimeouts = new Set<number>()
  // 当 active audio 还没有有效 duration 时，记录用户请求的 seek 时间，
  // 等到 durationchange / loadedmetadata 后再真正写入 audio.currentTime。
  const pendingSeekTime = ref<number | null>(null)
  let beatAnalysisDegraded = false
  // iOS 后台安全模式或 CORS 降级后没有节拍分析:队列小频谱应回退显示序号,
  // 而不是一排静止的柱子
  const spectrumAvailable = ref(!iosBackgroundSafeAudio)
  let degradationWarned = false

  function schedulePlayerTimeout(callback: () => void, delay: number): number {
    const handle = window.setTimeout(() => {
      pendingPlayerTimeouts.delete(handle)
      callback()
    }, delay)
    pendingPlayerTimeouts.add(handle)
    return handle
  }

  function mountActiveAudioForIOS() {
    backend.prepareActive()
  }

  const { bindFilters: bindEqFilters } = useEqualizer({ settings })
  const beatVisuals = createBeatVisualRenderer(options)
  const { beatLevel, spectrumLevels, startBeatAnalysis, stopBeatAnalysis } = useBeatAnalyser({
    // 频谱要真实元素,这是 Web 后端的专有出口
    players: channels.map((channel) => backend.elementOf(channel)),
    getActiveAudio: () => backend.elementOf(backend.active()),
    isPlaying,
    beatFlashRate: computed(() => settings.value.beatFlashRate),
    beatVisualDelay: computed(() => settings.value.beatVisualDelay),
    onBeat: beatVisuals.renderBeat,
    onSpectrum: beatVisuals.renderSpectrum,
    onEqFiltersReady: bindEqFilters,
    onTainted: (audio) => {
      backend.degradeForTaint(audio)
      degradeBeatAnalysis()
    },
  })

  const {
    preloadSlots,
    preloadMessage,
    failureLog,
    markTrackFailed,
    clearFailedTrack,
    isTrackFailed,
    predictNextTrack,
    clearPreloads,
    resetSlotChannels,
    clearSlot,
    clearPreloadMessage,
    findSlotByTrack,
    slotCanStart,
    loadSlot,
    scheduleAdjacentPreload,
  } = usePreloadPool({
    backend,
    store,
    settings,
    transitionInProgress: () => transition.isPreparing(),
  })

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
    transition.cancel()
    for (const channel of channels) {
      cancelGainAnimation(channel)
      channel.release()
      channel.setGain(0)
    }
    backend.setActive(channels[0]!)
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

  async function play() {
    if (!currentTrack.value) {
      const first = store.queue[0] ?? store.tracks[0]
      if (!first) return
      store.selectTrack(first, store.queue.length ? store.queue : store.tracks)
      await Promise.resolve()
    }
    try {
      backend.active().setGain(1)
      await backend.active().play()
      isPlaying.value = true
      store.errorMessage = ''
      guardedStartBeatAnalysis()
    } catch (error) {
      isPlaying.value = false
      store.errorMessage = describePlaybackError(error, backend.active())
    }
  }

  function pause() {
    for (const channel of channels) cancelGainAnimation(channel)
    for (const channel of channels) channel.pause()
    isPlaying.value = false
  }

  function toggle() {
    if (isPlaying.value) pause()
    else void play()
  }

  function replayCurrentTrack() {
    if (!currentTrack.value) return
    automaticCrossfadeStarted = false
    pendingSeekTime.value = null
    backend.active().seek(0)
    currentTime.value = 0
    void play()
  }

  function seek(time: number) {
    // 时长未知时通道会自己记下目标位置、等时长可用再落位;
    // 界面要立刻反映用户意图,所以两种结果都同步 currentTime
    const channel = backend.active()
    const resolution = resolveSeek(time, channel.duration())
    if (resolution.kind === 'ignore') return
    channel.seek(resolution.time)
    currentTime.value = resolution.time
    pendingSeekTime.value = resolution.kind === 'pending' ? resolution.time : null
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
    backend.setActive(incoming)
    slot.channel = spare
    slot.track = null
    slot.ready = null
    reverseSlot.channel = outgoing
    reverseSlot.track = oldTrack
    reverseSlot.ready = oldTrack ? Promise.resolve(true) : null
    return { outgoing, oldTrack, incoming }
  }

  interface SwitchOptions {
    shouldPlay: boolean
    direction: PreloadDirection
    waitForReady: boolean
    updateStore: () => void
  }

  async function switchToTrack(track: Track, options: SwitchOptions): Promise<boolean> {
    const { shouldPlay, direction, waitForReady, updateStore } = options
    const controller = transition.begin()
    if (!controller) return false
    // 异常时也释放准备阶段；任务身份继续保护异步播放与淡入淡出的回调。
    try {
      const wasPlaying = isPlaying.value
      const useCrossfade =
        !iosBackgroundSafeAudio && settings.value.smoothTrackChange && wasPlaying && shouldPlay
      const slot = findSlotByTrack(track) ?? preloadSlots[direction]

      if (waitForReady) {
        const ready =
          slot.track?.id === track.id
            ? await (slot.ready ?? Promise.resolve(slotCanStart(slot, track)))
            : await loadSlot(direction, track)
        if (!transition.isCurrent(controller)) return false
        if (!ready) {
          markTrackFailed(track.id)
          // 预加载没就绪等同于取不到音频。跳不跳同样交给 core/audio/failure:
          // 先标记失败再预测后继,没有实际后继(如 sequence 播到队尾)时它不会给出
          // skip,提示也就不会与"其实已经停了"打架
          const action = resolveFailureAction('network', {
            // 本来就不打算出声的切换(静默换曲)谈不上"跳过"
            skipOnError: shouldPlay && settings.value.skipOnError,
            hasNextTrack: Boolean(predictNextTrack(false)),
            canFallBack: false,
          })
          if (action.kind === 'skip') {
            preloadMessage.value = action.notice
            schedulePlayerTimeout(() => void next(false), 80)
          }
          transition.release(controller)
          return false
        }
      } else if (slot.track?.id !== track.id || !slot.channel.source()) {
        clearSlot(slot)
        slot.track = track
        slot.ready = null
        slot.channel.setGain(0)
        slot.channel.load(track.audioUrl)
        void preloadCover(track.cover)
        void preloadLyrics(track)
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

      const { outgoing, oldTrack, incoming } = replaceActiveWithSlot(slot, direction)
      mountActiveAudioForIOS()
      // 统一收尾被 abort 的上一次切换遗留的出声通道:被 abort 的切换在 isSwitchAborted 处
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
      updateStore()
      currentTime.value = 0
      duration.value = incoming.duration() ?? 0
      isPlaying.value = shouldPlay
      automaticCrossfadeStarted = false
      transition.release(controller)

      if (!shouldPlay) {
        // 暂停状态切歌：极简同步路径（不需要 play()）
        outgoing.pause()
        outgoing.seek(0)
        outgoing.setGain(0)
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

      incoming
        .play()
        .then(() => {
          // 启动期间用户又点了别的歌：本次播放作废，让新流程接管收尾
          if (!transition.isCurrent(controller)) return
          // 播放成功即解除失败标记：手动点选曾被拉黑的曲目时立即恢复
          clearFailedTrack(track.id)
          currentTime.value = incoming.currentTime()
          duration.value = incoming.duration() ?? 0
          isPlaying.value = true
          store.errorMessage = ''
          if (useCrossfade) {
            const fadeInPromise =
              waitForReady && outgoing !== incoming
                ? crossfadePlayers(outgoing, incoming)
                : fadePlayer(incoming, 0, 1, FADE_IN_DURATION_MS)
            void fadeInPromise.finally(() => {
              if (!transition.isCurrent(controller)) return
              outgoing.pause()
              outgoing.seek(0)
              outgoing.setGain(0)
            })
          } else {
            outgoing.pause()
            outgoing.seek(0)
            outgoing.setGain(0)
          }
        })
        .catch((error) => {
          if (!transition.isCurrent(controller)) return
          // 先把失败原因归一出来:后面的 clearSlot 会清掉通道的 src,
          // 事后再 classifyFailure 只会得到"没有可用的音频地址"这种不准确的结论
          const reason = incoming.classifyFailure(error)
          // 主动取消不算这首歌的失败:启动期间按暂停时,pause() 会让还悬着的 play()
          // 抛 AbortError,而它并不 abort 本次切换(切换本身已经生效),走不到上面的早返回。
          // 若按失败处理,这首歌会被拉黑 5 分钟,还会连带回退/跳到下一首。
          // 通道已被 pause() 停住,这里只需要让播放状态与之对齐。
          if (reason === 'aborted') {
            isPlaying.value = false
            return
          }
          markTrackFailed(track.id)
          const skipOnError = settings.value.skipOnError
          store.errorMessage = describePlaybackFailure(reason)
          incoming.pause()
          if (skipOnError) {
            backend.setActive(outgoing)
            // oldAudio 的 fade-out 可能已把音量压到 ~0(或仍在进行中),
            // 回退期间会"在播但无声";取消其增益动画并恢复满音量。
            cancelGainAnimation(outgoing)
            outgoing.setGain(1)
            // 同步把 store 回退到旧曲目:audio 已回退,若 store 仍指向失败曲目,
            // 当 next(true) 找不到后继时会出现"UI 显示失败曲目、实际播放上一首"的错位。
            // previousTrack 只 setCurrentTrack、不 bump queueVersion,跳过语义不受影响。
            if (oldTrack) store.previousTrack(oldTrack.id)
            mountActiveAudioForIOS()
            const reverseSlot = preloadSlots[direction === 'next' ? 'previous' : 'next']
            reverseSlot.channel = incoming
            reverseSlot.track = null
            reverseSlot.ready = null
            clearSlot(reverseSlot)
          }
          // 回退已经做完(store 也指回了旧曲目),此刻的 predictNextTrack(true) 才与
          // 随后真正调度的 next(true) 是同一结果。跳过 / 回退 / 停止的取舍交给
          // core/audio/failure,由它保证提示语和实际发生的事一致
          const action = resolveFailureAction(reason, {
            skipOnError,
            hasNextTrack: Boolean(predictNextTrack(true)),
            canFallBack: Boolean(oldTrack),
          })
          if (action.kind === 'skip') {
            preloadMessage.value = action.notice
            isPlaying.value = shouldPlay
            schedulePlayerTimeout(() => void next(true), 0)
          } else if (action.kind === 'fall-back') {
            // 已经回退到旧曲目:store 回退会触发 watch 重新加载并播放它,
            // play() 成功后会清空 errorMessage,所以真实原因改走 preloadMessage,
            // 既让用户看得到为什么跳过,也不谎称"正在继续播放"
            preloadMessage.value = action.notice
            isPlaying.value = shouldPlay
          } else {
            preloadMessage.value = ''
            outgoing.pause()
            outgoing.seek(0)
            outgoing.setGain(0)
            isPlaying.value = false
          }
        })

      return true
    } finally {
      // 只有当前任务能释放锁，过期任务的 finally 不得干扰后续切歌。
      transition.release(controller)
    }
  }

  async function selectAndPlay(track: Track, queue: Track[]): Promise<void> {
    await switchToTrack(track, {
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
    await switchToTrack(track, {
      shouldPlay: isPlaying.value,
      direction: 'next',
      waitForReady: !manual,
      updateStore: () => store.nextTrack(manual, track.id),
    })
  }

  async function previous() {
    if (previousMeansRestart(backend.active().currentTime())) {
      seek(0)
      return
    }
    const queue = store.queue
    // 无当前曲目时 currentIndex === -1:明确从队尾(-1 的上一首即队尾)开始往前找,
    // 而不是沿用 (-1-1+len)%len = len-2 的怪异算术(会错误地跳到倒数第二首)。
    const baseIndex = store.currentIndex < 0 ? queue.length : store.currentIndex
    for (let offset = 1; offset <= queue.length; offset += 1) {
      const index = (baseIndex - offset + queue.length) % queue.length
      const candidate = queue[index]
      if (!candidate || isTrackFailed(candidate.id)) continue
      const switched = await switchToTrack(candidate, {
        shouldPlay: isPlaying.value,
        direction: 'previous',
        waitForReady: false,
        updateStore: () => store.previousTrack(candidate.id),
      })
      if (switched) return
    }
  }

  const mediaSession = createMediaSession({
    currentTrack: () => currentTrack.value,
    isPlaying: () => isPlaying.value,
    currentTime: () => backend.active().currentTime(),
    play,
    pause,
    previous,
    next,
    seek,
  })
  const syncMediaSession = mediaSession.sync

  watch(
    currentTrack,
    (track, previousTrack) => {
      if (!track) {
        stopPlaybackForMissingTrack()
        return
      }
      if (transition.isPreparing()) return
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
      if (backend.active().source() === resolvedUrl) return
      mountActiveAudioForIOS()
      backend.active().load(track.audioUrl)
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
    (volume) => {
      // 总音量作用于所有通道:正在淡入淡出的那一路也要按新的总音量重算
      backend.setMasterVolume(volume)
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
      failureLog.clearAll()
      clearPreloads()
      scheduleAdjacentPreload()
    },
  )
  watch(isPlaying, syncMediaSession)

  function handleTimeUpdate(channel: AudioChannel) {
    if (channel !== backend.active()) return
    currentTime.value = channel.currentTime()
    const nextSlot = preloadSlots.next
    if (
      shouldStartAutoCrossfade(channel.currentTime(), channel.duration(), {
        smoothTrackChange: settings.value.smoothTrackChange,
        nextTrackReady: Boolean(nextSlot.track && nextSlot.ready),
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
    const isActive = () => channel === backend.active()

    const syncDuration = () => {
      if (!isActive()) return
      duration.value = channel.duration() ?? 0
      flushPendingSeek(channel)
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
        if (isActive()) scheduleAdjacentPreload()
      }),
      channel.on('play', () => {
        if (!isActive()) return
        isPlaying.value = true
        guardedStartBeatAnalysis()
      }),
      channel.on('pause', () => {
        if (!isActive() || transition.isPreparing()) return
        // 自然播完时浏览器先派 pause 再派 ended:这里若把 isPlaying 置 false,
        // ended 里的 next(false) 会以 shouldPlay=false 切歌但不播放。
        // 手动暂停走 pause() 直接置位,不受这条守卫影响
        if (channel.ended()) return
        isPlaying.value = false
        stopBeatAnalysis()
      }),
      channel.on('ended', () => {
        if (!isActive() || transition.isPreparing()) return
        if (settings.value.playMode === 'single') {
          replayCurrentTrack()
          return
        }
        void next(false)
      }),
      channel.on('error', () => {
        if (!isActive()) return
        handleActiveChannelError(channel)
      }),
    )
  }

  function handleActiveChannelError(channel: AudioChannel) {
    const failedTrack = currentTrack.value
    // 过渡期间失败也要释放锁,否则后续所有切歌都会被永久挡在入口
    const wasTransitioning = transition.isPreparing()
    // 保留已提交任务的身份，让 play() 拒绝时仍可完成旧通道清理和失败回退。
    transition.release()
    automaticCrossfadeStarted = false
    if (failedTrack) markTrackFailed(failedTrack.id)
    if (wasTransitioning) {
      console.warn('[useAudioPlayer] 切歌过程中当前音频出错', failedTrack?.id ?? '(无曲目)')
    }
    // 决策必须与随后调度的 next(false) 得出同一结果:先标记失败再预测后继,
    // 否则单曲循环下会预测到刚被拉黑的当前曲目,提示"正在继续播放"而实际已经停了
    const reason = channel.classifyFailure(new Error('media error'))
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
      // 不跳过时透传真实原因(网络/解码/源不支持),别让播放器静默停住
      store.errorMessage = describePlaybackFailure(reason)
    }
  }

  for (const channel of channels) bindChannel(channel)
  mountActiveAudioForIOS()

  onBeforeUnmount(() => {
    try {
      // 清理 AbortController
      transition.cancel()

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
  }
}
