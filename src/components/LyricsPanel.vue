<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import { usePlayerStore } from '../stores/player'
  import {
    getLyricsSource,
    hasTrackLyricsSource,
    loadTrackLyrics,
    offsetLyrics,
  } from '../services/lyrics'
  import { useSongLyricsPreferences } from '../composables/useSongLyricsPreferences'
  import { createLyricClock } from '../core/lyrics'
  import type { LyricsDebugSnapshot } from '../core/diagnostics/lyrics-debug'
  import { listenMediaQuery } from '../platform/web/media-query'
  import { isApplePlatform } from '../platform/web/browser'
  import { createLyricLineMeasurer } from '../platform/web/lyric-line-layout'
  import { createLyricFrames } from '../platform/web/lyric-frames'
  import { lyricBrowseReturnWait } from '../core/lyrics/browse-return'
  import LyricsWaitingIndicator from './LyricsWaitingIndicator.vue'
  import {
    createLyricTimeline,
    createLyricWaitingTimeline,
    isLyricHarmonyOpen,
    isLyricLineCompleted,
    lyricTempoScale,
    lyricWordCharacters,
    sameLyricScene,
    type LyricScene,
    type LyricWaitingInterval,
  } from '../core/lyrics'
  import { useLyricsEngine, type LyricsTransition } from '../composables/useLyricsEngine'
  import { useLyricsKaraoke } from '../composables/useLyricsKaraoke'
  import { scheduleLyricRender, type LyricPlaybackState } from '../core/lyrics/render-schedule'
  import type {
    LyricAvailability,
    LyricLine,
    LyricStatus,
    LyricsSnapshot,
    Track,
  } from '../core/types'

  const emit = defineEmits<{
    seek: [time: number]
    availability: [availability: LyricAvailability]
    snapshot: [snapshot: LyricsSnapshot]
    debug: [snapshot: LyricsDebugSnapshot | null]
    share: [payload: { track: Track; lines: LyricLine[]; index: number }]
    shareToggle: [index: number]
    shareCancel: []
  }>()
  const props = withDefaults(
    defineProps<{
      active?: boolean
      sharing?: boolean
      sharePreview?: boolean
      selectedIndices?: number[]
      debugEnabled?: boolean
      getLyricsPlaybackState?: () => LyricPlaybackState
      subscribeLyricsPlayback?: (listener: () => void) => () => void
    }>(),
    {
      active: true,
      sharing: false,
      sharePreview: false,
      selectedIndices: () => [],
      debugEnabled: false,
      getLyricsPlaybackState: undefined,
      subscribeLyricsPlayback: undefined,
    },
  )

  // 滚轮 deltaMode 为"行"时每行折算的像素
  const WHEEL_LINE_PX = 40
  // 触摸惯性取松手前这么长时间内的位移算速度
  const FLING_SAMPLE_MS = 90
  // 手指移动不超过这个距离算点按,不进入浏览态
  const TAP_SLOP_PX = 6
  const SHARE_HOLD_MS = 500
  // 没有样式(测试环境)时的行距兜底
  const FALLBACK_GAPS = { gap: 28, harmonyGap: 8 }

  const store = usePlayerStore()
  const applePlatform = isApplePlatform()
  const { currentTrack, currentTrackVersion, currentTime, isPlaying, settings } = storeToRefs(store)
  const lyricPreferences = useSongLyricsPreferences(currentTrack)

  function emptyScene(): LyricScene {
    return { active: [], highlighted: [], held: false, anchor: -1, harmonyOpen: [] }
  }

  // timeupdate 只有约 4Hz,逐字扫光需要每帧的播放位置,这里统一走外推时钟
  const clock = createLyricClock()
  const lines = shallowRef<LyricLine[]>([])
  const rawLines = shallowRef<LyricLine[]>([])
  const rawLinesTrackId = ref<string | null>(null)
  const renderedIndices = shallowRef<readonly number[]>([])
  const renderedLines = computed(() =>
    renderedIndices.value.flatMap((index) => {
      const line = displayedLines.value[index]
      return line ? [{ index, line }] : []
    }),
  )
  let estimatedLineHeight = 40
  let estimatedCharactersPerRow = 30
  // 场景按时间区间整体替换,保留快照引用即可跳过逐帧的活跃行集合比较。
  const scene = shallowRef<LyricScene>(emptyScene())
  // 只在时间轴区间变化时更新，完成态不需要逐帧进入 Vue 响应式。
  const sceneTime = ref(0)
  const waitingInterval = shallowRef<LyricWaitingInterval | null>(null)
  const waitingElement = ref<HTMLElement>()
  const waitingIndicator = ref<InstanceType<typeof LyricsWaitingIndicator>>()
  const playbackRunning = ref(false)
  const status = ref<LyricStatus>('idle')
  const lyricTempo = ref(1)
  const viewport = ref<HTMLElement>()
  const lyricsContent = ref<HTMLElement>()
  const userBrowsing = ref(false)
  const sharingAnchor = ref(0)
  const selectedShareIndices = computed(() => new Set(props.selectedIndices))
  let browseTimer = 0
  let lastBrowseAt = 0
  const frames = createLyricFrames(window)
  const lineMeasurer = createLyricLineMeasurer()
  let paintFrame = 0
  const keyboardIndex = ref<number | null>(null)
  // 行节点直接从 DOM 读:它们在 Transition 的插槽里,由 Transition 自己渲染,
  // 面板自身重渲染时插槽不一定跟着跑,靠 ref 收集会在 onBeforeUpdate 清空后拿不回来
  function lineElements(): HTMLElement[] {
    const content = lyricsContent.value
    return content ? (Array.from(content.children) as HTMLElement[]) : []
  }
  let isPanelMounted = false
  let measureRaf = 0
  let requestId = 0
  let renderFrame = 0
  let renderTimer = 0
  let previousPlayback: { state: LyricPlaybackState; sampledAt: number } | null = null
  let stopPlaybackSubscription: (() => void) | undefined
  let lyricsController: AbortController | null = null
  let resizeObserver: ResizeObserver | null = null
  // 视口尺寸监听只用单一事件源:支持 visualViewport 的平台(移动端)用它,
  // 否则退回 window,避免双事件源重复调度
  const viewportResizeTarget: Window | VisualViewport | null =
    typeof window !== 'undefined' ? (window.visualViewport ?? window) : null
  let stopReducedMotionListener: (() => void) | null = null
  const reducedMotionQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  const prefersReducedMotion = ref(reducedMotionQuery?.matches ?? false)
  let debugTimer = 0
  let debugSampledAt = Number.NEGATIVE_INFINITY
  // 源时间轴换新时才统计；关闭诊断后没有读取者，也不会遍历歌词。
  const debugLineCounts = computed(() => {
    const counts = {
      lineCount: lines.value.length,
      wordLineCount: 0,
      wordCount: 0,
      translationLineCount: 0,
      romanLineCount: 0,
      harmonyLineCount: 0,
    }
    for (const line of lines.value) {
      if (line.words?.length) counts.wordLineCount += 1
      counts.wordCount += line.words?.length ?? 0
      if (line.translation) counts.translationLineCount += 1
      if (line.roman) counts.romanLineCount += 1
      if (line.background) counts.harmonyLineCount += 1
    }
    return counts
  })

  function scheduleDebug() {
    if (!props.debugEnabled || !isPanelMounted || debugTimer) return
    const wait = Math.max(0, 200 - (performance.now() - debugSampledAt))
    debugTimer = window.setTimeout(() => {
      debugTimer = 0
      if (!props.debugEnabled || !isPanelMounted) return
      const sampledAtMs = performance.now()
      const clockSeconds = readClock()
      debugSampledAt = sampledAtMs
      const rows = lines.value
      const engineSnapshot = engine.readDebugSnapshot()
      const stageVisible = props.active && !document.hidden
      emit('debug', {
        sampledAtMs,
        trackId: currentTrack.value?.id ?? null,
        status: status.value,
        source: getLyricsSource(rows) ?? null,
        ...debugLineCounts.value,
        activeIndices: [...scene.value.active],
        activeLines: scene.value.active.slice(0, 3).flatMap((index) => {
          const line = rows[index]
          return line
            ? [
                {
                  index,
                  text: line.text.slice(0, 120),
                  background: Boolean(line.background),
                  timeSeconds: line.time,
                  wordCount: line.words?.length ?? 0,
                },
              ]
            : []
        }),
        mediaSeconds: currentTime.value,
        clockSeconds,
        clockDriftMs: (clockSeconds - currentTime.value) * 1000,
        playing: isPlaying.value,
        panelActive: props.active,
        animationEnabled: animationEnabled(),
        translationEnabled: settings.value.lyricTranslation,
        documentHidden: document.hidden,
        reducedMotion: prefersReducedMotion.value,
        renderLoopRunning: renderFrame !== 0,
        renderSchedule: renderFrame ? 'frame' : renderTimer ? 'timer' : 'idle',
        userBrowsing: userBrowsing.value,
        sceneHeld: scene.value.held,
        engine: engineSnapshot
          ? {
              ...engineSnapshot,
              stagedLineCount: stageVisible ? engineSnapshot.stagedLineCount : 0,
              visibleLineCount: stageVisible ? engineSnapshot.visibleLineCount : 0,
            }
          : null,
      })
    }, wait)
  }

  function clearDebug() {
    window.clearTimeout(debugTimer)
    debugTimer = 0
    emit('debug', null)
  }

  function animationEnabled(): boolean {
    return settings.value.lyricAnimation && !prefersReducedMotion.value
  }

  const displayedLines = computed(() => {
    const translation = settings.value.lyricTranslation
    const roman = settings.value.lyricRomanization
    if (translation && roman) return lines.value
    return lines.value.map((line) => {
      if ((translation || !line.translation) && (roman || !line.roman)) return line
      const copy: LyricLine = { ...line }
      if (!translation) delete copy.translation
      if (!roman) delete copy.roman
      return copy
    })
  })
  const timeline = computed(() => createLyricTimeline(lines.value))
  const waitingTimeline = computed(() => createLyricWaitingTimeline(lines.value))
  const backgroundFlags = computed(() => lines.value.map((line) => Boolean(line.background)))
  const activeSet = computed(() => new Set(scene.value.highlighted))
  const wordCharacters = computed(() =>
    displayedLines.value.map((line) => line.words?.map(lyricWordCharacters) ?? []),
  )
  const lineBreaks = shallowRef<ReadonlyMap<number, readonly number[]>>(new Map())

  function balanceMountedLines(): boolean {
    const content = lyricsContent.value
    if (!content || content.clientWidth <= 0) return false
    const limit =
      Number.parseFloat(getComputedStyle(content).getPropertyValue('--lyric-line-limit')) || 900
    const available = Math.min(limit, content.clientWidth)
    const next = new Map<number, readonly number[]>()
    let changed = false
    for (const element of lineElements()) {
      const index = Number(element.dataset.lyricIndex)
      const words = displayedLines.value[index]?.words
      if (!words?.length) continue
      const breaks = lineMeasurer.measure(
        Array.from(element.querySelectorAll<HTMLElement>('.lyric-word')),
        words,
        available,
      )
      next.set(index, breaks)
      if (breaks.join(',') !== (lineBreaks.value.get(index) ?? []).join(',')) changed = true
    }
    if (changed) lineBreaks.value = next
    return changed
  }
  // 英文长音里的字母只是动画节点，不能因此成为新的换行点。
  // 中文和含空格的短句仍保留原来的自然断行规则。
  const unbrokenWords = computed(() =>
    displayedLines.value.map(
      (line) =>
        line.words?.map((word) =>
          /^(?:\p{Script=Latin}|\p{Number}|\p{Mark}|\p{Punctuation})+$/u.test(word.text),
        ) ?? [],
    ),
  )
  const completedSet = computed(
    () =>
      new Set(
        renderedLines.value
          .filter(({ line, index }) =>
            isLyricLineCompleted(line, index, sceneTime.value, scene.value),
          )
          .map(({ index }) => index),
      ),
  )

  // roving tabindex:仅当前激活行(无激活行时退回第一行)是 Tab 停靠点,
  // 避免数百行歌词全部进入 Tab 序列
  const keyboardFocusIndex = computed(() => {
    if (props.sharing) {
      const desired = keyboardIndex.value ?? sharingAnchor.value
      return renderedIndices.value.includes(desired)
        ? desired
        : (renderedIndices.value[0] ?? desired)
    }
    if (userBrowsing.value && keyboardIndex.value !== null) return keyboardIndex.value
    if (scene.value.anchor >= 0) return scene.value.anchor
    return displayedLines.value.findIndex((_, index) => !isHarmonyHidden(index))
  })

  const lyricPanelStyle = computed(() => ({
    '--lyric-scale': settings.value.lyricScale,
    '--lyric-tempo': lyricTempo.value,
  }))

  // 行距写在样式里(随字号与断点变化),引擎排版时从算好的样式里读回来。
  // row-gap / column-gap 在普通块级元素上没有版面效果,只用来把 CSS 变量算成像素
  function readGaps() {
    const content = lyricsContent.value
    if (!content || typeof getComputedStyle !== 'function') return FALLBACK_GAPS
    const style = getComputedStyle(content)
    const gap = Number.parseFloat(style.rowGap)
    const harmonyGap = Number.parseFloat(style.columnGap)
    return {
      gap: Number.isFinite(gap) ? gap : FALLBACK_GAPS.gap,
      harmonyGap: Number.isFinite(harmonyGap) ? harmonyGap : FALLBACK_GAPS.harmonyGap,
    }
  }

  const engine = useLyricsEngine({
    requestFrame: (callback) => frames.request('motion', callback),
    cancelFrame: frames.cancel,
    getViewport: () => viewport.value,
    getLineElements: lineElements,
    getWaitingElement: () => waitingElement.value,
    getLineCount: () => lines.value.length,
    getEstimatedHeight: (index) => {
      const line = displayedLines.value[index]
      if (!line) return estimatedLineHeight
      const rows = Math.max(1, Math.ceil(line.text.length / estimatedCharactersPerRow))
      const extra = (line.translation ? 0.55 : 0) + (line.roman ? 0.55 : 0)
      return estimatedLineHeight * (rows + extra)
    },
    onWindowChange: (indices) => {
      renderedIndices.value = indices
    },
    isAnimated: animationEnabled,
    getSpringScale: () => settings.value.lyricSpring,
    getGaps: readGaps,
    debugEnabled: () => props.debugEnabled && isPanelMounted,
    onDebugUpdate: scheduleDebug,
  })

  const karaoke = useLyricsKaraoke({
    getLines: () => displayedLines.value,
    getLineElements: lineElements,
    getLineElement: (index) =>
      lineElements().find((element) => Number(element.dataset.lyricIndex) === index),
    isEnabled: () => animationEnabled() && !props.sharing,
  })

  // ---- 状态与快照 ----

  function updateStatus(nextStatus: LyricStatus) {
    status.value = nextStatus
    const availability: LyricAvailability =
      nextStatus === 'ready' ? 'available' : nextStatus === 'loading' ? 'loading' : 'unavailable'
    emit('availability', availability)
    emitSnapshot()
  }

  function emitSnapshot() {
    scheduleDebug()
    emit('snapshot', {
      lines: displayedLines.value,
      activeIndex: scene.value.anchor,
      activeIndices: [...scene.value.active],
      status: status.value,
      // 翻译开关会复制显示行,来源仍从已加载的原始时间轴读取。
      source: getLyricsSource(lines.value) ?? undefined,
      tempoScale: lyricTempo.value,
    })
  }

  function readClock(): number {
    const actual = props.getLyricsPlaybackState?.().timeSeconds
    if (actual !== undefined && Number.isFinite(actual)) return actual
    return clock.read(performance.now())
  }

  function readPlaybackState(): LyricPlaybackState {
    return (
      props.getLyricsPlaybackState?.() ?? {
        timeSeconds: readClock(),
        playing: isPlaying.value,
        playbackRate: 1,
        seeking: false,
      }
    )
  }

  /** 把当前场景交给引擎排版。面板不活跃时不动版面,重新活跃时会整体重排 */
  function applyScene(transition: LyricsTransition) {
    if (!props.active || status.value !== 'ready' || !isPanelMounted) return
    engine.setScene(
      {
        background: backgroundFlags.value,
        openHarmonies: scene.value.openHarmonies,
        ...(scene.value.openHarmonies ? {} : { open: scene.value.harmonyOpen }),
        ...(props.sharing
          ? {
              open: undefined,
              openHarmonies: backgroundFlags.value.flatMap((background, index) =>
                background ? [index] : [],
              ),
            }
          : {}),
        focus: props.sharing ? sharingAnchor.value : scene.value.anchor,
        active: props.sharing ? [] : scene.value.highlighted,
        playing: !props.sharing && readPlaybackState().playing,
        waiting:
          waitingInterval.value && !props.sharing
            ? { nextAnchor: waitingInterval.value.nextAnchor }
            : undefined,
      },
      transition,
      { follow: !userBrowsing.value && !props.sharing, budgetMs: scrollBudgetMs() },
    )
  }

  /** 距离下一句主行还剩多少毫秒,快段落里引擎据此压缩牵引波 */
  function scrollBudgetMs(): number {
    const anchor = scene.value.anchor
    if (anchor < 0) return Number.POSITIVE_INFINITY
    const time = readClock()
    for (let index = anchor + 1; index < lines.value.length; index += 1) {
      const line = lines.value[index]!
      if (!line.background && line.time !== null && line.time > time) {
        return (line.time - time) * 1000
      }
    }
    return Number.POSITIVE_INFINITY
  }

  /**
   * 按播放位置解析场景。场景没变时什么都不做(force 除外),
   * 变了就更新高亮、扫光绑定、快照,并让引擎按 transition 重新排版
   */
  function syncScene(time: number, transition: LyricsTransition = 'spring', force = false) {
    const next = timeline.value.read(time)
    const waiting = waitingTimeline.value.read(time)?.interval ?? null
    const waitingChanged = waiting !== waitingInterval.value
    if (waitingChanged) waitingInterval.value = waiting
    const changed = !sameLyricScene(next, scene.value)
    if (next !== scene.value || force) {
      sceneTime.value = time
      scene.value = next
    }
    if (!changed && !waitingChanged && !force) return
    lyricTempo.value = next.anchor < 0 ? 1 : lyricTempoScale(lines.value, next.anchor)
    if (changed) emitSnapshot()
    applyScene(transition)
  }

  // ---- 加载 ----

  async function loadLyrics(track: Track | null) {
    const id = ++requestId
    resetTransientLyrics()
    if (!track || !hasTrackLyricsSource(track)) {
      updateStatus('empty')
      return
    }
    updateStatus('loading')
    const requestController = new AbortController()
    lyricsController = requestController
    const applyLines = (parsedLines: LyricLine[]) => {
      if (id !== requestId) return
      if (rawLines.value === parsedLines) return
      if (props.sharing) emit('shareCancel')
      rawLinesTrackId.value = track.id
      rawLines.value = parsedLines
      const source = getLyricsSource(parsedLines)
      lyricPreferences.reportSource(source)
      if (!parsedLines.length) {
        lines.value = []
        updateStatus('empty')
        return
      }
      const upgrading = status.value === 'ready' && lines.value.length > 0
      lines.value = offsetLyrics(parsedLines, lyricPreferences.getOffset(source))
      clock.anchor(currentTime.value, performance.now())
      if (isPlaying.value) clock.resume(currentTime.value, performance.now())
      sceneTime.value = readClock()
      scene.value = timeline.value.read(sceneTime.value)
      waitingInterval.value = waitingTimeline.value.read(sceneTime.value)?.interval ?? null
      playbackRunning.value = readPlaybackState().playing
      lyricTempo.value =
        scene.value.anchor < 0 ? 1 : lyricTempoScale(lines.value, scene.value.anchor)
      // 行节点要等舞台切换过渡结束才会挂上来,排版由 lyricsContent 的 watcher 接手
      updateStatus('ready')
      startRenderLoop()
      void nextTick(() => {
        if (id === requestId) relayout(upgrading)
      })
    }
    try {
      const selection = lyricPreferences.selection.value
      let parsedLines: LyricLine[]
      try {
        parsedLines = await loadTrackLyrics(
          track,
          requestController.signal,
          (progress) => {
            if (progress.length) applyLines(progress)
          },
          'foreground',
          selection,
        )
      } catch (error) {
        if (selection === 'auto' || requestController.signal.aborted || id !== requestId)
          throw error
        parsedLines = []
      }
      // 已记住的来源临时不可用时，仍用自动源兜底；不覆盖用户的记忆选择。
      if (!parsedLines.length && selection !== 'auto' && id === requestId)
        parsedLines = await loadTrackLyrics(track, requestController.signal, applyLines)
      applyLines(parsedLines)
    } catch (error) {
      // 只有面板自己 abort(切歌/卸载)才静默返回;服务层的加载超时
      // 已包装为 LyricsTimeoutError(见 services/lyrics),会落到 error 态
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (id === requestId) updateStatus('error')
    }
  }

  function resetTransientLyrics() {
    if (props.sharing) emit('shareCancel')
    cancelShareHold()
    touch = null
    suppressedClickTarget = null
    if (props.debugEnabled) clearDebug()
    lyricsController?.abort()
    lyricsController = null
    stopRenderLoop()
    stopBrowsing()
    frames.cancel(measureRaf)
    measureRaf = 0
    engine.reset()
    previousPlayback = null
    karaoke.release()
    lyricTempo.value = 1
    lineBreaks.value = new Map()
    lines.value = []
    rawLines.value = []
    rawLinesTrackId.value = null
    lyricPreferences.reportSource(null)
    keyboardIndex.value = null
    scene.value = emptyScene()
    sceneTime.value = 0
    waitingInterval.value = null
    playbackRunning.value = false
    status.value = 'idle'
  }

  /** 首次显示立即定位；播放中的重测保留当前位移、速度与和声展开进度。 */
  function relayout(preserveMotion = false, reflow = false) {
    if (!isPanelMounted || status.value !== 'ready' || !props.active || document.hidden) return
    if (balanceMountedLines()) {
      // Vue owns the break nodes. Measure final row heights only after that patch has landed.
      void nextTick(() => relayout(preserveMotion, reflow))
      return
    }
    const firstLine = lineElements()[0]
    if (firstLine) {
      const style = getComputedStyle(firstLine)
      const size = Number.parseFloat(style.fontSize)
      const lineHeight = Number.parseFloat(style.lineHeight)
      if (Number.isFinite(size) && size > 0) {
        estimatedLineHeight = Number.isFinite(lineHeight) ? lineHeight : size * 1.18
        estimatedCharactersPerRow = Math.max(
          1,
          (lyricsContent.value?.clientWidth ?? 400) / (size * 0.8),
        )
      }
    }
    if (preserveMotion) {
      applyScene('spring')
      engine.remeasure(true, reflow ? { transition: 'reflow' } : { preserveMotion: true })
    } else {
      engine.remeasure(true)
      applyScene('none')
    }
    karaoke.bind(scene.value.highlighted)
    karaoke.write(readClock())
    waitingIndicator.value?.write(readClock())
    stopRenderLoop()
    startRenderLoop()
  }

  function scheduleRelayout() {
    frames.cancel(measureRaf)
    measureRaf = frames.request('layout', () => {
      measureRaf = 0
      relayout(true, true)
    })
  }

  function handleFontsLoaded(): void {
    lineMeasurer.invalidate()
    scheduleRelayout()
  }

  // ---- 每帧渲染 ----

  function renderOnce(deferPaint = false) {
    scheduleDebug()
    if (!isPanelMounted || status.value !== 'ready' || !props.active || document.hidden) return
    const playback = readPlaybackState()
    playbackRunning.value = playback.playing && !playback.seeking
    const time = playback.timeSeconds
    const now = performance.now()
    const previous = previousPlayback
    const expected = previous
      ? previous.state.timeSeconds +
        (previous.state.playing && !previous.state.seeking
          ? ((now - previous.sampledAt) / 1000) * previous.state.playbackRate
          : 0)
      : time
    const jumped =
      previous !== null &&
      (playback.seeking ||
        previous.state.seeking ||
        time < previous.state.timeSeconds - 0.05 ||
        Math.abs(time - expected) > 0.6)
    const playingChanged = previous !== null && playback.playing !== previous.state.playing
    previousPlayback = { state: { ...playback }, sampledAt: now }
    syncScene(time, jumped ? 'seek' : 'spring', playingChanged || jumped)
    const paint = () => {
      paintFrame = 0
      karaoke.ensure(scene.value.highlighted)
      karaoke.write(time)
      waitingIndicator.value?.write(time)
      if (deferPaint) startRenderLoop(playback)
    }
    frames.cancel(paintFrame)
    if (deferPaint) paintFrame = frames.request('paint', paint)
    else paint()
  }

  function renderTick() {
    const inFrame = renderFrame !== 0
    renderFrame = 0
    renderTimer = 0
    renderOnce(inFrame)
    if (!inFrame) startRenderLoop()
  }

  function shouldRunRenderLoop(): boolean {
    return (
      isPanelMounted &&
      props.active &&
      isPlaying.value &&
      status.value === 'ready' &&
      lines.value.length > 0 &&
      typeof document !== 'undefined' &&
      !document.hidden
    )
  }

  function startRenderLoop(sampled?: LyricPlaybackState) {
    if (renderFrame || renderTimer || !shouldRunRenderLoop()) return
    const playback = sampled ?? readPlaybackState()
    if (
      playback.playing &&
      !playback.seeking &&
      waitingInterval.value &&
      !userBrowsing.value &&
      animationEnabled()
    ) {
      renderFrame = frames.request('scene', renderTick)
      return
    }
    const boundaries = [
      timeline.value.nextBoundary(playback.timeSeconds),
      waitingTimeline.value.nextBoundary(playback.timeSeconds),
    ].filter((boundary): boundary is number => boundary !== null)
    const plan = scheduleLyricRender(
      playback,
      boundaries.length ? Math.min(...boundaries) : null,
      karaoke.getWords(),
      animationEnabled(),
      karaoke.getMotionEnd(playback.timeSeconds),
    )
    if (plan.kind === 'frame') renderFrame = frames.request('scene', renderTick)
    else if (plan.kind === 'timer') renderTimer = window.setTimeout(renderTick, plan.delayMs)
  }

  function stopRenderLoop() {
    if (renderFrame) frames.cancel(renderFrame)
    renderFrame = 0
    frames.cancel(paintFrame)
    paintFrame = 0
    if (renderTimer) window.clearTimeout(renderTimer)
    renderTimer = 0
  }

  function handlePlaybackChange(): void {
    stopRenderLoop()
    if (!props.active || document.hidden) return
    renderOnce()
    startRenderLoop()
  }

  // ---- 用户接管滚动 ----

  function markBrowsing() {
    userBrowsing.value = true
    lastBrowseAt = performance.now()
    window.clearTimeout(browseTimer)
    browseTimer = 0
    scheduleBrowseReturn()
  }

  function scheduleBrowseReturn(): void {
    if (
      touch ||
      props.sharing ||
      !userBrowsing.value ||
      !isPanelMounted ||
      !props.active ||
      document.hidden
    )
      return
    const state = engine.browseState()
    const wait = lyricBrowseReturnWait(
      performance.now() - lastBrowseAt,
      state.distanceScreens,
      state.coasting,
    )
    if (wait > 0) {
      browseTimer = window.setTimeout(() => {
        browseTimer = 0
        scheduleBrowseReturn()
      }, wait)
    } else {
      stopBrowsing()
      engine.follow('seek', true)
    }
  }

  function stopBrowsing() {
    window.clearTimeout(browseTimer)
    browseTimer = 0
    userBrowsing.value = false
    keyboardIndex.value = null
  }

  function handleWheel(event: WheelEvent) {
    cancelShareHold()
    if (status.value !== 'ready') return
    const unit =
      event.deltaMode === 1
        ? WHEEL_LINE_PX
        : event.deltaMode === 2
          ? (viewport.value?.clientHeight ?? 0)
          : 1
    const delta = event.deltaY * unit
    if (!delta) return
    markBrowsing()
    engine.browseBy(delta)
  }

  interface TouchTracking {
    startX: number
    startY: number
    startedAt: number
    identifier: number
    target: HTMLElement | null
    y: number
    moved: boolean
    tapCancelled: boolean
    shared: boolean
    samples: Array<{ at: number; y: number }>
  }
  let touch: TouchTracking | null = null
  let shareHoldTimer = 0
  let suppressedClickTarget: HTMLElement | null = null
  let touchContextUntil = Number.NEGATIVE_INFINITY

  function cancelShareHold(): void {
    window.clearTimeout(shareHoldTimer)
    shareHoldTimer = 0
  }

  function shareLine(index: number, target: HTMLElement): void {
    cancelShareHold()
    const track = currentTrack.value
    if (
      !isPanelMounted ||
      !props.active ||
      document.hidden ||
      status.value !== 'ready' ||
      !track ||
      !lines.value[index] ||
      isHarmonyHidden(index) ||
      !target.isConnected
    )
      return
    target.focus({ preventScroll: true })
    emit('share', { track, lines: lines.value, index })
  }

  function handleLineContextMenu(event: MouseEvent): void {
    // Only suppress the native touch callout following a long press. Desktop right-click stays native.
    if (touch || performance.now() < touchContextUntil) event.preventDefault()
  }

  async function startShare(): Promise<void> {
    if (status.value !== 'ready' || !currentTrack.value || !lines.value.length) return
    const index = Math.max(0, scene.value.anchor)
    emit('share', { track: currentTrack.value, lines: lines.value, index })
    await nextTick()
    if (!props.sharing || !props.active) return
    engine.reveal(index)
    await nextTick()
    if (props.sharing)
      lineElements()
        .find((element) => Number(element.dataset.lyricIndex) === index)
        ?.focus({ preventScroll: true })
  }
  function getCalibrationLyrics() {
    return currentTrack.value &&
      rawLinesTrackId.value === currentTrack.value.id &&
      status.value === 'ready'
      ? {
          trackId: currentTrack.value.id,
          source: getLyricsSource(rawLines.value),
          lines: rawLines.value,
        }
      : null
  }
  defineExpose({ startShare, getCalibrationLyrics })

  function activateLine(line: LyricLine, index: number): void {
    if (props.sharing) emit('shareToggle', index)
    else seekLine(line)
  }

  function handlePointerDown(event: PointerEvent): void {
    if (event.isPrimary === false || event.pointerType === 'touch') return
    // 新的鼠标操作不应被上一次没有派发 click 的长按吞掉。
    suppressedClickTarget = null
    touchContextUntil = Number.NEGATIVE_INFINITY
    cancelShareHold()
  }

  function handleLineClick(event: MouseEvent, line: LyricLine): void {
    if (suppressedClickTarget === event.currentTarget && event.detail !== 0) {
      suppressedClickTarget = null
      event.preventDefault()
      return
    }
    if (!props.active || document.hidden) return
    activateLine(line, Number((event.currentTarget as HTMLElement).dataset.lyricIndex))
  }

  function handleTouchStart(event: TouchEvent) {
    cancelShareHold()
    if (
      !props.active ||
      document.hidden ||
      status.value !== 'ready' ||
      event.touches.length !== 1
    ) {
      handleTouchCancel()
      return
    }
    suppressedClickTarget = null
    const point = event.touches[0]!
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('.lyric-line') ?? null
    const now = performance.now()
    touch = {
      startX: point.clientX ?? 0,
      startY: point.clientY,
      startedAt: now,
      identifier: point.identifier,
      target,
      y: point.clientY,
      moved: false,
      tapCancelled: false,
      shared: false,
      samples: [{ at: now, y: point.clientY }],
    }
    if (target && !props.sharing) {
      const tracking = touch
      const currentLines = lines.value
      const track = currentTrack.value
      shareHoldTimer = window.setTimeout(() => {
        shareHoldTimer = 0
        if (
          touch !== tracking ||
          tracking.tapCancelled ||
          lines.value !== currentLines ||
          currentTrack.value !== track
        )
          return
        tracking.shared = true
        suppressedClickTarget = target
        shareLine(Number(target.dataset.lyricIndex), target)
      }, SHARE_HOLD_MS)
    }
    window.clearTimeout(browseTimer)
    browseTimer = 0
    // 手指按下时刹住正在进行的惯性
    engine.fling(0)
  }

  function handleTouchMove(event: TouchEvent) {
    if (event.touches.length !== 1) {
      handleTouchCancel()
      return
    }
    if (!touch) return
    const point = event.touches[0]!
    if (point.identifier !== touch.identifier) {
      handleTouchCancel()
      return
    }
    if (touch.shared) return
    if (
      Math.hypot((point.clientX ?? 0) - touch.startX, point.clientY - touch.startY) >= TAP_SLOP_PX
    ) {
      touch.tapCancelled = true
      cancelShareHold()
    }
    const dy = point.clientY - touch.y
    if (!touch.moved && Math.abs(dy) < TAP_SLOP_PX) return
    touch.moved = true
    touch.y = point.clientY
    const now = performance.now()
    touch.samples.push({ at: now, y: point.clientY })
    while (touch.samples.length > 1 && now - touch.samples[0]!.at > FLING_SAMPLE_MS * 2) {
      touch.samples.shift()
    }
    markBrowsing()
    // 手指拖动必须 1:1 跟随,不经过弹簧
    engine.browseBy(-dy, { snap: true })
  }

  function handleTouchEnd() {
    cancelShareHold()
    touchContextUntil = performance.now() + 1000
    if (!touch) {
      if (userBrowsing.value) markBrowsing()
      return
    }
    const { samples, moved, tapCancelled, shared, target } = touch
    touch = null
    if ((tapCancelled || shared) && target) suppressedClickTarget = target
    if (!moved) {
      if (userBrowsing.value) markBrowsing()
      return
    }
    markBrowsing()
    const now = performance.now()
    const recent = samples.filter((sample) => now - sample.at <= FLING_SAMPLE_MS)
    const first = recent[0]
    const last = recent[recent.length - 1]
    if (!first || !last || last.at === first.at) return
    engine.fling((-(last.y - first.y) / (last.at - first.at)) * 1000)
  }

  function handleTouchCancel() {
    cancelShareHold()
    touchContextUntil = performance.now() + 1000
    if (touch?.target) suppressedClickTarget = touch.target
    // 系统接管手势不代表用户甩动松手，保留当前位置。
    touch = null
    engine.fling(0)
    if (userBrowsing.value) markBrowsing()
  }

  function handleAdditionalTouch(event: TouchEvent): void {
    // 第二根手指可能落在歌词外，视口自身收不到它的 touchstart。
    if (touch && event.touches.length !== 1) handleTouchCancel()
  }

  async function handleKeydown(event: KeyboardEvent) {
    if (status.value !== 'ready') return
    const focused = (event.target as HTMLElement | null)?.closest<HTMLElement>('.lyric-line')
    if (props.sharing && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      emit('shareCancel')
      return
    }
    if (focused && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const direction = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1
      let index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? lines.value.length - 1
            : Number(focused.dataset.lyricIndex) + direction
      while (index >= 0 && index < lines.value.length) {
        if (!isHarmonyHidden(index)) break
        index += direction
      }
      if (index < 0 || index >= lines.value.length) return
      markBrowsing()
      keyboardIndex.value = index
      engine.reveal(index)
      await nextTick()
      lineElements()
        .find((element) => Number(element.dataset.lyricIndex) === index)
        ?.focus({ preventScroll: true })
      return
    }
    const height = viewport.value?.clientHeight ?? 0
    let delta: number
    switch (event.key) {
      case 'ArrowDown':
        delta = height * 0.18
        break
      case 'ArrowUp':
        delta = -height * 0.18
        break
      case 'PageDown':
        delta = height * 0.8
        break
      case 'PageUp':
        delta = -height * 0.8
        break
      case 'Home':
        delta = Number.NEGATIVE_INFINITY
        break
      case 'End':
        delta = Number.POSITIVE_INFINITY
        break
      case ' ':
        // 歌词行按钮上的 Space 由按钮自身处理(preventDefault 后触发 seek)
        if ((event.target as HTMLElement | null)?.closest('.lyric-line')) return
        delta = event.shiftKey ? -height * 0.8 : height * 0.8
        break
      default:
        return
    }
    event.preventDefault()
    markBrowsing()
    engine.browseBy(delta)
  }

  // 容器不会滚动(overflow: clip),键盘焦点落到视口外的行上时要自己把它带进来
  function handleFocusIn(event: FocusEvent) {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('.lyric-line')
    if (!target) return
    const index = Number(target.dataset.lyricIndex)
    keyboardIndex.value = index
    if (index >= 0 && engine.reveal(index)) markBrowsing()
  }

  function seekLine(line: LyricLine) {
    if (line.time === null) return
    emit('seek', line.time)
    stopBrowsing()
    // seek 的处理方会同步写 currentTime;这里立刻按新位置同步场景,
    // 点击的那一行马上开始牵引,不用等下一次 timeupdate
    clock.anchor(currentTime.value, performance.now())
    syncScene(readClock(), 'seek', true)
  }

  // ---- 环境事件 ----

  function handleViewportResize() {
    scheduleRelayout()
  }

  function handleVisibilityChange() {
    scheduleDebug()
    if (document.hidden) {
      suspendRendering()
      return
    }
    // 后台期间 rAF 停转,时钟锚点已经过期,恢复时先重锚再继续
    if (isPlaying.value) clock.resume(currentTime.value, performance.now())
    restoreRendering()
  }

  function suspendRendering() {
    cancelShareHold()
    stopRenderLoop()
    stopBrowsing()
    touch = null
    frames.cancel(measureRaf)
    measureRaf = 0
    engine.cancel()
    karaoke.release()
  }

  function restoreRendering() {
    if (!props.active || document.hidden) return
    playbackRunning.value = readPlaybackState().playing
    // 先取得最新场景，再重测和绑定扫光。暂停时没有下一帧来修正旧行绑定。
    syncScene(readClock(), 'none', true)
    // 隐藏期间的 ResizeObserver 回调会被跳过；恢复时必须补测，
    // 同时让被中断的弹簧落到正确位置，即使当前仍然是同一句。
    relayout()
  }

  function handleReducedMotionChange(event: MediaQueryListEvent | MediaQueryList) {
    prefersReducedMotion.value = event.matches
    handleAnimationToggle()
  }

  function handleAnimationToggle() {
    if (!animationEnabled()) engine.cancel()
    // 开关切换后立刻接管/交还当前行的扫光,不必等下一次换行
    karaoke.bind(scene.value.highlighted)
    renderOnce()
    applyScene('none')
    stopRenderLoop()
    startRenderLoop()
  }

  onMounted(() => {
    isPanelMounted = true
    stopPlaybackSubscription = props.subscribeLyricsPlayback?.(handlePlaybackChange)
    scheduleDebug()
    if (reducedMotionQuery) {
      stopReducedMotionListener = listenMediaQuery(reducedMotionQuery, handleReducedMotionChange)
    }
    viewportResizeTarget?.addEventListener('resize', handleViewportResize, { passive: true })
    document.addEventListener('visibilitychange', handleVisibilityChange)
    document.addEventListener('touchstart', handleAdditionalTouch, { passive: true })
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleRelayout())
      if (viewport.value) resizeObserver.observe(viewport.value)
    }
    // Later font loads invalidate cached widths as well as initial layout.
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => {
        if (isPanelMounted) handleFontsLoaded()
      })
      document.fonts.addEventListener?.('loadingdone', handleFontsLoaded)
    }
  })

  onBeforeUnmount(() => {
    isPanelMounted = false
    cancelShareHold()
    touch = null
    suppressedClickTarget = null
    clearDebug()
    stopRenderLoop()
    stopBrowsing()
    frames.cancel(measureRaf)
    frames.dispose()
    lineMeasurer.invalidate()
    document.fonts?.removeEventListener?.('loadingdone', handleFontsLoaded)
    lyricsController?.abort()
    resizeObserver?.disconnect()
    viewportResizeTarget?.removeEventListener('resize', handleViewportResize)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    document.removeEventListener('touchstart', handleAdditionalTouch)
    karaoke.release()
    stopReducedMotionListener?.()
    stopReducedMotionListener = null
    stopPlaybackSubscription?.()
  })

  // ---- 响应 ----

  watch(
    () => props.sharing,
    (sharing) => {
      const restoreFocus =
        !sharing && Boolean(viewport.value?.parentElement?.contains(document.activeElement))
      cancelShareHold()
      if (sharing) {
        sharingAnchor.value = props.selectedIndices[0] ?? Math.max(0, scene.value.anchor)
        keyboardIndex.value = sharingAnchor.value
        markBrowsing()
        engine.fling(0)
        applyScene('spring')
        engine.reveal(sharingAnchor.value)
      } else {
        stopBrowsing()
        applyScene('seek')
      }
      void nextTick(() => {
        relayout(true)
        if (restoreFocus && !props.sharing && props.active)
          lineElements()
            .find(
              (element) => Number(element.dataset.lyricIndex) === Math.max(0, scene.value.anchor),
            )
            ?.focus({ preventScroll: true })
      })
    },
    { flush: 'post' },
  )

  watch(
    () => props.debugEnabled,
    (enabled) => {
      if (!enabled) clearDebug()
      else {
        debugSampledAt = Number.NEGATIVE_INFINITY
        scheduleDebug()
      }
    },
  )
  watch(
    userBrowsing,
    () => {
      scheduleDebug()
      stopRenderLoop()
      startRenderLoop()
    },
    { flush: 'post' },
  )

  watch(
    () =>
      [
        currentTrack.value?.id,
        currentTrackVersion.value,
        lyricPreferences.selection.value,
        lyricPreferences.revision.value,
      ] as const,
    () => void loadLyrics(currentTrack.value),
    { immediate: true },
  )
  watch(lyricPreferences.offsetMs, () => {
    if (!rawLines.value.length || status.value !== 'ready') return
    if (props.sharing) emit('shareCancel')
    const next = offsetLyrics(
      rawLines.value,
      lyricPreferences.getOffset(getLyricsSource(rawLines.value)),
    )
    if (next === lines.value) return
    lines.value = next
    karaoke.release()
    syncScene(readClock(), 'spring', true)
    emitSnapshot()
    stopRenderLoop()
    startRenderLoop()
    void nextTick(() => relayout(true))
  })
  // 歌词舞台挂上来(状态过渡结束)时行节点才存在,此时做第一次排版
  watch(lyricsContent, (content) => {
    if (content) relayout()
  })
  // 新等待节点在场景更新后才挂载；暂停时也必须立即取得同一帧的歌词弹簧位置。
  watch(waitingElement, () => engine.syncWaiting(), { flush: 'post' })
  watch(
    renderedIndices,
    async () => {
      if (!isPanelMounted || status.value !== 'ready' || !props.active || document.hidden) return
      if (balanceMountedLines()) await nextTick()
      if (!isPanelMounted || status.value !== 'ready' || !props.active || document.hidden) return
      engine.syncMounted()
      karaoke.ensure(scene.value.highlighted)
      karaoke.write(readClock())
      stopRenderLoop()
      startRenderLoop()
    },
    { flush: 'post' },
  )
  watch(currentTime, (value) => {
    clock.anchor(value, performance.now())
    if (props.getLyricsPlaybackState && props.subscribeLyricsPlayback) return
    // 循环没跑时(暂停、面板隐藏)靠 timeupdate 驱动一次同步
    if (!renderFrame) handlePlaybackChange()
  })
  watch(
    isPlaying,
    (playing) => {
      if (!playing) {
        clock.freeze()
        stopRenderLoop()
        renderOnce()
        return
      }
      // 暂停期间锚点持续老化,恢复时必须以当前 currentTime 重锚,
      // 否则首个外推帧会跨越整个暂停时长跳到未来位置
      clock.resume(currentTime.value, performance.now())
      renderOnce()
      startRenderLoop()
    },
    { immediate: true },
  )
  watch(
    () => settings.value.lyricScale,
    () => void nextTick(() => relayout(true, true)),
  )
  watch(
    () => settings.value.lyricAnimation,
    () => handleAnimationToggle(),
  )
  watch(
    () => [settings.value.lyricTranslation, settings.value.lyricRomanization],
    () => {
      emitSnapshot()
      void nextTick(() => relayout(true, true))
    },
  )
  watch(
    () => props.active,
    (active) => {
      scheduleDebug()
      if (!active) {
        suspendRendering()
        return
      }
      restoreRendering()
    },
    { flush: 'post' },
  )

  function lineDistanceClass(index: number): string {
    const anchor = waitingInterval.value?.nextAnchor ?? scene.value.anchor
    const distance = anchor < 0 ? 0 : Math.min(Math.abs(index - anchor), 5)
    return `distance-${distance}`
  }

  function isHarmonyHidden(index: number): boolean {
    if (props.sharing) return false
    return Boolean(lines.value[index]?.background) && !isLyricHarmonyOpen(scene.value, index)
  }
</script>

<template>
  <section
    class="lyrics-panel"
    :class="{
      browsing: userBrowsing,
      sharing,
      'share-previewing': sharing && sharePreview,
      'animation-disabled': !settings.lyricAnimation,
      'apple-font': applePlatform,
      paused: !playbackRunning,
      waiting: Boolean(waitingInterval),
    }"
    :style="lyricPanelStyle"
    aria-label="歌词"
  >
    <div
      ref="viewport"
      class="lyrics-viewport"
      :inert="sharing && sharePreview ? true : undefined"
      :aria-hidden="sharing && sharePreview ? true : undefined"
      @pointerdown="handlePointerDown"
      @pointercancel="handleTouchCancel"
      @dragstart.prevent="handleTouchCancel"
      @wheel.passive="handleWheel"
      @touchstart.passive="handleTouchStart"
      @touchmove.passive="handleTouchMove"
      @touchend.passive="handleTouchEnd"
      @touchcancel.passive="handleTouchCancel"
      @keydown="handleKeydown"
      @focusin="handleFocusIn"
    >
      <Transition name="lyric-state-change" mode="out-in">
        <div v-if="status !== 'ready'" key="empty" class="lyric-stage" />
        <div v-else key="lyrics" class="lyric-stage">
          <Transition name="lyric-waiting">
            <div
              v-if="waitingInterval && !userBrowsing && !sharing"
              :key="waitingInterval.start"
              ref="waitingElement"
              :data-waiting-anchor="waitingInterval.nextAnchor"
              class="lyric-waiting"
              :class="{
                secondary: displayedLines[waitingInterval.nextAnchor]?.agent === 'secondary',
              }"
              :aria-label="waitingInterval.kind === 'intro' ? '前奏' : '间奏'"
            >
              <LyricsWaitingIndicator
                ref="waitingIndicator"
                :interval="waitingInterval"
                :animated="settings.lyricAnimation && !prefersReducedMotion"
                :paused="!playbackRunning"
                :get-time="readClock"
                :secondary="displayedLines[waitingInterval.nextAnchor]?.agent === 'secondary'"
              />
            </div>
          </Transition>
          <div ref="lyricsContent" class="lyrics-content">
            <button
              v-for="{ line, index } in renderedLines"
              :key="`${index}-${line.text}`"
              :data-lyric-index="index"
              :aria-label="`${index + 1} / ${displayedLines.length} ${[line.text, line.roman, line.translation].filter(Boolean).join(' ')}`"
              class="lyric-line"
              :class="[
                lineDistanceClass(index),
                {
                  active: activeSet.has(index),
                  completed: completedSet.has(index) && !activeSet.has(index),
                  timed: line.time !== null,
                  secondary: line.agent === 'secondary',
                  background: line.background,
                  'harmony-hidden': isHarmonyHidden(index),
                  karaoke: Boolean(line.words?.length),
                  'share-selected': sharing && selectedShareIndices.has(index),
                },
              ]"
              :inert="isHarmonyHidden(index) ? true : undefined"
              :tabindex="index === keyboardFocusIndex ? 0 : -1"
              :aria-pressed="sharing ? selectedShareIndices.has(index) : undefined"
              @contextmenu="handleLineContextMenu"
              @click="handleLineClick($event, line)"
              @keydown.enter.prevent="activateLine(line, index)"
              @keydown.space.prevent="activateLine(line, index)"
              @keyup.space.prevent
            >
              <span class="lyric-original">
                <template v-if="line.words?.length">
                  <template v-for="(word, wordIndex) in line.words" :key="wordIndex">
                    <br v-if="lineBreaks.get(index)?.includes(wordIndex)" />
                    <span
                      class="lyric-word"
                      :class="{
                        emphasized: Boolean(wordCharacters[index]?.[wordIndex]),
                        unbroken:
                          Boolean(wordCharacters[index]?.[wordIndex]) &&
                          unbrokenWords[index]?.[wordIndex],
                      }"
                    >
                      <template v-if="wordCharacters[index]?.[wordIndex]">
                        <span
                          v-for="(character, characterIndex) in wordCharacters[index]?.[wordIndex]"
                          :key="characterIndex"
                          class="lyric-char"
                          >{{ character }}</span
                        >
                      </template>
                      <template v-else>{{ word.text }}</template>
                    </span>
                    <span
                      v-if="word.trailingSpace && !lineBreaks.get(index)?.includes(wordIndex + 1)"
                      class="lyric-gap"
                      >{{ ' ' }}</span
                    >
                  </template>
                </template>
                <template v-else>{{ line.text }}</template>
              </span>
              <span v-if="line.roman" class="lyric-roman">{{ line.roman }}</span>
              <span v-if="line.translation" class="lyric-translation">{{ line.translation }}</span>
            </button>
          </div>
        </div>
      </Transition>
    </div>
    <slot name="share-tools" />
  </section>
</template>

<style scoped lang="scss">
  .sharing .lyric-line {
    cursor: pointer;
    color: var(--text);
    opacity: 0.5 !important;
    filter: none !important;
    text-shadow: none !important;
    --lyric-fill: var(--text);
    --lyric-idle: var(--text);
  }
  .sharing .lyric-line.share-selected {
    opacity: 1 !important;
  }
  .sharing .lyric-line.share-selected::before {
    background: rgba(255, 255, 255, 0.07);
    opacity: 1;
  }
  .sharing .lyric-original,
  .sharing .lyric-word,
  .sharing .lyric-char {
    color: inherit !important;
    -webkit-text-fill-color: currentColor !important;
    background: none !important;
    filter: none !important;
    text-shadow: none !important;
  }
  .lyrics-panel {
    position: relative;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  /* 容器本身不滚动:行的位置全部由引擎写在 translate 上。
     overflow: clip 连程序滚动(焦点落到视口外的行)都不会发生,版面不会被浏览器偷偷挪走 */
  .lyrics-viewport {
    grid-area: 1 / 1;
    position: relative;
    min-height: 0;
    overflow: clip;
    touch-action: none;
    mask-image: linear-gradient(transparent, #000 13%, #000 87%, transparent);
    transition:
      opacity 200ms cubic-bezier(0.16, 1, 0.3, 1),
      filter 200ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .share-previewing .lyrics-viewport {
    opacity: 0;
    filter: blur(6px);
    pointer-events: none;
  }

  .lyric-stage {
    height: 100%;
  }

  .lyric-state-change-enter-active {
    transition:
      opacity 620ms cubic-bezier(0.22, 1, 0.36, 1),
      transform 720ms cubic-bezier(0.16, 1, 0.3, 1),
      filter 620ms ease;
  }

  .lyric-state-change-leave-active {
    transition:
      opacity 260ms ease,
      transform 360ms cubic-bezier(0.4, 0, 1, 1),
      filter 260ms ease;
  }

  .lyric-state-change-enter-from {
    opacity: 0;
    filter: blur(8px);
    transform: translateY(20px);
  }

  .lyric-state-change-leave-to {
    opacity: 0;
    filter: blur(5px);
    transform: translateY(-12px);
  }

  .lyrics-content,
  .lyric-waiting {
    --lyric-responsive-size: clamp(24px, min(3.2vw, 4.8dvh), 34px);
    --lyric-responsive-gap: clamp(18px, min(2.5vw, 3.5dvh), 28px);
    // 宿主只覆盖基准值，用户倍率最后乘入，避免紧凑布局的 clamp 吃掉缩放范围。
    --lyric-gap: calc(var(--lyric-base-gap, var(--lyric-responsive-gap)) * var(--lyric-scale, 1));
    --lyric-harmony-gap: calc(var(--lyric-gap) * 0.3);

    position: absolute;
    font-size: calc(var(--lyric-base-size, var(--lyric-responsive-size)) * var(--lyric-scale, 1));
  }

  .lyric-waiting {
    top: 0;
    right: 7%;
    left: 3%;
    z-index: 1;
    display: flex;
    align-items: center;
    height: 1em;
    // 等引擎提供当前视觉坐标再显示，不能提前出现在最终锚点。
    visibility: hidden;
    translate: 0 -50%;
    pointer-events: none;

    &.secondary {
      justify-content: flex-end;
    }
  }

  .lyric-waiting-enter-active,
  .lyric-waiting-leave-active {
    transition: opacity 240ms ease-out;
  }

  .lyric-waiting-enter-from,
  .lyric-waiting-leave-to {
    opacity: 0;
  }

  .lyrics-content {
    --lyric-line-limit: 900px;

    inset: 0 7% 0 3%;
    /* 只是把行距变量算成像素给引擎读(getComputedStyle 的 rowGap / columnGap),
       块级元素上的 gap 没有版面效果 */
    row-gap: var(--lyric-gap);
    column-gap: var(--lyric-harmony-gap);
  }

  .lyric-line {
    --line-distance: 0;
    /* 未激活行整行按 idle 色渲染:扫光进度恒为 1,只有激活行由 JS 每帧写入 */
    --lyric-word-fill: 1;
    --lyric-word-edge: 0;
    --lyric-fill: #fff;
    --lyric-idle: #fff;
    --lyric-mask-idle: 0.36;
    /* 扫光前沿的柔化宽度,硬边会显得像进度条而不是"唱到这里" */
    --lyric-edge: 0.55em;

    position: absolute;
    top: 0;
    left: 0;
    max-width: min(var(--lyric-line-limit), 100%);
    padding: 0;
    border: 0;
    background: none;
    // 静息亮度只由这一层控制，避免文字 alpha 与行 opacity 相乘后过暗。
    opacity: calc(0.3 - var(--line-distance) * 0.025);
    filter: blur(calc(0.35px + var(--line-distance) * 0.78px));
    font-family: inherit;
    font-size: inherit;
    font-weight: 690;
    line-height: 1.18;
    letter-spacing: -0.035em;
    text-align: left;
    overflow-wrap: anywhere;
    -webkit-touch-callout: none;
    cursor: default;
    transform-origin: left center;
    transition:
      --lyric-fill calc(560ms * var(--lyric-tempo, 1)) cubic-bezier(0.22, 1, 0.36, 1),
      --lyric-idle calc(560ms * var(--lyric-tempo, 1)) cubic-bezier(0.22, 1, 0.36, 1),
      opacity calc(560ms * var(--lyric-tempo, 1)) cubic-bezier(0.22, 1, 0.36, 1),
      filter calc(560ms * var(--lyric-tempo, 1)) cubic-bezier(0.22, 1, 0.36, 1),
      text-shadow calc(560ms * var(--lyric-tempo, 1)) cubic-bezier(0.22, 1, 0.36, 1);

    &::before {
      position: absolute;
      inset: -0.2em -0.36em;
      z-index: -1;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0);
      opacity: 0;
      content: '';
      transition:
        background 140ms ease-out,
        opacity 140ms ease-out;
      pointer-events: none;
    }

    &.timed {
      cursor: pointer;
    }
    &.distance-0 {
      --line-distance: 0;
    }
    &.distance-1 {
      --line-distance: 1;
    }
    &.distance-2 {
      --line-distance: 2;
    }
    &.distance-3 {
      --line-distance: 3;
    }
    &.distance-4 {
      --line-distance: 4;
    }
    &.distance-5 {
      --line-distance: 5;
    }
    // 唱完后保留一层亮度；仍比正在唱的白色弱，不会与未唱的行一起骤暗。
    &.completed {
      opacity: calc(0.46 - var(--line-distance) * 0.025);
    }
    &:hover:not(.active) {
      opacity: 0.56;
    }

    &.active {
      --lyric-fill: #fff;
      --lyric-idle: rgba(255, 255, 255, 0.36);

      opacity: 1;
      filter: blur(0);
      text-shadow:
        0 0 10px rgba(255, 255, 255, 0.22),
        0 0 30px rgba(255, 255, 255, 0.15),
        0 8px 34px rgba(0, 0, 0, 0.3);
    }

    /* 对唱的第二声部靠右,与主唱形成左右分栏 */
    &.secondary {
      right: 0;
      left: auto;
      text-align: right;
      transform-origin: right center;
    }

    /* 背景和声:更小更淡,附在主行下方 */
    &.background {
      font-size: 0.67em;
      opacity: calc(0.4 - var(--line-distance) * 0.05);

      &.active {
        opacity: 0.78;
      }
    }
  }

  .lyric-original,
  .lyric-original-dim,
  .lyric-translation,
  .lyric-roman {
    position: relative;
    z-index: 1;
    display: block;
    color: var(--lyric-fill);
    scale: var(--lyric-line-scale, 1);
    transform-origin: inherit;
  }

  .lyric-line:not(.karaoke) .lyric-original {
    text-wrap: balance;
  }

  /* 逐字扫光:每个音节是一个独立的行内块,用背景渐变裁到文字上。
     --lyric-word-fill 是这个音节的演唱进度(0…1),由 JS 每帧写入当前行。
     前沿留 --lyric-edge 的渐变过渡,看起来是"亮起来"而不是"被刷过去" */
  .lyric-word,
  .lyric-dim-word {
    /* 左右各留出的绘制余量。字形墨迹横向溢出行内盒的来源有两处:
       行上的 letter-spacing: -0.035em 会让盒宽比最后一个字的字形窄,
       以及 690 字重下 J / f / y 这类字形本身带负边距。
       溢出的那一条同样没有背景可裁,表现为字被左右削掉一道 */
    --lyric-word-bleed: 0.12em;

    // max-width 只约束文字内容；绘制留白由负 margin 抵消，不能再挤占文字宽度。
    // 否则单词独占自适应宽度的歌词行时，末字会被 border-box 的 padding 挤到下一行。
    box-sizing: content-box;
    display: inline-block;
    max-width: 100%;
    /* background-clip: text 只在元素自身的背景盒内绘制。行高 1.18 比字体的自然行盒紧,
       g / y / p / q 的降部会伸出盒外,那一截没有背景可裁就被切掉。
       用 padding 撑开绘制盒、再用等量负 margin 抵消掉它对排版的影响。
       横向余量左右对称,扫光边界仍按盒宽百分比推进:两端各偏 bleed、正中零偏差,
       最大偏移远小于 --lyric-edge 的柔化宽度,不需要额外补偿渐变色标 */
    padding: 0.08em var(--lyric-word-bleed) 0.16em;
    margin: -0.08em calc(var(--lyric-word-bleed) * -1) -0.16em;
    /* 不支持 background-clip: text 时保持普通文字颜色。
       没有这层兜底,color: transparent 会让整屏歌词直接消失 */
    color: var(--lyric-fill);
    // 扫光和上浮各自计时，短音节唱完后仍能自然完成抬起。
    translate: 0 calc(var(--lyric-word-rise, 0) * -0.05em);
  }

  @supports (background-clip: text) or (-webkit-background-clip: text) {
    .lyric-word {
      /* 前沿的柔化宽度由 --lyric-word-edge 缩放,进度为 0 或 1 时收敛到 0。
         不收敛的话:进度 0 时前两个色标都落在 0%,0 → edge 之间仍会画出一段
         "亮→暗"的渐变,每个未唱词的左边缘都会比右边亮 */
      background-image: linear-gradient(
        90deg,
        var(--lyric-fill) 0%,
        var(--lyric-fill) calc(var(--lyric-word-fill) * 100%),
        var(--lyric-idle)
          calc(var(--lyric-word-fill) * 100% + var(--lyric-edge) * var(--lyric-word-edge)),
        var(--lyric-idle) 100%
      );
      color: transparent;
      -webkit-background-clip: text;
      background-clip: text;
    }
  }

  // 字符会独立变换，用父词遮罩覆盖其绘制结果，避免 background-clip 裁掉浮动字形。
  .lyric-word.emphasized {
    color: var(--lyric-fill);
    background-image: none;

    &.unbroken {
      // 字符 inline-block 的默认断行机会会令 Ohhh 在词内部折行。
      // 只锁定短英文长音；中文、真实空格及普通超长词仍能正常折行。
      max-width: none;
      white-space: nowrap;
      overflow-wrap: normal;
    }
  }

  .lyric-dim-word.emphasized.unbroken {
    max-width: none;
    white-space: nowrap;
    overflow-wrap: normal;
  }

  @supports (mask-image: linear-gradient(#000, #000)) or
    (-webkit-mask-image: linear-gradient(#000, #000)) {
    .lyric-word.emphasized {
      --lyric-word-mask: linear-gradient(
        90deg,
        #000 0%,
        #000 calc(var(--lyric-word-fill) * 100%),
        rgba(0, 0, 0, var(--lyric-mask-idle))
          calc(var(--lyric-word-fill) * 100% + var(--lyric-edge) * var(--lyric-word-edge)),
        rgba(0, 0, 0, var(--lyric-mask-idle)) 100%
      );

      -webkit-mask-image: var(--lyric-word-mask);
      mask-image: var(--lyric-word-mask);
    }
  }

  // 几何只在挂载或重排时测量，播放时移动固定渐变，避免逐帧改写色标。
  @supports (background-clip: text) or (-webkit-background-clip: text) {
    .lyric-word[data-lyric-sweep]:not(.emphasized) {
      background-image: linear-gradient(
        90deg,
        var(--lyric-fill) var(--lyric-sweep-span),
        var(--lyric-idle) calc(var(--lyric-sweep-span) + var(--lyric-sweep-fade))
      );
      background-size: var(--lyric-sweep-size) 100%;
      background-position: var(--lyric-sweep-position) 0;
      background-repeat: no-repeat;
    }
  }

  @supports (mask-image: linear-gradient(#000, #000)) or
    (-webkit-mask-image: linear-gradient(#000, #000)) {
    .lyric-word.emphasized[data-lyric-sweep] {
      --lyric-word-mask: linear-gradient(
        90deg,
        #000 var(--lyric-sweep-span),
        rgba(0, 0, 0, var(--lyric-mask-idle))
          calc(var(--lyric-sweep-span) + var(--lyric-sweep-fade))
      );

      -webkit-mask-size: var(--lyric-sweep-size) 100%;
      mask-size: var(--lyric-sweep-size) 100%;
      -webkit-mask-position: var(--lyric-sweep-position) 0;
      mask-position: var(--lyric-sweep-position) 0;
      -webkit-mask-repeat: no-repeat;
      mask-repeat: no-repeat;
    }
  }

  .lyric-char,
  .lyric-dim-char {
    display: inline-block;
    white-space: pre;
    translate: calc(var(--lyric-char-spread, 0) * 1em)
      calc(var(--lyric-char-emphasis, 0) * -0.035em);
    scale: calc(1 + var(--lyric-char-emphasis, 0) * 0.045);
    text-shadow:
      0 0 0.22em rgba(255, 255, 255, calc(var(--lyric-char-emphasis, 0) * 0.3)),
      0 8px 34px rgba(0, 0, 0, 0.3);
  }

  // 已唱词保留持续辉光，长音在这一层之上增加轻微强调。
  .lyric-line.active .lyric-word,
  .lyric-line.active .lyric-char {
    text-shadow:
      0 0 calc(var(--lyric-word-fill) * 0.34em)
        rgba(
          255,
          255,
          255,
          calc(var(--lyric-word-fill) * 0.42 + var(--lyric-char-emphasis, 0) * 0.18)
        ),
      0 0 calc(var(--lyric-word-fill) * 0.9em)
        rgba(255, 255, 255, calc(var(--lyric-word-fill) * 0.16)),
      0 8px 34px rgba(0, 0, 0, 0.3);
  }

  .lyric-line.background .lyric-word {
    translate: 0 calc(var(--lyric-word-rise, 0) * -0.08em);
  }

  .lyric-line:not(.active) .lyric-word,
  .lyric-line:not(.active) .lyric-char {
    transition:
      translate 320ms ease-out,
      scale 320ms ease-out,
      text-shadow 320ms ease-out;
  }

  // Reclaimed rows replace their static copy in the same resting pose, without a second fall.
  .lyric-line:not(.active):not([data-lyric-layered]) .lyric-word,
  .lyric-line:not(.active):not([data-lyric-layered]) .lyric-char {
    translate: none;
    scale: 1;
    text-shadow: none;
    transition: none;
  }

  /* 浏览态下整行压平,发光也一并关掉 */
  .lyrics-panel.browsing .lyric-line.active .lyric-word,
  .lyrics-panel.browsing .lyric-line.active .lyric-char {
    text-shadow: none;
  }

  /* 音节之间的空格单独成节点:行内块之间没有空白文本节点就不会产生换行机会,
     英文长句会溢出。pre-wrap 保留这个空格的同时保留它的换行能力 */
  .lyric-gap,
  .lyric-dim-gap {
    white-space: pre-wrap;
  }

  .lyric-roman {
    margin-top: 0.16em;
    font-size: 0.56em;
    font-weight: 560;
    letter-spacing: 0;
    opacity: 0.6;
  }

  .lyric-translation {
    margin-top: 0.18em;
    font-size: 0.72em;
    font-weight: 590;
    line-height: 1.26;
    letter-spacing: -0.02em;
    opacity: 0.76;
  }

  .lyrics-panel.apple-font {
    .lyric-line {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
      font-weight: 700;
      // 覆盖全局的 font-synthesis: none,允许缺少粗体字形的回退字体合成粗体。
      font-synthesis: weight;
    }

    .lyric-translation,
    .lyric-roman {
      font-weight: 700;
    }
  }

  /* 用户正在滚动浏览歌词时,当前行的字不该还在上浮——那时的焦点是列表本身 */
  .lyrics-panel.browsing .lyric-word {
    translate: none;
  }

  .lyrics-panel.browsing .lyric-char {
    translate: none;
    scale: 1;
    text-shadow: none;
  }

  .lyrics-panel.browsing .lyric-line {
    opacity: 0.72;
    filter: blur(0);
    text-shadow: none;

    &:hover:not(.active)::before {
      background: rgba(255, 255, 255, 0.1);
      opacity: 1;
    }

    &.active {
      --lyric-idle: #fff;
      --lyric-mask-idle: 1;
    }
  }

  /* 和声的出现与收回。Apple Music 里和声是附在主句下方的一小行,唱到这一句才现身、
     唱完收走。版面与视觉都由引擎的同一根弹簧驱动(--lyric-harmony,0 = 收起,1 = 展开):
     占位高度按它伸缩,下面的行 1:1 跟随;这里按它裁掉尚未展开的部分(自下而上),
     再叠上淡出、模糊与轻微缩小。裁切挂在行级、按行盒的百分比算,和占位高度严格对齐,
     收回过程中下面的行永远压不到还没消失的文字;主句方向留出负值让光晕溢出 */
  .lyric-line.background {
    --lyric-harmony: 1;

    clip-path: inset(-0.3em -0.4em calc((1 - var(--lyric-harmony)) * 100% - 0.3em) -0.4em);
  }

  .lyric-line.background .lyric-original,
  .lyric-line.background .lyric-original-dim,
  .lyric-line.background .lyric-roman,
  .lyric-line.background .lyric-translation {
    transform-origin: left top;
    scale: calc(0.94 + 0.06 * var(--lyric-harmony));
    filter: blur(calc((1 - var(--lyric-harmony)) * 6px));
    // 展开进度已经由弹簧逐帧推进，不能再让 CSS scale 过渡滞后于占位与裁切。
    transition: none;
  }

  .lyric-line.background.secondary .lyric-original,
  .lyric-line.background.secondary .lyric-original-dim,
  .lyric-line.background.secondary .lyric-roman,
  .lyric-line.background.secondary .lyric-translation {
    transform-origin: right top;
  }

  .lyric-line.background .lyric-original {
    opacity: var(--lyric-harmony);
  }

  .lyric-line.background .lyric-roman {
    opacity: calc(0.6 * var(--lyric-harmony));
  }

  .lyric-line.background .lyric-translation {
    opacity: calc(0.76 * var(--lyric-harmony));
  }

  .lyric-line.background.harmony-hidden {
    pointer-events: none;
  }

  // The copy has exactly the same word/character boxes and breaks, but never joins layout or karaoke queries.
  .lyric-original-dim {
    position: absolute;
    inset: 0 0 auto;
    pointer-events: none;
    user-select: none;
  }

  .lyric-original-dim,
  .lyric-dim-word,
  .lyric-dim-char {
    text-shadow: none;
  }

  .lyric-line[data-lyric-layered] {
    --lyric-idle: rgba(255, 255, 255, 0.36);

    // Keep mask contrast fixed while opacity handles entering/leaving the active state.
    transition-property: opacity, filter, text-shadow;

    .lyric-original,
    .lyric-original-dim {
      transition: opacity 420ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .lyric-original {
      opacity: 0;
    }
    .lyric-original-dim {
      opacity: var(--lyric-harmony, 1);
    }

    &[data-lyric-bright] {
      .lyric-original {
        opacity: var(--lyric-harmony, 1);
      }
      .lyric-original-dim {
        opacity: 0;
      }
    }
  }

  .lyrics-panel.browsing .lyric-line[data-lyric-layered] {
    --lyric-idle: #fff;
  }

  .sharing .lyric-original-dim {
    display: none;
  }
  .sharing .lyric-original {
    opacity: var(--lyric-harmony, 1) !important;
  }

  // 停下来后回到清晰的阅读状态，沿用有限的亮度/模糊过渡，不启动待机循环。
  .lyrics-panel.paused:not(.browsing) .lyric-line {
    opacity: calc(0.5 - var(--line-distance) * 0.035);
    filter: blur(calc(var(--line-distance) * 0.3px));

    &.active {
      opacity: 0.86;
      filter: none;
    }
  }

  .lyrics-panel.waiting:not(.browsing) .lyric-line.distance-0:not(.active) {
    opacity: 0.52;
    filter: none;
  }

  .lyrics-panel.animation-disabled {
    .lyric-waiting-enter-active,
    .lyric-waiting-leave-active,
    .lyric-state-change-enter-active,
    .lyric-state-change-leave-active,
    .lyric-line,
    .lyric-original,
    .lyric-translation,
    .lyric-roman {
      transition-duration: 0ms;
      animation-duration: 0ms;
    }

    .lyric-word,
    .lyric-char {
      translate: none;
      scale: 1;
      text-shadow: none;
      transition: none;
    }

    .lyric-line.active .lyric-original,
    .lyric-line.active .lyric-translation,
    .lyric-line.active .lyric-roman {
      scale: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .lyric-waiting-enter-active,
    .lyric-waiting-leave-active,
    .lyric-state-change-enter-active,
    .lyric-state-change-leave-active,
    .lyric-line,
    .lyric-original,
    .lyric-translation,
    .lyric-roman {
      transition-duration: 0ms;
    }

    .lyric-word,
    .lyric-char {
      translate: none;
      scale: 1;
      text-shadow: none;
      transition: none;
    }
  }

  @media (max-width: 720px) {
    .lyrics-content,
    .lyric-waiting {
      --lyric-responsive-size: clamp(22px, 6.75vw, 30px);
      --lyric-responsive-gap: clamp(18px, 5.5vw, 26px);

      left: 7%;
    }

    .lyric-line {
      width: 100%;
      max-width: none;
    }
  }

  @supports (container-type: size) {
    .lyrics-viewport {
      container-type: size;
    }

    .lyrics-content,
    .lyric-waiting {
      --lyric-responsive-size: clamp(24px, min(6cqw, 6cqh), 34px);
      --lyric-responsive-gap: clamp(18px, min(5cqw, 5cqh), 28px);
    }

    @media (max-width: 720px) {
      .lyrics-content,
      .lyric-waiting {
        --lyric-responsive-size: clamp(22px, min(6.75cqw, 8cqh), 30px);
        --lyric-responsive-gap: clamp(18px, min(5.5cqw, 6cqh), 26px);
      }
    }
  }

  @media (prefers-contrast: more) {
    .lyric-line {
      --lyric-mask-idle: 0.62;
      opacity: 0.65;
      filter: blur(0);

      &.completed {
        opacity: 0.8;
      }

      &.active {
        --lyric-fill: #fff;
        --lyric-idle: rgba(255, 255, 255, 0.62);

        opacity: 1;
      }
    }

    .lyrics-panel.browsing .lyric-line {
      opacity: 0.72;
    }

    .lyrics-panel.paused:not(.browsing) .lyric-line,
    .lyrics-panel.waiting:not(.browsing) .lyric-line.distance-0:not(.active) {
      opacity: 0.8;
      filter: none;
    }
  }
</style>
