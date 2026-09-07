<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, ref, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import { usePlayerStore } from '../stores/player'
  import { hasTrackLyricsSource, loadTrackLyrics } from '../services/lyrics'
  import { findActiveLyricIndex, wordFillProgress } from '../utils/lyrics'
  import { createLyricClock } from '../utils/lyric-clock'
  import { listenMediaQuery } from '../utils/media-query'
  import { useLyricsScroll } from '../composables/useLyricsScroll'
  import type {
    LyricAvailability,
    LyricLine,
    LyricStatus,
    LyricWord,
    LyricsSnapshot,
    Track,
  } from '../types/music'

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

  // 滚动提前量:滚动比高亮早启动这么久,弹簧停下来的时刻正好是这一行开唱的时刻。
  // 高亮与逐字扫光本身**不**提前,必须严格对齐音频,否则字比声音先亮
  const LYRIC_SCROLL_LEAD = 0.32
  // 高亮色/模糊过渡的基准时长,行间隔短于它时按比例压缩(见 computeTempoScale)
  const HIGHLIGHT_BASE_DURATION = 620
  const MIN_TEMPO_SCALE = 0.18
  // 前沿柔化宽度的收敛斜率:进度进入 [0, 1/斜率] 或 [1-1/斜率, 1] 时线性收到 0
  const EDGE_FADE_SLOPE = 8
  const store = usePlayerStore()
  const { currentTrack, currentTrackVersion, currentTime, isPlaying, settings } = storeToRefs(store)

  // timeupdate 只有约 4Hz,逐字扫光需要每帧的播放位置,这里统一走外推时钟
  const clock = createLyricClock()
  const lines = ref<LyricLine[]>([])
  const activeIndex = ref(-1)
  const targetIndex = ref(-1)
  const status = ref<LyricStatus>('idle')
  const lyricTempo = ref(1)
  const panel = ref<HTMLElement>()
  const scroller = ref<HTMLElement>()
  const lyricsContent = ref<HTMLElement>()
  const lineElements = ref<HTMLElement[]>([])
  onBeforeUpdate(() => {
    lineElements.value = []
  })
  const userScrolling = ref(false)
  let isPanelMounted = false
  let isProgrammaticScroll = false
  let scrollTimer = 0
  let realignRaf = 0
  let resizeRealignTimer = 0
  let realignRequestId = 0
  let programmaticScrollTimer = 0
  let requestId = 0
  let renderFrame = 0
  let lyricsController: AbortController | null = null
  let resizeObserver: ResizeObserver | null = null
  // 视口尺寸监听只用单一事件源:支持 visualViewport 的平台(移动端)用它,
  // 否则退回 window,避免双事件源重复调度 realign
  const viewportResizeTarget: Window | VisualViewport | null =
    typeof window !== 'undefined' ? (window.visualViewport ?? window) : null
  let stopReducedMotionListener: (() => void) | null = null
  const reducedMotionQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  let prefersReducedMotion = reducedMotionQuery?.matches ?? false
  function handleReducedMotionChange(event: MediaQueryListEvent | MediaQueryList) {
    prefersReducedMotion = event.matches
    if (prefersReducedMotion) cancelLyricsScroll()
  }

  const {
    scrollToIndex,
    cancel: cancelLyricsScroll,
    isAnimating: realignAnimating,
  } = useLyricsScroll({
    getScroller: () => scroller.value,
    getLineElements: () => lineElements.value,
    isAnimated: () => settings.value.lyricAnimation && !prefersReducedMotion,
  })

  function clamp(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, value))
  }

  onMounted(() => {
    isPanelMounted = true
    if (reducedMotionQuery) {
      stopReducedMotionListener = listenMediaQuery(reducedMotionQuery, handleReducedMotionChange)
    }
    viewportResizeTarget?.addEventListener('resize', handleViewportResize, { passive: true })
    document.addEventListener('visibilitychange', handleVisibilityChange)
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        scheduleRealign({ animate: false })
      })
      observeLyricsLayout()
    }
    scheduleRealign({ animate: false })
  })

  function observeLyricsLayout() {
    if (!resizeObserver) return
    resizeObserver.disconnect()
    if (panel.value) resizeObserver.observe(panel.value)
    if (scroller.value) resizeObserver.observe(scroller.value)
    if (lyricsContent.value) resizeObserver.observe(lyricsContent.value)
  }

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
      activeIndex: activeIndex.value,
      status: status.value,
      tempoScale: lyricTempo.value,
    })
  }

  // 下一句的起始时间。背景和声(x-bg)在数组里是独立一行,但它属于当前这一句,
  // 起始时间往往和主行只差零点几秒。把它当成"下一句"会让行间隔被严重低估,
  // 高亮过渡和牵引波被压到几乎为零——表现就是有和声的句子突然变暗、没有动画
  function nextPrimaryTime(index: number): number | null {
    for (let cursor = index + 1; cursor < lines.value.length; cursor += 1) {
      const line = lines.value[cursor]
      if (line?.background) continue
      return line?.time ?? null
    }
    return null
  }

  // 行间隔短于整套高亮过渡时长时按比例压缩,让快节奏歌词的高亮跟得上换行。
  // 位移不再需要压缩——弹簧本身可被打断,新目标直接接管当前速度
  function computeTempoScale(index: number): number {
    const current = lines.value[index]?.time
    const next = nextPrimaryTime(index)
    if (current === null || current === undefined) return 1
    if (next === null) return 1
    return clamp(((next - current) * 1000) / HIGHLIGHT_BASE_DURATION, MIN_TEMPO_SCALE, 1)
  }

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
      syncActiveLyric(readClock(), { realign: false })
      updateStatus('ready')
      await nextTick()
      if (id !== requestId) return
      bindKaraoke(activeIndex.value)
      scheduleRealign({ animate: false })
      startRenderLoop()
    } catch (error) {
      // 只有面板自己 abort(切歌/卸载)才静默返回;服务层的加载超时
      // 已包装为 LyricsTimeoutError(见 services/lyrics),会落到 error 态
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (id === requestId) updateStatus('error')
    }
  }

  function markProgrammaticScroll() {
    isProgrammaticScroll = true
    window.clearTimeout(programmaticScrollTimer)
    programmaticScrollTimer = window.setTimeout(() => {
      isProgrammaticScroll = false
    }, 180)
  }

  function markUserScrolling() {
    cancelLyricsScroll()
    userScrolling.value = true
    window.clearTimeout(scrollTimer)
    scrollTimer = window.setTimeout(() => {
      userScrolling.value = false
      scheduleRealign()
    }, 3200)
  }

  function handleScrollIntent() {
    markUserScrolling()
  }

  function handleScroll() {
    if (isProgrammaticScroll) return
    markUserScrolling()
  }

  const SCROLL_INTENT_KEYS = new Set([
    'ArrowDown',
    'ArrowUp',
    'End',
    'Home',
    'PageDown',
    'PageUp',
    ' ',
  ])

  function handleKeydown(event: KeyboardEvent) {
    if (!SCROLL_INTENT_KEYS.has(event.key)) return
    // 歌词行按钮上的 Space 由按钮自身处理(preventDefault 后触发 seek),
    // 不会滚动容器,因此不标记为用户滚动
    if (event.key === ' ' && (event.target as HTMLElement | null)?.closest('.lyric-line')) return
    handleScrollIntent()
  }

  function handleViewportResize() {
    userScrolling.value = false
    window.clearTimeout(scrollTimer)
    window.clearTimeout(resizeRealignTimer)
    scheduleRealign({ animate: false })
    resizeRealignTimer = window.setTimeout(() => {
      scheduleRealign({ animate: false })
    }, 180)
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

  function resetTransientLyrics() {
    lyricsController?.abort()
    lyricsController = null
    stopRenderLoop()
    window.clearTimeout(scrollTimer)
    window.clearTimeout(resizeRealignTimer)
    window.clearTimeout(programmaticScrollTimer)
    window.cancelAnimationFrame(realignRaf)
    realignRaf = 0
    userScrolling.value = false
    isProgrammaticScroll = false
    cancelLyricsScroll()
    releaseKaraoke()
    lyricTempo.value = 1
    lines.value = []
    lineElements.value = []
    activeIndex.value = -1
    targetIndex.value = -1
    status.value = 'idle'
    if (scroller.value) scroller.value.scrollTop = 0
  }

  // 距离下一次换行还剩多少毫秒。牵引波的逐行延迟按它压缩,
  // 否则快段落里上一道波还铺在半空,下一行就来了,行与行会叠在一起
  function scrollBudgetMs(index: number): number {
    const next = nextPrimaryTime(index)
    if (next === null) return Number.POSITIVE_INFINITY
    return (next - LYRIC_SCROLL_LEAD - readClock()) * 1000
  }

  interface ScheduleRealignOptions {
    animate?: boolean
  }

  function scheduleRealign(options: ScheduleRealignOptions = {}) {
    if (!props.active || userScrolling.value || targetIndex.value < 0) return
    const id = ++realignRequestId
    window.cancelAnimationFrame(realignRaf)
    void nextTick(() => {
      if (!isPanelMounted || id !== realignRequestId) return
      realignRaf = window.requestAnimationFrame(() => {
        if (!isPanelMounted || id !== realignRequestId) return
        // 排期与执行之间隔了 nextTick + 一帧,期间用户可能已经接管滚动
        // 或面板被切走,必须在真正写 scrollTop 之前再确认一次
        if (!props.active || userScrolling.value || targetIndex.value < 0) return
        if (!lineElements.value[targetIndex.value]) {
          // 行节点还没渲染出来(歌词刚就绪 / 列表重建中):下一帧再试一次。
          // 这里不推进 realignRequestId,期间若目标变化会由新的 realign 接管
          realignRaf = window.requestAnimationFrame(() => {
            if (!isPanelMounted || id !== realignRequestId) return
            if (!props.active || userScrolling.value || targetIndex.value < 0) return
            markProgrammaticScroll()
            scrollToIndex(targetIndex.value, {
              animate: options.animate,
              budgetMs: scrollBudgetMs(targetIndex.value),
            })
          })
          return
        }
        markProgrammaticScroll()
        scrollToIndex(targetIndex.value, {
          animate: options.animate,
          budgetMs: scrollBudgetMs(targetIndex.value),
        })
      })
    })
  }

  // ---- 逐字扫光 ----
  // 只有当前行需要每帧写入;其余行由 CSS 的 `:not(.active) { --lyric-word-fill: 1 }` 兜底。
  // 同一时刻只有一个音节处于"半亮"状态,写入前比对上一次的值,每帧实际只有一两个节点被改动

  interface KaraokeTarget {
    element: HTMLElement
    word: LyricWord
    lastFill: string
    lastEdge: string
  }

  let karaokeTargets: KaraokeTarget[] = []
  let karaokeIndex = -1

  function releaseKaraoke() {
    for (const target of karaokeTargets) {
      if (!target.element.isConnected) continue
      target.element.style.removeProperty('--lyric-word-fill')
      target.element.style.removeProperty('--lyric-word-edge')
    }
    karaokeTargets = []
    karaokeIndex = -1
  }

  function bindKaraoke(index: number) {
    releaseKaraoke()
    const group = index < 0 ? [] : activeGroup.value
    const targets: KaraokeTarget[] = []

    for (const lineIndex of group) {
      const line = displayedLines.value[lineIndex]
      if (!line?.words?.length) continue
      const element = lineElements.value[lineIndex]
      const spans = element?.querySelectorAll<HTMLElement>('.lyric-word')
      // 节点还没跟上数据时保持 karaokeIndex = -1,下一帧会自动重绑
      if (!spans || spans.length !== line.words.length) return
      for (const [wordIndex, word] of line.words.entries()) {
        targets.push({ element: spans[wordIndex], word, lastFill: '', lastEdge: '' })
      }
    }

    karaokeIndex = index
    karaokeTargets = targets
  }

  function writeKaraoke(time: number) {
    if (!karaokeTargets.length) return

    for (const target of karaokeTargets) {
      const progress = wordFillProgress(time, target.word)
      const fill = progress.toFixed(3)
      if (fill !== target.lastFill) {
        target.lastFill = fill
        target.element.style.setProperty('--lyric-word-fill', fill)
      }
      // 只有正在推进的词才有柔化前沿,已唱完和未开唱的词一律实色
      const edge = clamp(Math.min(progress, 1 - progress) * EDGE_FADE_SLOPE, 0, 1).toFixed(3)
      if (edge !== target.lastEdge) {
        target.lastEdge = edge
        target.element.style.setProperty('--lyric-word-edge', edge)
      }
    }
  }

  // ---- 每帧渲染循环 ----

  function readClock(): number {
    return clock.read(performance.now())
  }

  interface SyncActiveLyricOptions {
    realign?: boolean
    animate?: boolean
    forceRealign?: boolean
  }

  // 背景和声(TTML 的 x-bg)有自己的时间轴,但它不是"另一行歌词":
  // 让它参与当前行的选取会使高亮与滚动在主行和它的和声之间来回跳。
  // 这里把命中和声时的索引退回它所属的主行,和声行随主行一起点亮
  function resolvePrimaryIndex(index: number): number {
    let cursor = index
    while (cursor > 0 && lines.value[cursor]?.background) cursor -= 1
    return cursor
  }

  function syncActiveLyric(time: number, options: SyncActiveLyricOptions = {}) {
    const hasLines = lines.value.length > 0
    const nextActive = hasLines ? resolvePrimaryIndex(findActiveLyricIndex(lines.value, time)) : -1
    // 滚动目标提前一点点选出下一行,高亮本身严格对齐音频
    const nextTarget = hasLines
      ? resolvePrimaryIndex(findActiveLyricIndex(lines.value, time + LYRIC_SCROLL_LEAD))
      : -1

    if (nextActive !== activeIndex.value) {
      activeIndex.value = nextActive
      lyricTempo.value = nextActive < 0 ? 1 : computeTempoScale(nextActive)
      emitSnapshot()
      bindKaraoke(nextActive)
    }

    const targetChanged = nextTarget !== targetIndex.value
    targetIndex.value = nextTarget
    if ((options.realign ?? true) && (targetChanged || options.forceRealign)) {
      scheduleRealign({ animate: options.animate })
    }
  }

  function renderOnce() {
    if (!isPanelMounted || status.value !== 'ready') return
    const time = readClock()
    syncActiveLyric(time)
    // 行节点被 Vue 重建(切换译文显示、字号变化)后旧的音节引用会失效,
    // 这里按索引比对自愈,不依赖任何一处的调用时序
    if (karaokeIndex !== activeIndex.value || !karaokeTargets[0]?.element.isConnected) {
      bindKaraoke(activeIndex.value)
    }
    writeKaraoke(time)
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

  function seekLine(line: LyricLine) {
    if (line.time !== null) emit('seek', line.time)
  }

  const lyricPanelStyle = computed(() => ({
    '--lyric-size': `${settings.value.lyricFontSize}px`,
    '--lyric-tempo': lyricTempo.value,
  }))

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

  // 主行加上紧跟它的和声行,共同构成"当前行组":一起高亮、一起走扫光
  const activeGroup = computed<number[]>(() => {
    if (activeIndex.value < 0) return []
    const group = [activeIndex.value]
    for (
      let cursor = activeIndex.value + 1;
      cursor < displayedLines.value.length && displayedLines.value[cursor]?.background;
      cursor += 1
    ) {
      group.push(cursor)
    }
    return group
  })

  function lineDistanceClass(index: number): string {
    const distance = activeIndex.value < 0 ? 0 : Math.min(Math.abs(index - activeIndex.value), 5)
    return `distance-${distance}`
  }

  // roving tabindex:仅当前激活行(无激活行时退回第一个可 seek 的行)是 Tab 停靠点,
  // 避免数百行歌词全部进入 Tab 序列
  const keyboardFocusIndex = computed(() => {
    if (activeIndex.value >= 0) return activeIndex.value
    return displayedLines.value.findIndex((line) => line.time !== null)
  })

  watch(
    () => [currentTrack.value?.id, currentTrackVersion.value] as const,
    () => void loadLyrics(currentTrack.value),
    { immediate: true },
  )
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
    () => {
      scheduleRealign({ animate: false })
    },
  )
  watch(
    () => settings.value.lyricAnimation,
    (enabled) => {
      if (!enabled) cancelLyricsScroll()
      scheduleRealign({ animate: false })
    },
  )
  watch(
    () => settings.value.lyricTranslation,
    () => {
      emitSnapshot()
      void nextTick(() => bindKaraoke(activeIndex.value))
      scheduleRealign({ animate: false })
    },
  )
  watch(
    () => props.active,
    (active) => {
      if (!active) {
        stopRenderLoop()
        cancelLyricsScroll()
        return
      }
      syncActiveLyric(readClock(), { animate: false, forceRealign: true })
      void nextTick(() => bindKaraoke(activeIndex.value))
      startRenderLoop()
    },
  )
  watch(lyricsContent, () => {
    observeLyricsLayout()
    scheduleRealign({ animate: false })
  })
  watch(panel, () => {
    observeLyricsLayout()
    scheduleRealign({ animate: false })
  })
  onBeforeUnmount(() => {
    isPanelMounted = false
    stopRenderLoop()
    window.clearTimeout(scrollTimer)
    window.clearTimeout(resizeRealignTimer)
    window.cancelAnimationFrame(realignRaf)
    window.clearTimeout(programmaticScrollTimer)
    lyricsController?.abort()
    resizeObserver?.disconnect()
    viewportResizeTarget?.removeEventListener('resize', handleViewportResize)
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    releaseKaraoke()
    stopReducedMotionListener?.()
    stopReducedMotionListener = null
  })
</script>

<template>
  <section
    ref="panel"
    class="lyrics-panel"
    :class="{
      browsing: userScrolling,
      'animation-disabled': !settings.lyricAnimation,
      'realign-animating': realignAnimating,
    }"
    :style="lyricPanelStyle"
    aria-label="歌词"
  >
    <div
      ref="scroller"
      class="lyrics-scroll"
      @scroll.passive="handleScroll"
      @wheel.passive="handleScrollIntent"
      @touchmove.passive="handleScrollIntent"
      @keydown="handleKeydown"
    >
      <Transition name="lyric-state-change" mode="out-in">
        <div
          v-if="
            status === 'empty' || status === 'idle' || status === 'loading' || status === 'error'
          "
          key="empty"
          class="lyric-stage"
        />
        <div v-else key="lyrics" class="lyric-stage">
          <div ref="lyricsContent" class="lyrics-content">
            <button
              v-for="(line, index) in displayedLines"
              :key="`${line.time}-${index}`"
              :ref="
                (element) => {
                  if (element) lineElements[index] = element as HTMLElement
                }
              "
              class="lyric-line"
              :class="[
                lineDistanceClass(index),
                {
                  active: activeGroup.includes(index),
                  timed: line.time !== null,
                  targeted: index === targetIndex,
                  secondary: line.agent === 'secondary',
                  background: line.background,
                  karaoke: Boolean(line.words?.length),
                },
              ]"
              :disabled="line.time === null"
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
              <Transition name="translation-toggle">
                <span v-if="line.translation" class="lyric-translation">{{
                  line.translation
                }}</span>
              </Transition>
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

  .lyrics-scroll {
    position: relative;
    height: 100%;
    overflow-y: auto;
    scrollbar-width: none;
    mask-image: linear-gradient(transparent, #000 13%, #000 87%, transparent);

    &::-webkit-scrollbar {
      display: none;
    }
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
    display: flex;
    min-height: 100%;
    flex-direction: column;
    align-items: flex-start;
    gap: clamp(22px, calc(var(--lyric-size) * 1.28), 42px);
    padding: 42vh 7% 46vh 3%;
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

    position: relative;
    max-width: 900px;
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
    translate: 0 0;
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
      align-self: flex-end;
      text-align: right;
      transform-origin: right center;
    }

    /* 背景和声:更小更淡,附在主行下方 */
    &.background {
      margin-top: calc(var(--lyric-size) * -0.25);
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
    display: inline-block;
    /* background-clip: text 只在元素自身的背景盒内绘制。行高 1.18 比字体的自然行盒紧,
       g / y / p / q 的降部会伸出盒外,那一截没有背景可裁就被切掉。
       用 padding 撑开绘制盒、再用等量负 margin 抵消掉它对排版的影响 */
    padding: 0.08em 0 0.16em;
    margin: -0.08em 0 -0.16em;
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

  .translation-toggle-enter-active,
  .translation-toggle-leave-active {
    /* 折叠动画期间才需要裁剪。常态下留着它,会把继承自当前行的 text-shadow
       沿元素边界切成一个可见的矩形 */
    overflow: hidden;
    max-height: 2.2em;
    transition:
      max-height 360ms cubic-bezier(0.16, 1, 0.3, 1),
      margin-top 360ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 260ms ease,
      translate 360ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .translation-toggle-enter-from,
  .translation-toggle-leave-to {
    max-height: 0;
    margin-top: 0;
    opacity: 0;
    translate: 0 -0.18em;
  }

  .translation-toggle-enter-to,
  .translation-toggle-leave-from {
    max-height: 2.2em;
    opacity: 0.76;
    translate: 0 0;
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

  .lyrics-panel.realign-animating .lyric-line {
    /* 只在位移动画期间临时提升合成层,避免数百行歌词常驻 will-change 的内存开销 */
    will-change: translate;
  }

  .lyrics-panel.animation-disabled {
    .lyric-state-change-enter-active,
    .lyric-state-change-leave-active,
    .translation-toggle-enter-active,
    .translation-toggle-leave-active,
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
    .translation-toggle-enter-active,
    .translation-toggle-leave-active {
      transition-duration: 0ms;
    }

    .lyric-line {
      transition-duration: 0ms;
    }

    .lyric-word {
      translate: none;
    }
  }

  @media (max-width: 720px) {
    .lyrics-content {
      gap: clamp(22px, calc(var(--lyric-size) * 1.12), 34px);
      padding: 40vh 7% 44vh;
    }

    .lyric-line {
      width: 100%;
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
