<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, ref, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import { usePlayerStore } from '../stores/player'
  import { hasTrackLyricsSource, loadTrackLyrics } from '../services/lyrics'
  import { findActiveLyricIndex } from '../utils/lyrics'
  import { supportsWebAnimations } from '../utils/browser'
  import { listenMediaQuery } from '../utils/media-query'
  import type {
    LyricAvailability,
    LyricLine,
    LyricStatus,
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
  const LYRIC_MOTION_LEAD = 0.42
  // FLIP 滚动动画基准节奏:时长 980ms + 每行 48ms 交错延迟
  const REALIGN_BASE_DURATION = 980
  const REALIGN_BASE_DELAY_STEP = 48
  // 距离下一行 realign 的剩余时间不足该预算时直接瞬移,避免动画刚开始就被下一行打断
  const REALIGN_MIN_BUDGET_MS = 260
  // scrollToIndex 参与位移动画的窗口最大为 min(prev,index)-5 .. max(prev,index)+7,即 13 行
  const MAX_STAGGERED_LINES = 13
  const store = usePlayerStore()
  const { currentTrack, currentTrackVersion, currentTime, isPlaying, settings } = storeToRefs(store)
  // currentTime 仅由 timeupdate 事件驱动(约 4Hz),快节奏歌词(行间隔可达 10ms 级)
  // 会成片跳行。这里以每次 currentTime 更新为锚点做 rAF 外推,得到 60fps 的同步时钟,
  // 锚点每次更新会自动校正漂移;暂停时外推停止,时钟冻结在锚点。
  const lyricClock = ref(currentTime.value)
  let clockAnchorTime = currentTime.value
  let clockAnchorStamp = performance.now()
  let clockRaf = 0
  const lines = ref<LyricLine[]>([])
  const activeIndex = ref(-1)
  const targetIndex = ref(-1)
  const status = ref<LyricStatus>('idle')
  // 快节奏歌词(行间隔短于整套动画时长)下的动画压缩系数,驱动 FLIP 时长、
  // 高亮 CSS 过渡与 PiP 歌词窗;1 表示完整节奏,0 表示瞬切
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
  let scrollRaf = 0
  let realignRaf = 0
  let resizeRealignTimer = 0
  let realignRequestId = 0
  let programmaticScrollTimer = 0
  let requestId = 0
  let lyricsController: AbortController | null = null
  let resizeObserver: ResizeObserver | null = null
  // 视口尺寸监听只用单一事件源:支持 visualViewport 的平台(移动端)用它,
  // 否则退回 window,避免双事件源重复调度 realign
  const viewportResizeTarget: Window | VisualViewport | null =
    typeof window !== 'undefined' ? (window.visualViewport ?? window) : null
  const lineAnimations = new Set<Animation>()
  let realignAnimationTimer = 0
  const realignAnimating = ref(false)
  let stopReducedMotionListener: (() => void) | null = null
  const reducedMotionQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  let prefersReducedMotion = reducedMotionQuery?.matches ?? false
  function handleReducedMotionChange(event: MediaQueryListEvent | MediaQueryList) {
    prefersReducedMotion = event.matches
  }
  onMounted(() => {
    isPanelMounted = true
    if (reducedMotionQuery) {
      stopReducedMotionListener = listenMediaQuery(reducedMotionQuery, handleReducedMotionChange)
    }
    viewportResizeTarget?.addEventListener('resize', handleViewportResize, { passive: true })
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

  // 距离下一行 realign 的剩余时间(ms);下一行无时间戳(纯文本歌词/最后一行)时视为无限预算
  function getRealignBudgetMs(index: number): number {
    const nextLineTime = lines.value[index + 1]?.time
    return nextLineTime === null || nextLineTime === undefined
      ? Number.POSITIVE_INFINITY
      : (nextLineTime - LYRIC_MOTION_LEAD - lyricClock.value) * 1000
  }

  // 快节奏歌词(如说唱)行间隔可能短于整套动画时长,不压缩的话滚动与高亮会一路落后于
  // 播放位置。按剩余预算等比压缩;预算不足 REALIGN_MIN_BUDGET_MS 时返回 0,直接瞬切。
  function computeTempoScale(index: number, staggeredLines: number): number {
    if (index < 0) return 1
    const budgetMs = getRealignBudgetMs(index)
    if (budgetMs < REALIGN_MIN_BUDGET_MS) return 0
    const baseTotal =
      REALIGN_BASE_DURATION + Math.max(staggeredLines - 1, 0) * REALIGN_BASE_DELAY_STEP
    return Math.min(1, budgetMs / baseTotal)
  }

  async function loadLyrics(track: Track | null) {
    const id = ++requestId
    resetTransientLyrics()
    if (!track) {
      updateStatus('empty')
      return
    }
    if (!hasTrackLyricsSource(track)) {
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
      syncActiveLyric({ realign: false })
      // 歌词就绪后若开局就是密集段落,立即接管高频时钟,
      // 不等第一个 timeupdate(最多 ~250ms)才启动
      ensureClockLoop()
      updateStatus('ready')
      await nextTick()
      if (id !== requestId) return
      scheduleRealign()
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

  function markUserScrolling(options: { resetRestoreTimer?: boolean } = {}) {
    cancelLineAnimations()
    userScrolling.value = true
    if (options.resetRestoreTimer ?? true) {
      window.clearTimeout(scrollTimer)
      scrollTimer = window.setTimeout(() => {
        userScrolling.value = false
        scheduleRealign()
      }, 3200)
    }
  }

  function handleScrollIntent() {
    markUserScrolling({ resetRestoreTimer: true })
  }

  function handleScroll() {
    if (isProgrammaticScroll) return
    markUserScrolling({ resetRestoreTimer: true })
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

  function cancelLineAnimations() {
    lineAnimations.forEach((animation) => animation.cancel())
    lineAnimations.clear()
    window.clearTimeout(realignAnimationTimer)
    realignAnimating.value = false
  }

  function resetTransientLyrics() {
    lyricsController?.abort()
    lyricsController = null
    window.clearTimeout(scrollTimer)
    window.clearTimeout(resizeRealignTimer)
    window.clearTimeout(programmaticScrollTimer)
    window.cancelAnimationFrame(scrollRaf)
    window.cancelAnimationFrame(realignRaf)
    scrollRaf = 0
    realignRaf = 0
    userScrolling.value = false
    isProgrammaticScroll = false
    cancelLineAnimations()
    lyricTempo.value = 1
    lines.value = []
    lineElements.value = []
    activeIndex.value = -1
    targetIndex.value = -1
    status.value = 'idle'
    if (scroller.value) scroller.value.scrollTop = 0
  }

  interface ScheduleRealignOptions {
    animate?: boolean
    previousIndex?: number
  }

  function scheduleRealign(options: ScheduleRealignOptions = {}) {
    if (!props.active || userScrolling.value || targetIndex.value < 0) return
    // 动画进行中来了新 realign 不挂起:scrollToIndex 会从实时视觉位置无缝重定向,
    // 避免高亮已切换而滚动还在等上一段动画播完的错位
    if (options.animate === false) {
      window.clearTimeout(realignAnimationTimer)
      realignAnimating.value = false
    }
    const id = ++realignRequestId
    window.cancelAnimationFrame(realignRaf)
    void nextTick(() => {
      if (!isPanelMounted || id !== realignRequestId) return
      realignRaf = window.requestAnimationFrame(() => {
        if (!isPanelMounted || id !== realignRequestId) return
        scrollToIndex(targetIndex.value, undefined, {
          animate: options.animate,
          previousIndex: options.previousIndex,
        })
      })
    })
  }

  interface SyncActiveLyricOptions {
    realign?: boolean
    animate?: boolean
    forceRealign?: boolean
  }

  function syncActiveLyric(options: SyncActiveLyricOptions = {}) {
    const syncTime = lyricClock.value + LYRIC_MOTION_LEAD
    const nextIndex =
      status.value === 'ready' || lines.value.length > 0
        ? findActiveLyricIndex(lines.value, syncTime)
        : -1
    const previousIndex = activeIndex.value
    const changed = nextIndex !== targetIndex.value || nextIndex !== previousIndex

    targetIndex.value = nextIndex
    activeIndex.value = nextIndex

    if (changed) {
      lyricTempo.value = computeTempoScale(nextIndex, MAX_STAGGERED_LINES)
      emitSnapshot()
    }
    const shouldRealign = options.realign ?? true
    if (shouldRealign && (changed || options.forceRealign)) {
      scheduleRealign({ animate: options.animate, previousIndex })
    }
  }

  interface ScrollToIndexOptions {
    animate?: boolean
    previousIndex?: number
  }

  function scrollToIndex(
    index: number,
    onComplete?: () => void,
    options: ScrollToIndexOptions = {},
  ) {
    if (userScrolling.value || index < 0) {
      onComplete?.()
      return
    }
    const container = scroller.value
    const element = lineElements.value[index]
    if (!container || !element) {
      if (!isPanelMounted) {
        onComplete?.()
        return
      }
      window.cancelAnimationFrame(scrollRaf)
      scrollRaf = window.requestAnimationFrame(() => {
        // 元素未就绪的重试不受 realignRequestId 保护:若等待期间目标行已变化,
        // 放弃本次旧目标(新的 realign 会接管),避免向旧行多滚一次
        if (targetIndex.value !== index) {
          onComplete?.()
          return
        }
        scrollToIndex(index, onComplete, options)
      })
      return
    }
    const target = Math.max(
      0,
      Math.min(
        element.offsetTop - container.clientHeight / 2 + element.clientHeight / 2,
        container.scrollHeight - container.clientHeight,
      ),
    )

    const shouldAnimate =
      options.animate !== false &&
      settings.value.lyricAnimation &&
      !prefersReducedMotion &&
      supportsWebAnimations()

    if (!shouldAnimate) {
      markProgrammaticScroll()
      cancelLineAnimations()
      container.scrollTop = target
      onComplete?.()
      return
    }

    const movement = target - container.scrollTop
    if (Math.abs(movement) < 1) {
      onComplete?.()
      return
    }

    // 快节奏歌词行间隔可能短于整套动画时长,预算不足时直接瞬移到位,
    // 避免动画刚开始就被下一行打断(压缩逻辑见 computeTempoScale)
    const realignBudgetMs = getRealignBudgetMs(index)
    if (realignBudgetMs < REALIGN_MIN_BUDGET_MS) {
      markProgrammaticScroll()
      cancelLineAnimations()
      container.scrollTop = target
      onComplete?.()
      return
    }

    const elements = lineElements.value
    const totalLines = elements.length
    const previousIndex =
      options.previousIndex !== undefined && options.previousIndex >= 0
        ? options.previousIndex
        : activeIndex.value >= 0
          ? activeIndex.value
          : index
    const animationStart = Math.max(0, Math.min(previousIndex, index) - 5)
    const animationEnd = Math.min(totalLines - 1, Math.max(previousIndex, index) + 7)

    interface VisibleLine {
      line: HTMLElement
      before: number
    }
    const visibleLines: VisibleLine[] = []
    for (let i = animationStart; i <= animationEnd; i += 1) {
      const line = elements[i]
      if (!line) continue
      visibleLines.push({
        line,
        // 先测量再取消:进行中的动画(fill: both)仍作用于 rect,
        // before 记录的是当前真实视觉位置,重定向时动画才能无缝衔接
        before: line.getBoundingClientRect().top,
      })
    }

    markProgrammaticScroll()
    cancelLineAnimations()
    container.scrollTop = target

    // 第二遍测量拿到滚动后的布局位置,offset = 视觉位置与布局位置的实际差值。
    // 无进行中动画时恒等于 movement;重定向时包含上一段动画的残余位移。
    // 纯 scroll 不会触发 reflow,两次 rect 查询不引入额外的强制布局
    interface MovingLine extends VisibleLine {
      offset: number
    }
    const movingLines: MovingLine[] = []
    for (const visible of visibleLines) {
      const offset = visible.before - visible.line.getBoundingClientRect().top
      if (Math.abs(offset) >= 1) movingLines.push({ ...visible, offset })
    }
    if (movingLines.length === 0) {
      onComplete?.()
      return
    }
    movingLines.sort((left, right) => left.before - right.before)

    const baseTotal =
      REALIGN_BASE_DURATION + Math.max(movingLines.length - 1, 0) * REALIGN_BASE_DELAY_STEP
    const tempoScale = Math.min(1, realignBudgetMs / baseTotal)
    const duration = REALIGN_BASE_DURATION * tempoScale
    const delayStep = REALIGN_BASE_DELAY_STEP * tempoScale

    movingLines.forEach(({ line, offset }, order) => {
      const delayOrder = movement > 0 ? order : movingLines.length - order - 1
      const directionalLag =
        movement > 0 ? Math.min(delayOrder, 7) * 5 : -Math.min(delayOrder, 7) * 5
      const animation = line.animate(
        [
          {
            translate: `0 ${offset}px`,
          },
          {
            translate: `0 ${offset * 0.46 + directionalLag}px`,
            offset: 0.56,
          },
          {
            translate: '0 0',
          },
        ],
        {
          duration,
          delay: delayOrder * delayStep,
          easing: 'cubic-bezier(0.16, 0.76, 0.18, 1)',
          fill: 'both',
        },
      )
      animation.onfinish = () => {
        lineAnimations.delete(animation)
      }
      animation.oncancel = () => {
        lineAnimations.delete(animation)
      }
      lineAnimations.add(animation)
    })

    const longestDelay = Math.max(movingLines.length - 1, 0) * delayStep
    realignAnimating.value = true
    window.clearTimeout(realignAnimationTimer)
    realignAnimationTimer = window.setTimeout(
      () => {
        realignAnimating.value = false
        onComplete?.()
      },
      duration + longestDelay + 40,
    )
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
      if (!line.translation) return line
      return {
        time: line.time,
        text: line.text,
      }
    })
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
    clockAnchorTime = value
    clockAnchorStamp = performance.now()
    lyricClock.value = value
  })
  watch(lyricClock, () => {
    syncActiveLyric({ animate: true })
    ensureClockLoop()
  })

  // 距离下一次换行不足该阈值才启用 rAF 外推;稀疏段落 timeupdate(约 4Hz)已足够,
  // 时钟保持事件驱动,避免慢歌整首空转 60fps。阈值需大于 timeupdate 间隔(约 250ms),
  // 保证事件驱动的段落也能在下一次换行前及时接管
  const CLOCK_HIGH_RATE_THRESHOLD_MS = 500

  function needsHighRateClock(): boolean {
    if (targetIndex.value < 0) return false
    return getRealignBudgetMs(targetIndex.value) < CLOCK_HIGH_RATE_THRESHOLD_MS
  }

  function ensureClockLoop() {
    if (!isPlaying.value || clockRaf || !needsHighRateClock()) return
    clockRaf = window.requestAnimationFrame(tickLyricClock)
  }

  function tickLyricClock() {
    clockRaf = 0
    // 外推增量封顶 1s:缓冲 stall 期间 timeupdate 停发但 isPlaying 仍为 true,
    // 不封顶的话歌词会一直超前于实际音频,恢复后整体回跳
    const extrapolated = clockAnchorTime + (performance.now() - clockAnchorStamp) / 1000
    lyricClock.value = Math.min(extrapolated, clockAnchorTime + 1)
    // 密集段落持续外推;回到稀疏段落后停转,等下一次 timeupdate 重新评估
    if (needsHighRateClock()) clockRaf = window.requestAnimationFrame(tickLyricClock)
  }
  watch(
    isPlaying,
    (playing, wasPlaying) => {
      if (clockRaf) {
        window.cancelAnimationFrame(clockRaf)
        clockRaf = 0
      }
      if (!playing) return
      if (wasPlaying === false) {
        // 暂停期间锚点持续老化,恢复时先以当前 currentTime 重锚,
        // 避免首个外推帧跨越整个暂停时长跳到未来位置再弹回
        clockAnchorTime = currentTime.value
        clockAnchorStamp = performance.now()
        lyricClock.value = clockAnchorTime
      }
      ensureClockLoop()
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
    () => {
      scheduleRealign({ animate: false })
    },
  )
  watch(
    () => settings.value.lyricTranslation,
    () => {
      emitSnapshot()
      scheduleRealign({ animate: false })
    },
  )
  watch(
    () => props.active,
    (active) => {
      if (!active) return
      syncActiveLyric({ animate: false, forceRealign: true })
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
    window.clearTimeout(scrollTimer)
    window.clearTimeout(resizeRealignTimer)
    window.cancelAnimationFrame(scrollRaf)
    window.cancelAnimationFrame(realignRaf)
    window.cancelAnimationFrame(clockRaf)
    clockRaf = 0
    window.clearTimeout(programmaticScrollTimer)
    window.clearTimeout(realignAnimationTimer)
    lyricsController?.abort()
    resizeObserver?.disconnect()
    viewportResizeTarget?.removeEventListener('resize', handleViewportResize)
    cancelLineAnimations()
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
                  active: index === activeIndex,
                  timed: line.time !== null,
                  targeted: index === targetIndex,
                },
              ]"
              :disabled="line.time === null"
              :tabindex="index === keyboardFocusIndex ? 0 : -1"
              @click="seekLine(line)"
              @keydown.enter.prevent="seekLine(line)"
              @keydown.space.prevent="seekLine(line)"
              @keyup.space.prevent
            >
              <span class="lyric-original">{{ line.text }}</span>
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

    position: relative;
    max-width: 900px;
    padding: 0;
    border: 0;
    background: none;
    color: rgba(255, 255, 255, 0.28);
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
      color calc(920ms * var(--lyric-tempo, 1)) cubic-bezier(0.22, 1, 0.36, 1),
      opacity calc(920ms * var(--lyric-tempo, 1)) cubic-bezier(0.22, 1, 0.36, 1),
      filter calc(920ms * var(--lyric-tempo, 1)) cubic-bezier(0.22, 1, 0.36, 1),
      text-shadow calc(920ms * var(--lyric-tempo, 1)) cubic-bezier(0.22, 1, 0.36, 1);

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
      color: rgba(255, 255, 255, 0.48);
    }

    &.active {
      color: #fff;
      opacity: 1;
      filter: blur(0);
      text-shadow:
        0 0 10px rgba(255, 255, 255, 0.22),
        0 0 30px rgba(255, 255, 255, 0.15),
        0 8px 34px rgba(0, 0, 0, 0.3);
    }
  }

  .lyric-original,
  .lyric-translation {
    position: relative;
    z-index: 1;
    display: block;
    scale: 1;
    transform-origin: left center;
    transition: scale calc(920ms * var(--lyric-tempo, 1)) cubic-bezier(0.16, 1, 0.3, 1);
  }

  .lyric-line.active .lyric-original,
  .lyric-line.active .lyric-translation {
    scale: 1.012;
  }

  .lyric-translation {
    overflow: hidden;
    margin-top: 0.18em;
    font-size: 0.72em;
    font-weight: 590;
    line-height: 1.26;
    letter-spacing: -0.02em;
    opacity: 0.76;
  }

  .translation-toggle-enter-active,
  .translation-toggle-leave-active {
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

  .lyrics-panel.browsing .lyric-line {
    opacity: 0.72;
    filter: blur(0);
    text-shadow: none;

    &:hover:not(.active)::before {
      background: rgba(255, 255, 255, 0.1);
      opacity: 1;
    }

    &.active {
      color: rgba(255, 255, 255, 0.84);

      .lyric-original,
      .lyric-translation {
        scale: 1;
      }
    }
  }

  .lyrics-panel.realign-animating .lyric-line {
    /* 只在 realign 位移动画期间临时提升合成层,避免数百行歌词常驻 will-change 的内存开销 */
    will-change: translate;
  }

  .lyrics-panel.animation-disabled {
    .lyric-state-change-enter-active,
    .lyric-state-change-leave-active,
    .translation-toggle-enter-active,
    .translation-toggle-leave-active,
    .lyric-line,
    .lyric-original,
    .lyric-translation {
      transition-duration: 0ms;
      animation-duration: 0ms;
    }

    .lyric-line.active .lyric-original,
    .lyric-line.active .lyric-translation {
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
  }

  @media (max-width: 720px) {
    .lyrics-content {
      gap: clamp(22px, calc(var(--lyric-size) * 1.12), 34px);
      padding: 40vh 7% 44vh;
    }

    .lyric-line {
      width: 100%;
      font-size: clamp(22px, calc(var(--lyric-size) * 1.35), 34px);
    }
  }

  @media (prefers-contrast: more) {
    .lyric-line {
      opacity: 0.55;
      filter: blur(0);

      &.active {
        opacity: 1;
      }
    }

    .lyrics-panel.browsing .lyric-line {
      opacity: 0.72;
    }
  }
</style>
