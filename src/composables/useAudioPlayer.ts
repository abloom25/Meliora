import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { usePlayerStore } from '../stores/player'
import type { Track } from '../core/types'
import type { AudioChannel } from '../core/audio/backend'
import { shouldUseIOSBackgroundSafeAudio } from '../platform/web/browser'
import { createWebAudioBackend } from '../platform/web/audio-backend'
import {
  CROSSFADE_DURATION_MS,
  FADE_IN_DURATION_MS,
  FADE_OUT_DURATION_MS,
  crossfadeGains,
  fadeGain,
  fadeProgress,
} from '../core/audio/fade'
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
import { MEDIA_SESSION_ACTIONS } from '../../shared/constants'

type PlayerState = 'idle' | 'switching'

export interface UseAudioPlayerOptions {
  /**
   * 可选：返回需要每帧同步 `--beat-level` CSS 变量的目标节点列表。
   * 仅作为透传给 useBeatAnalyser 的 getBeatTargets。
   */
  getBeatTargets?: () => readonly (HTMLElement | null | undefined)[]
  /**
   * 可选：返回队列小频谱 meter 节点(`--spectrum-level-N` 写入目标)。
   * 仅作为透传给 useBeatAnalyser 的 getSpectrumTargets。
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
  const playerState = ref<PlayerState>('idle')
  let automaticCrossfadeStarted = false
  // 按通道独立的动画标识:同一路上后启动的淡入淡出会取消前一个,
  // 但不同通道互不干扰 —— 旧曲目的淡出不会被新曲目的淡入取消,
  // 否则手动切歌时旧音频来不及衰减就会与新的叠着响。
  // 计数器从 1 起,0 表示"无动画/已取消"。
  const gainAnimations = new WeakMap<AudioChannel, number>()
  const gainAnimationFrames = new Set<number>()
  let switchAbortController: AbortController | null = null
  const pendingPlayerTimeouts = new Set<number>()
  // 当 active audio 还没有有效 duration 时，记录用户请求的 seek 时间，
  // 等到 durationchange / loadedmetadata 后再真正写入 audio.currentTime。
  const pendingSeekTime = ref<number | null>(null)
  let beatAnalysisDegraded = false
  // iOS 后台安全模式或 CORS 降级后没有节拍分析:队列小频谱应回退显示序号,
  // 而不是一排静止的柱子
  const spectrumAvailable = ref(!iosBackgroundSafeAudio)
  let degradationWarned = false

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

  function mountActiveAudioForIOS() {
    backend.prepareActive()
  }

  const { bindFilters: bindEqFilters } = useEqualizer({ settings })
  const { beatLevel, spectrumLevels, startBeatAnalysis, stopBeatAnalysis } = useBeatAnalyser({
    // 频谱要真实元素,这是 Web 后端的专有出口
    players: channels.map((channel) => backend.elementOf(channel)),
    getActiveAudio: () => backend.elementOf(backend.active()),
    isPlaying,
    beatFlashRate: computed(() => settings.value.beatFlashRate),
    beatVisualDelay: computed(() => settings.value.beatVisualDelay),
    getBeatTargets: options.getBeatTargets,
    getSpectrumTargets: options.getSpectrumTargets,
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
    transitionInProgress: () => playerState.value !== 'idle',
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

  // 取消某一路正在进行的淡入淡出:把它的 animationId 归零,
  // 挂起的 rAF step 在下一帧自检时就会提前结束
  function cancelGainAnimation(channel: AudioChannel) {
    gainAnimations.set(channel, 0)
  }

  function clearGainAnimationFrames() {
    // 创建副本以避免在迭代过程中修改集合
    const framesToCancel = Array.from(gainAnimationFrames)
    for (const frame of framesToCancel) {
      try {
        window.cancelAnimationFrame(frame)
      } catch (error) {
        // 忽略无效的 frame ID，防止清理过程本身出错
        console.warn('Failed to cancel animation frame:', error)
      }
    }
    gainAnimationFrames.clear()
  }

  function requestGainAnimationFrame(callback: FrameRequestCallback) {
    const frame = window.requestAnimationFrame((now) => {
      gainAnimationFrames.delete(frame)
      callback(now)
    })
    gainAnimationFrames.add(frame)
  }

  // updaters 收到的是**原始进度**(0…1),缓动曲线由 core/audio/fade 施加,
  // 保证 Web 与桌面端的淡入淡出手感一致
  function animateGain(
    targets: AudioChannel[],
    updaters: Array<(progress: number) => void>,
    duration: number,
  ): Promise<void> {
    const animationId = Math.max(1, ...targets.map((c) => (gainAnimations.get(c) ?? 0) + 1))
    for (const c of targets) gainAnimations.set(c, animationId)
    const startedAt = performance.now()
    return new Promise<void>((resolve) => {
      function applyAll(progress: number) {
        for (const update of updaters) update(progress)
      }

      function step(now: number) {
        // 任一涉及通道被新动画接管即整体停止;0 表示被 cancelGainAnimation 显式取消。
        if (targets.some((c) => gainAnimations.get(c) !== animationId)) {
          resolve()
          return
        }
        const raw = fadeProgress(now - startedAt, duration)
        applyAll(raw)

        if (raw >= 1) {
          resolve()
          return
        }
        if (document.hidden) {
          applyAll(1)
          resolve()
          return
        }
        requestGainAnimationFrame(step)
      }

      if (document.hidden) {
        applyAll(1)
        resolve()
        return
      }
      requestGainAnimationFrame(step)
    })
  }

  function crossfadePlayers(outgoing: AudioChannel, incoming: AudioChannel) {
    return animateGain(
      [outgoing, incoming],
      [
        (progress) => outgoing.setGain(crossfadeGains(progress).outgoing),
        (progress) => incoming.setGain(crossfadeGains(progress).incoming),
      ],
      CROSSFADE_DURATION_MS,
    ).then(() => {
      outgoing.setGain(0)
      incoming.setGain(1)
    })
  }

  function fadePlayer(channel: AudioChannel, fromGain: number, toGain: number, duration: number) {
    return animateGain(
      [channel],
      [(progress) => channel.setGain(fadeGain(fromGain, toGain, progress))],
      duration,
    ).then(() => {
      channel.setGain(toGain)
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
    for (const channel of channels) {
      cancelGainAnimation(channel)
      channel.release()
      channel.setGain(0)
    }
    backend.setActive(channels[0]!)
    backend.active().setGain(1)
    playerState.value = 'idle'
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
    if (playerState.value !== 'idle') return false
    playerState.value = 'switching'
    // try/finally 兜底:同步体或 waitForReady 的 await 期间若抛出任何异常,
    // 必须把 playerState 复位为 idle,否则后续所有 next/previous 在入口处
    // 早返回(playerState !== 'idle'),播放器将永久砖化至刷新。
    const controller = createSwitchAbort()
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
        if (!ready || isSwitchAborted(controller)) {
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
          }
          playerState.value = 'idle'
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
      playerState.value = 'idle'

      if (!shouldPlay) {
        // 暂停状态切歌：极简同步路径（不需要 play()）
        outgoing.pause()
        outgoing.seek(0)
        outgoing.setGain(0)
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

      incoming
        .play()
        .then(() => {
          // 启动期间用户又点了别的歌：本次播放作废，让新流程接管收尾
          if (isSwitchAborted(controller)) return
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
              if (isSwitchAborted(controller)) return
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
          if (isSwitchAborted(controller)) return
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
      // 兜底复位:正常路径已在上方将 playerState 置回 'idle';
      // 此处仅捕获抛出异常时残留的 'switching' 状态,防止播放器砖化。
      if (playerState.value === 'switching') playerState.value = 'idle'
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

  watch(
    currentTrack,
    (track, previousTrack) => {
      if (!track) {
        stopPlaybackForMissingTrack()
        return
      }
      if (playerState.value !== 'idle') return
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
    const total = channel.duration()
    if ('mediaSession' in navigator && total !== null) {
      try {
        navigator.mediaSession.setPositionState({
          duration: total,
          playbackRate: 1,
          position: Math.min(channel.currentTime(), total),
        })
      } catch {
        // 切歌过程中浏览器可能拒绝位置更新
      }
    }
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
        if (!isActive() || playerState.value !== 'idle') return
        // 自然播完时浏览器先派 pause 再派 ended:这里若把 isPlaying 置 false,
        // ended 里的 next(false) 会以 shouldPlay=false 切歌但不播放。
        // 手动暂停走 pause() 直接置位,不受这条守卫影响
        if (channel.ended()) return
        isPlaying.value = false
        stopBeatAnalysis()
      }),
      channel.on('ended', () => {
        if (!isActive() || playerState.value !== 'idle') return
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
    const wasTransitioning = playerState.value !== 'idle'
    playerState.value = 'idle'
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
      seek(backend.active().currentTime() - (details.seekOffset || 10)),
    )
    safeSetActionHandler('seekforward', (details) =>
      seek(backend.active().currentTime() + (details.seekOffset || 10)),
    )
  }

  onBeforeUnmount(() => {
    try {
      // 清理 AbortController
      switchAbortController?.abort()
      switchAbortController = null

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

      // 清理 Media Session
      if ('mediaSession' in navigator) {
        for (const action of MEDIA_SESSION_ACTIONS) {
          try {
            navigator.mediaSession.setActionHandler(action, null)
          } catch {
            // 某些浏览器对部分 action 不支持，setActionHandler(action, null) 会抛错，忽略即可。
          }
        }
      }
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
