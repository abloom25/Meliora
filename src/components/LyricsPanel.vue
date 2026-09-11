<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import { usePlayerStore } from '../stores/player'
  import { hasTrackLyricsSource, loadTrackLyrics } from '../services/lyrics'
  import { createLyricClock } from '../core/lyrics'
  import { listenMediaQuery } from '../platform/web/media-query'
  import {
    harmonyParentsOf,
    lyricTempoScale,
    nextPrimaryTime,
    resolveLyricScene,
    sameLyricScene,
    type LyricScene,
  } from '../core/lyrics'
  import { useLyricsEngine, type LyricsTransition } from '../composables/useLyricsEngine'
  import { useLyricsKaraoke } from '../composables/useLyricsKaraoke'
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
  }>()
  const props = withDefaults(
    defineProps<{
      active?: boolean
    }>(),
    {
      active: true,
    },
  )

  // 用户手动滚动后多久交还给自动跟随
  const BROWSE_IDLE_MS = 3200
  // 滚轮 deltaMode 为"行"时每行折算的像素
  const WHEEL_LINE_PX = 40
  // 触摸惯性取松手前这么长时间内的位移算速度
  const FLING_SAMPLE_MS = 90
  // 手指移动不超过这个距离算点按,不进入浏览态
  const TAP_SLOP_PX = 6
  // 没有样式(测试环境)时的行距兜底
  const FALLBACK_GAPS = { gap: 28, harmonyGap: 8 }

  const store = usePlayerStore()
  const { currentTrack, currentTrackVersion, currentTime, isPlaying, settings } = storeToRefs(store)

  function emptyScene(): LyricScene {
    return { active: [], held: false, anchor: -1, harmonyOpen: [] }
  }

  // timeupdate 只有约 4Hz,逐字扫光需要每帧的播放位置,这里统一走外推时钟
  const clock = createLyricClock()
  const lines = ref<LyricLine[]>([])
  const scene = ref<LyricScene>(emptyScene())
  const status = ref<LyricStatus>('idle')
  const lyricTempo = ref(1)
  const viewport = ref<HTMLElement>()
  const lyricsContent = ref<HTMLElement>()
  const userBrowsing = ref(false)
  // 行节点直接从 DOM 读:它们在 Transition 的插槽里,由 Transition 自己渲染,
  // 面板自身重渲染时插槽不一定跟着跑,靠 ref 收集会在 onBeforeUpdate 清空后拿不回来
  function lineElements(): HTMLElement[] {
    const content = lyricsContent.value
    return content ? (Array.from(content.children) as HTMLElement[]) : []
  }
  let isPanelMounted = false
  let browseTimer = 0
  let measureRaf = 0
  let requestId = 0
  let renderFrame = 0
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
  let prefersReducedMotion = reducedMotionQuery?.matches ?? false

  function animationEnabled(): boolean {
    return settings.value.lyricAnimation && !prefersReducedMotion
  }

  const displayedLines = computed(() => {
    if (settings.value.lyricTranslation) return lines.value
    return lines.value.map((line) => {
      if (!line.translation && !line.roman) return line
      const copy: LyricLine = { ...line }
      delete copy.translation
      delete copy.roman
      return copy
    })
  })
  const harmonyParents = computed(() => harmonyParentsOf(lines.value))
  const backgroundFlags = computed(() => lines.value.map((line) => Boolean(line.background)))
  const activeSet = computed(() => new Set(scene.value.active))

  // roving tabindex:仅当前激活行(无激活行时退回第一个可 seek 的行)是 Tab 停靠点,
  // 避免数百行歌词全部进入 Tab 序列
  const keyboardFocusIndex = computed(() => {
    if (scene.value.anchor >= 0) return scene.value.anchor
    return displayedLines.value.findIndex((line) => line.time !== null)
  })

  const lyricPanelStyle = computed(() => ({
    '--lyric-size': `${settings.value.lyricFontSize}px`,
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
    getViewport: () => viewport.value,
    getLineElements: lineElements,
    isAnimated: animationEnabled,
    getSpringScale: () => settings.value.lyricSpring,
    getGaps: readGaps,
  })

  const karaoke = useLyricsKaraoke({
    getLines: () => displayedLines.value,
    getLineElements: lineElements,
    isEnabled: animationEnabled,
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
    emit('snapshot', {
      lines: displayedLines.value,
      activeIndex: scene.value.anchor,
      activeIndices: [...scene.value.active],
      status: status.value,
      tempoScale: lyricTempo.value,
    })
  }

  function readClock(): number {
    return clock.read(performance.now())
  }

  /** 把当前场景交给引擎排版。面板不活跃时不动版面,重新活跃时会整体重排 */
  function applyScene(transition: LyricsTransition) {
    if (!props.active || status.value !== 'ready' || !isPanelMounted) return
    engine.setScene(
      {
        background: backgroundFlags.value,
        open: scene.value.harmonyOpen,
        focus: scene.value.anchor,
      },
      transition,
      { follow: !userBrowsing.value, budgetMs: scrollBudgetMs() },
    )
  }

  /** 距离下一句主行还剩多少毫秒,快段落里引擎据此压缩牵引波 */
  function scrollBudgetMs(): number {
    const anchor = scene.value.anchor
    if (anchor < 0) return Number.POSITIVE_INFINITY
    const next = nextPrimaryTime(lines.value, anchor)
    if (next === null) return Number.POSITIVE_INFINITY
    return (next - readClock()) * 1000
  }

  /**
   * 按播放位置解析场景。场景没变时什么都不做(force 除外),
   * 变了就更新高亮、扫光绑定、快照,并让引擎按 transition 重新排版
   */
  function syncScene(time: number, transition: LyricsTransition = 'spring', force = false) {
    const next = resolveLyricScene(lines.value, time, harmonyParents.value)
    const changed = !sameLyricScene(next, scene.value)
    if (!changed && !force) return
    scene.value = next
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
    lyricsController = new AbortController()
    try {
      const parsedLines = await loadTrackLyrics(track, lyricsController.signal)
      if (id !== requestId) return
      if (!parsedLines.length) {
        lines.value = []
        updateStatus('empty')
        return
      }
      lines.value = parsedLines
      clock.anchor(currentTime.value, performance.now())
      if (isPlaying.value) clock.resume(currentTime.value, performance.now())
      scene.value = resolveLyricScene(lines.value, readClock(), harmonyParents.value)
      lyricTempo.value =
        scene.value.anchor < 0 ? 1 : lyricTempoScale(lines.value, scene.value.anchor)
      // 行节点要等舞台切换过渡结束才会挂上来,排版由 lyricsContent 的 watcher 接手
      updateStatus('ready')
      startRenderLoop()
    } catch (error) {
      // 只有面板自己 abort(切歌/卸载)才静默返回;服务层的加载超时
      // 已包装为 LyricsTimeoutError(见 services/lyrics),会落到 error 态
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (id === requestId) updateStatus('error')
    }
  }

  function resetTransientLyrics() {
    lyricsController?.abort()
    lyricsController = null
    stopRenderLoop()
    stopBrowsing()
    window.cancelAnimationFrame(measureRaf)
    measureRaf = 0
    engine.reset()
    karaoke.release()
    lyricTempo.value = 1
    lines.value = []
    scene.value = emptyScene()
    status.value = 'idle'
  }

  /** 行节点刚挂上来 / 尺寸变化 / 内容重排后:重新测量并瞬时就位 */
  function relayout() {
    if (!isPanelMounted || status.value !== 'ready') return
    engine.remeasure()
    applyScene('none')
    karaoke.bind(scene.value.active)
    karaoke.write(readClock())
  }

  function scheduleRelayout() {
    window.cancelAnimationFrame(measureRaf)
    measureRaf = window.requestAnimationFrame(() => {
      measureRaf = 0
      relayout()
    })
  }

  // ---- 每帧渲染 ----

  function renderOnce() {
    if (!isPanelMounted || status.value !== 'ready') return
    const time = readClock()
    syncScene(time)
    karaoke.ensure(scene.value.active)
    karaoke.write(time)
  }

  function renderTick() {
    renderFrame = 0
    renderOnce()
    if (shouldRunRenderLoop()) renderFrame = window.requestAnimationFrame(renderTick)
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

  function startRenderLoop() {
    if (renderFrame || !shouldRunRenderLoop()) return
    renderFrame = window.requestAnimationFrame(renderTick)
  }

  function stopRenderLoop() {
    if (!renderFrame) return
    window.cancelAnimationFrame(renderFrame)
    renderFrame = 0
  }

  // ---- 用户接管滚动 ----

  function markBrowsing() {
    userBrowsing.value = true
    window.clearTimeout(browseTimer)
    browseTimer = window.setTimeout(() => {
      userBrowsing.value = false
      engine.follow('spring')
    }, BROWSE_IDLE_MS)
  }

  function stopBrowsing() {
    window.clearTimeout(browseTimer)
    userBrowsing.value = false
  }

  function handleWheel(event: WheelEvent) {
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
    y: number
    moved: boolean
    samples: Array<{ at: number; y: number }>
  }
  let touch: TouchTracking | null = null

  function handleTouchStart(event: TouchEvent) {
    if (status.value !== 'ready' || event.touches.length !== 1) {
      touch = null
      return
    }
    const point = event.touches[0]!
    touch = {
      y: point.clientY,
      moved: false,
      samples: [{ at: performance.now(), y: point.clientY }],
    }
    // 手指按下时刹住正在进行的惯性
    engine.fling(0)
  }

  function handleTouchMove(event: TouchEvent) {
    if (!touch || event.touches.length !== 1) return
    const point = event.touches[0]!
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
    if (!touch) return
    const { samples, moved } = touch
    touch = null
    if (!moved) return
    const now = performance.now()
    const recent = samples.filter((sample) => now - sample.at <= FLING_SAMPLE_MS)
    const first = recent[0]
    const last = recent[recent.length - 1]
    if (!first || !last || last.at === first.at) return
    markBrowsing()
    engine.fling((-(last.y - first.y) / (last.at - first.at)) * 1000)
  }

  function handleKeydown(event: KeyboardEvent) {
    if (status.value !== 'ready') return
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
    const index = lineElements().indexOf(target)
    if (index >= 0 && engine.reveal(index)) markBrowsing()
  }

  function seekLine(line: LyricLine) {
    if (line.time === null) return
    emit('seek', line.time)
    stopBrowsing()
    // seek 的处理方会同步写 currentTime;这里立刻按新位置同步场景,
    // 点击的那一行马上开始牵引,不用等下一次 timeupdate
    clock.anchor(currentTime.value, performance.now())
    syncScene(readClock(), 'spring', true)
  }

  // ---- 环境事件 ----

  function handleViewportResize() {
    scheduleRelayout()
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      stopRenderLoop()
      return
    }
    // 后台期间 rAF 停转,时钟锚点已经过期,恢复时先重锚再继续
    if (isPlaying.value) clock.resume(currentTime.value, performance.now())
    renderOnce()
    startRenderLoop()
  }

  function handleReducedMotionChange(event: MediaQueryListEvent | MediaQueryList) {
    prefersReducedMotion = event.matches
    handleAnimationToggle()
  }

  function handleAnimationToggle() {
    if (!animationEnabled()) engine.cancel()
    // 开关切换后立刻接管/交还当前行的扫光,不必等下一次换行
    karaoke.bind(scene.value.active)
    renderOnce()
    applyScene('none')
  }

  onMounted(() => {
    isPanelMounted = true
    if (reducedMotionQuery) {
      stopReducedMotionListener = listenMediaQuery(reducedMotionQuery, handleReducedMotionChange)
    }
    viewportResizeTarget?.addEventListener('resize', handleViewportResize, { passive: true })
    document.addEventListener('visibilitychange', handleVisibilityChange)
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => scheduleRelayout())
      if (viewport.value) resizeObserver.observe(viewport.value)
    }
    // 网页字体晚于首次排版加载完成时行高会变,量一次就好
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => {
        if (isPanelMounted) scheduleRelayout()
      })
    }
  })

  onBeforeUnmount(() => {
    isPanelMounted = false
    stopRenderLoop()
    window.clearTimeout(browseTimer)
    window.cancelAnimationFrame(measureRaf)
    lyricsController?.abort()
    resizeObserver?.disconnect()
    viewportResizeTarget?.removeEventListener('resize', handleViewportResize)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    karaoke.release()
    stopReducedMotionListener?.()
    stopReducedMotionListener = null
  })

  // ---- 响应 ----

  watch(
    () => [currentTrack.value?.id, currentTrackVersion.value] as const,
    () => void loadLyrics(currentTrack.value),
    { immediate: true },
  )
  // 歌词舞台挂上来(状态过渡结束)时行节点才存在,此时做第一次排版
  watch(lyricsContent, (content) => {
    if (content) relayout()
  })
  watch(currentTime, (value) => {
    clock.anchor(value, performance.now())
    // 循环没跑时(暂停、面板隐藏)靠 timeupdate 驱动一次同步
    if (!renderFrame) renderOnce()
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
    () => settings.value.lyricFontSize,
    () => void nextTick(relayout),
  )
  watch(
    () => settings.value.lyricAnimation,
    () => handleAnimationToggle(),
  )
  watch(
    () => settings.value.lyricTranslation,
    () => {
      emitSnapshot()
      void nextTick(relayout)
    },
  )
  watch(
    () => props.active,
    (active) => {
      if (!active) {
        stopRenderLoop()
        stopBrowsing()
        return
      }
      // 隐藏期间尺寸可能变了,回来先整体重排,再从当前位置继续
      relayout()
      syncScene(readClock(), 'none', true)
      startRenderLoop()
    },
  )

  function lineDistanceClass(index: number): string {
    const anchor = scene.value.anchor
    const distance = anchor < 0 ? 0 : Math.min(Math.abs(index - anchor), 5)
    return `distance-${distance}`
  }

  function isHarmonyHidden(index: number): boolean {
    return Boolean(lines.value[index]?.background) && !scene.value.harmonyOpen[index]
  }
</script>

<template>
  <section
    class="lyrics-panel"
    :class="{
      browsing: userBrowsing,
      'animation-disabled': !settings.lyricAnimation,
    }"
    :style="lyricPanelStyle"
    aria-label="歌词"
  >
    <div
      ref="viewport"
      class="lyrics-viewport"
      @wheel.passive="handleWheel"
      @touchstart.passive="handleTouchStart"
      @touchmove.passive="handleTouchMove"
      @touchend.passive="handleTouchEnd"
      @touchcancel.passive="handleTouchEnd"
      @keydown="handleKeydown"
      @focusin="handleFocusIn"
    >
      <Transition name="lyric-state-change" mode="out-in">
        <div v-if="status !== 'ready'" key="empty" class="lyric-stage" />
        <div v-else key="lyrics" class="lyric-stage">
          <div ref="lyricsContent" class="lyrics-content">
            <button
              v-for="(line, index) in displayedLines"
              :key="`${line.time}-${index}`"
              class="lyric-line"
              :class="[
                lineDistanceClass(index),
                {
                  active: activeSet.has(index),
                  timed: line.time !== null,
                  secondary: line.agent === 'secondary',
                  background: line.background,
                  'harmony-hidden': isHarmonyHidden(index),
                  karaoke: Boolean(line.words?.length),
                },
              ]"
              :disabled="line.time === null"
              :inert="isHarmonyHidden(index) ? true : undefined"
              :tabindex="index === keyboardFocusIndex ? 0 : -1"
              @click="seekLine(line)"
              @keydown.enter.prevent="seekLine(line)"
              @keydown.space.prevent="seekLine(line)"
              @keyup.space.prevent
            >
              <span class="lyric-original">
                <template v-if="line.words?.length">
                  <template v-for="(word, wordIndex) in line.words" :key="wordIndex">
                    <span class="lyric-word">{{ word.text }}</span>
                    <span v-if="word.trailingSpace" class="lyric-gap">{{ ' ' }}</span>
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
  </section>
</template>

<style scoped lang="scss">
  .lyrics-panel {
    position: relative;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }

  /* 容器本身不滚动:行的位置全部由引擎写在 translate 上。
     overflow: clip 连程序滚动(焦点落到视口外的行)都不会发生,版面不会被浏览器偷偷挪走 */
  .lyrics-viewport {
    position: relative;
    height: 100%;
    overflow: clip;
    touch-action: none;
    mask-image: linear-gradient(transparent, #000 13%, #000 87%, transparent);
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

  .lyrics-content {
    --lyric-gap: clamp(22px, calc(var(--lyric-size) * 1.28), 42px);
    --lyric-harmony-gap: calc(var(--lyric-gap) * 0.3);

    position: absolute;
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
    --lyric-fill: rgba(255, 255, 255, 0.3);
    --lyric-idle: rgba(255, 255, 255, 0.3);
    /* 扫光前沿的柔化宽度,硬边会显得像进度条而不是"唱到这里" */
    --lyric-edge: 0.55em;

    position: absolute;
    top: 0;
    left: 0;
    max-width: min(900px, 100%);
    padding: 0;
    border: 0;
    background: none;
    opacity: calc(0.58 - var(--line-distance) * 0.065);
    filter: blur(calc(0.35px + var(--line-distance) * 0.78px));
    font-family: inherit;
    font-size: clamp(24px, calc(var(--lyric-size) * 1.55), 42px);
    font-weight: 690;
    line-height: 1.18;
    letter-spacing: -0.035em;
    text-align: left;
    cursor: default;
    transform-origin: left center;
    /* 每一帧都在改 translate,提前提升为合成层;视口外的行被引擎设为 visibility: hidden,
       不会真的占用位图内存 */
    will-change: translate;
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
    &:hover:not(.active) {
      --lyric-fill: rgba(255, 255, 255, 0.48);
      --lyric-idle: rgba(255, 255, 255, 0.48);
    }

    &.active {
      --lyric-fill: #fff;
      --lyric-idle: rgba(255, 255, 255, 0.34);

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
      font-size: clamp(17px, calc(var(--lyric-size) * 1.02), 27px);
      opacity: calc(0.4 - var(--line-distance) * 0.05);

      &.active {
        opacity: 0.78;
      }
    }
  }

  .lyric-original,
  .lyric-translation,
  .lyric-roman {
    position: relative;
    z-index: 1;
    display: block;
    color: var(--lyric-fill);
    scale: 1;
    transform-origin: inherit;
    transition: scale calc(560ms * var(--lyric-tempo, 1)) cubic-bezier(0.16, 1, 0.3, 1);
  }

  .lyric-line.active .lyric-original,
  .lyric-line.active .lyric-translation,
  .lyric-line.active .lyric-roman {
    scale: 1.012;
  }

  /* 逐字扫光:每个音节是一个独立的行内块,用背景渐变裁到文字上。
     --lyric-word-fill 是这个音节的演唱进度(0…1),由 JS 每帧写入当前行。
     前沿留 --lyric-edge 的渐变过渡,看起来是"亮起来"而不是"被刷过去" */
  .lyric-word {
    /* 左右各留出的绘制余量。字形墨迹横向溢出行内盒的来源有两处:
       行上的 letter-spacing: -0.035em 会让盒宽比最后一个字的字形窄,
       以及 690 字重下 J / f / y 这类字形本身带负边距。
       溢出的那一条同样没有背景可裁,表现为字被左右削掉一道 */
    --lyric-word-bleed: 0.12em;

    display: inline-block;
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
    /* 上浮直接由演唱进度推导:唱到哪抬到哪,唱完保持抬起,不再弹回。
       用脉冲包络的话每个词都会"上去再掉下来",那不是 Apple Music 的做法。
       未激活行的进度恒为 1,整行统一抬起,视觉上等同于没有位移 */
    translate: 0 calc(var(--lyric-word-fill) * -0.05em);
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

  /* 唱过的部分更亮:纯白已经到顶,再要"更亮"只能靠光晕,随演唱进度渐强。
     只挂在当前行上——未激活行的进度恒为 1,不加限定会让整屏歌词一起发光。
     底部深色投影沿用行级的那一层,否则亮底封面上会看不清 */
  .lyric-line.active .lyric-word {
    text-shadow:
      0 0 calc(var(--lyric-word-fill) * 0.34em)
        rgba(255, 255, 255, calc(var(--lyric-word-fill) * 0.42)),
      0 0 calc(var(--lyric-word-fill) * 0.9em)
        rgba(255, 255, 255, calc(var(--lyric-word-fill) * 0.16)),
      0 8px 34px rgba(0, 0, 0, 0.3);
  }

  /* 浏览态下整行压平,发光也一并关掉 */
  .lyrics-panel.browsing .lyric-line.active .lyric-word {
    text-shadow: none;
  }

  /* 音节之间的空格单独成节点:行内块之间没有空白文本节点就不会产生换行机会,
     英文长句会溢出。pre-wrap 保留这个空格的同时保留它的换行能力 */
  .lyric-gap {
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

  /* 用户正在滚动浏览歌词时,当前行的字不该还在上浮——那时的焦点是列表本身 */
  .lyrics-panel.browsing .lyric-word {
    translate: none;
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
      --lyric-fill: rgba(255, 255, 255, 0.84);
      --lyric-idle: rgba(255, 255, 255, 0.84);

      .lyric-original,
      .lyric-translation,
      .lyric-roman {
        scale: 1;
      }
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
  .lyric-line.background .lyric-roman,
  .lyric-line.background .lyric-translation {
    transform-origin: left top;
    scale: calc(0.94 + 0.06 * var(--lyric-harmony));
    filter: blur(calc((1 - var(--lyric-harmony)) * 6px));
  }

  .lyric-line.background.secondary .lyric-original,
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

  .lyrics-panel.animation-disabled {
    .lyric-state-change-enter-active,
    .lyric-state-change-leave-active,
    .lyric-line,
    .lyric-original,
    .lyric-translation,
    .lyric-roman {
      transition-duration: 0ms;
      animation-duration: 0ms;
    }

    .lyric-word {
      translate: none;
    }

    .lyric-line.active .lyric-original,
    .lyric-line.active .lyric-translation,
    .lyric-line.active .lyric-roman {
      scale: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .lyric-state-change-enter-active,
    .lyric-state-change-leave-active,
    .lyric-line,
    .lyric-original,
    .lyric-translation,
    .lyric-roman {
      transition-duration: 0ms;
    }

    .lyric-word {
      translate: none;
    }
  }

  @media (max-width: 720px) {
    .lyrics-content {
      --lyric-gap: clamp(22px, calc(var(--lyric-size) * 1.12), 34px);

      inset: 0 7% 0 7%;
    }

    .lyric-line {
      width: 100%;
      max-width: none;
      font-size: clamp(22px, calc(var(--lyric-size) * 1.35), 34px);

      &.background {
        font-size: clamp(15px, calc(var(--lyric-size) * 0.92), 23px);
      }
    }
  }

  @media (prefers-contrast: more) {
    .lyric-line {
      --lyric-idle: rgba(255, 255, 255, 0.55);

      opacity: 0.55;
      filter: blur(0);

      &.active {
        --lyric-idle: rgba(255, 255, 255, 0.62);

        opacity: 1;
      }
    }

    .lyrics-panel.browsing .lyric-line {
      opacity: 0.72;
    }
  }
</style>
