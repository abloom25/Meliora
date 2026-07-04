<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, ref, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import { usePlayerStore } from '../stores/player'
  import { hasTrackLyricsSource, loadTrackLyrics } from '../services/lyrics'
  import { findActiveLyricIndex } from '../utils/lyrics'
  import { supportsWebAnimations } from '../utils/browser'
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
      previewTime?: number | null
      previewActive?: boolean
    }>(),
    {
      active: true,
      previewTime: null,
      previewActive: false,
    },
  )
  const LYRIC_MOTION_LEAD = 0.42
  const store = usePlayerStore()
  const { currentTrack, currentTrackVersion, currentTime, settings } = storeToRefs(store)
  const lines = ref<LyricLine[]>([])
  const activeIndex = ref(-1)
  const targetIndex = ref(-1)
  const status = ref<LyricStatus>('idle')
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
  const lineAnimations = new Set<Animation>()
  let highlightTimer = 0
  const lyricClockTime = computed(() =>
    props.previewActive && props.previewTime !== null ? props.previewTime : currentTime.value,
  )

  const reducedMotionQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  let prefersReducedMotion = reducedMotionQuery?.matches ?? false
  function handleReducedMotionChange(event: MediaQueryListEvent) {
    prefersReducedMotion = event.matches
  }
  onMounted(() => {
    isPanelMounted = true
    reducedMotionQuery?.addEventListener('change', handleReducedMotionChange)
    window.addEventListener('resize', handleViewportResize, { passive: true })
    window.visualViewport?.addEventListener('resize', handleViewportResize, { passive: true })
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
    })
  }

  async function loadLyrics(track: Track | null) {
    const id = ++requestId
    lines.value = []
    lineElements.value = []
    activeIndex.value = -1
    targetIndex.value = -1
    window.clearTimeout(highlightTimer)
    lyricsController?.abort()
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
      updateStatus('ready')
      await nextTick()
      if (id !== requestId) return
      scheduleRealign()
    } catch (error) {
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

  function handleKeydown(event: KeyboardEvent) {
    const scrollKeys = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '])
    if (scrollKeys.has(event.key)) handleScrollIntent()
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
  }

  interface ScheduleRealignOptions {
    animate?: boolean
    previousIndex?: number
  }

  function scheduleRealign(options: ScheduleRealignOptions = {}) {
    if (!props.active || userScrolling.value || targetIndex.value < 0) return
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
    const syncTime = !props.previewActive
      ? lyricClockTime.value + LYRIC_MOTION_LEAD
      : lyricClockTime.value
    const nextIndex =
      status.value === 'ready' || lines.value.length > 0
        ? findActiveLyricIndex(lines.value, syncTime)
        : -1
    const previousIndex = activeIndex.value
    const changed = nextIndex !== targetIndex.value || nextIndex !== previousIndex

    targetIndex.value = nextIndex
    activeIndex.value = nextIndex

    if (changed) {
      window.clearTimeout(highlightTimer)
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
      scrollRaf = window.requestAnimationFrame(() => scrollToIndex(index, onComplete, options))
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
      container.scrollTop = target
      onComplete?.()
      return
    }

    const movement = target - container.scrollTop
    if (Math.abs(movement) < 1) {
      onComplete?.()
      return
    }

    cancelLineAnimations()

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
      after: number
    }
    const visibleLines: VisibleLine[] = []
    for (let i = animationStart; i <= animationEnd; i += 1) {
      const line = elements[i]
      if (!line) continue
      visibleLines.push({
        line,
        before: line.getBoundingClientRect().top,
        after: 0,
      })
    }

    markProgrammaticScroll()
    container.scrollTop = target

    for (let i = 0; i < visibleLines.length; i += 1) {
      visibleLines[i]!.after = visibleLines[i]!.line.getBoundingClientRect().top
    }
    visibleLines.sort((left, right) => left.after - right.after)

    visibleLines.forEach(({ line, before: previousTop, after }, order) => {
      const measuredOffset = previousTop - after
      const offset = Math.abs(measuredOffset) >= 0.5 ? measuredOffset : movement
      const delayOrder = movement > 0 ? order : visibleLines.length - order - 1
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
          duration: 980,
          delay: delayOrder * 48,
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

    const longestDelay = Math.max(visibleLines.length - 1, 0) * 48
    highlightTimer = window.setTimeout(() => onComplete?.(), 540 + longestDelay * 0.5)
  }

  function seekLine(line: LyricLine) {
    if (line.time !== null) emit('seek', line.time)
  }

  const lyricPanelStyle = computed(() => ({
    '--lyric-size': `${settings.value.lyricFontSize}px`,
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

  watch(
    () => [currentTrack.value?.id, currentTrackVersion.value] as const,
    () => void loadLyrics(currentTrack.value),
    { immediate: true },
  )
  watch(lyricClockTime, () => {
    syncActiveLyric({ animate: true })
  })
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
    window.clearTimeout(programmaticScrollTimer)
    window.clearTimeout(highlightTimer)
    lyricsController?.abort()
    resizeObserver?.disconnect()
    window.removeEventListener('resize', handleViewportResize)
    window.visualViewport?.removeEventListener('resize', handleViewportResize)
    cancelLineAnimations()
    reducedMotionQuery?.removeEventListener('change', handleReducedMotionChange)
  })
</script>

<template>
  <section
    ref="panel"
    class="lyrics-panel"
    :class="{ browsing: userScrolling, 'animation-disabled': !settings.lyricAnimation }"
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
              @click="seekLine(line)"
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
    will-change: translate;
    transition:
      color 920ms cubic-bezier(0.22, 1, 0.36, 1),
      opacity 920ms cubic-bezier(0.22, 1, 0.36, 1),
      filter 920ms cubic-bezier(0.22, 1, 0.36, 1),
      text-shadow 920ms cubic-bezier(0.22, 1, 0.36, 1);

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
    transition: scale 920ms cubic-bezier(0.16, 1, 0.3, 1);
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

    .lyric-line {
      will-change: auto;
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
