<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import { usePlayerStore } from '../stores/player'
  import { findActiveLyricIndex } from '../utils/lyrics'
  import type { LyricsSnapshot } from '../types/music'

  const props = withDefaults(
    defineProps<{
      variant?: 'page' | 'progress'
      onSeek: (time: number) => void
      lyricPreview?: LyricsSnapshot | null
      previewEnabled?: boolean
    }>(),
    {
      variant: 'page',
      lyricPreview: null,
      previewEnabled: true,
    },
  )

  const store = usePlayerStore()
  const { currentTime, duration, settings } = storeToRefs(store)
  const draftTime = ref<number | null>(null)
  const previewTime = ref<number | null>(null)
  const previewX = ref(0)
  const previewY = ref(0)
  const previewWidth = ref<number | null>(null)
  const previewHeight = ref<number | null>(null)
  const previewVisible = ref(false)
  const previewScrollDirection = ref<'forward' | 'backward' | 'idle'>('idle')
  const previewBubble = ref<HTMLElement | null>(null)
  const previewContent = ref<HTMLElement | null>(null)
  const previewTextElement = ref<HTMLElement | null>(null)
  const previewHover = ref<{
    track: HTMLElement
    clientX: number
    clientY: number
    pointerType: string
  } | null>(null)
  const displayTime = computed(() => draftTime.value ?? currentTime.value)
  const progress = computed(() => (duration.value ? (displayTime.value / duration.value) * 100 : 0))
  const previewLine = computed(() => {
    if (previewTime.value === null || props.lyricPreview?.status !== 'ready') return null
    const lines = props.lyricPreview.lines
    if (!lines.length) return null
    const index = findActiveLyricIndex(lines, previewTime.value)
    if (index < 0) return null
    return lines[index] ?? null
  })
  const previewStyle = computed(() => ({
    left: `${previewX.value}px`,
    top: `${previewY.value}px`,
    width: previewWidth.value === null ? undefined : `${previewWidth.value}px`,
    height: previewHeight.value === null ? undefined : `${previewHeight.value}px`,
  }))
  const previewContentKey = computed(() => {
    if (previewTime.value === null || !previewLine.value) return 'empty'
    return `${previewLine.value.time}-${previewLine.value.text}-${previewLine.value.translation ?? ''}`
  })
  const previewText = computed(() => previewLine.value?.text ?? '')
  const previewTranslation = computed(() => previewLine.value?.translation ?? '')
  let progressDragTarget: HTMLElement | null = null
  let progressDragPointerId: number | null = null
  let lastPreviewTime: number | null = null
  let previewFrame = 0
  let pendingPreviewEvent: {
    track: HTMLElement
    clientX: number
    clientY: number
    pointerType: string
  } | null = null

  function formatTime(value: number) {
    if (!Number.isFinite(value)) return '0:00'
    const totalSeconds = Math.floor(value)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    }
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  function formatRemaining() {
    if (!Number.isFinite(duration.value) || duration.value <= 0) return '-0:00'
    return `-${formatTime(Math.max(0, duration.value - displayTime.value))}`
  }

  function getProgressTime(track: HTMLElement, clientX: number): number | null {
    if (!Number.isFinite(duration.value) || duration.value <= 0) return null
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return null
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * duration.value
  }

  function releaseProgressPointerCapture() {
    if (progressDragTarget && progressDragPointerId !== null) {
      progressDragTarget.releasePointerCapture?.(progressDragPointerId)
    }
    progressDragTarget = null
    progressDragPointerId = null
  }

  function removeGlobalProgressListeners() {
    window.removeEventListener('pointerup', handleWindowProgressPointerUp)
    window.removeEventListener('pointercancel', handleWindowProgressPointerCancel)
    window.removeEventListener('blur', handleWindowProgressBlur)
  }

  function isActiveProgressPointer(event: PointerEvent) {
    return progressDragPointerId === null || event.pointerId === progressDragPointerId
  }

  function finishProgressDrag(nextTime: number | null, options: { seek: boolean }) {
    if (draftTime.value === null) return
    const committedTime = nextTime ?? draftTime.value
    draftTime.value = null
    releaseProgressPointerCapture()
    removeGlobalProgressListeners()
    if (options.seek) props.onSeek(committedTime)
  }

  function handleWindowProgressPointerUp(event: PointerEvent) {
    if (!progressDragTarget) return
    if (!isActiveProgressPointer(event)) return
    finishProgressDrag(getProgressTime(progressDragTarget, event.clientX), { seek: true })
  }

  function handleWindowProgressPointerCancel(event: PointerEvent) {
    if (!isActiveProgressPointer(event)) return
    cancelProgressDrag()
  }

  function handleWindowProgressBlur() {
    cancelProgressDrag()
  }

  function beginProgressDrag(event: PointerEvent) {
    if (draftTime.value !== null && !isActiveProgressPointer(event)) return
    if (event.pointerType === 'touch') hideLyricPreview()
    const track = event.currentTarget as HTMLElement
    const nextTime = getProgressTime(track, event.clientX)
    if (nextTime === null) return
    draftTime.value = nextTime
    progressDragTarget = track
    progressDragPointerId = event.pointerId
    track.setPointerCapture?.(event.pointerId)
    window.addEventListener('pointerup', handleWindowProgressPointerUp)
    window.addEventListener('pointercancel', handleWindowProgressPointerCancel)
    window.addEventListener('blur', handleWindowProgressBlur)
    scheduleLyricPreview(event)
  }

  function updateProgressDrag(event: PointerEvent) {
    const track = event.currentTarget as HTMLElement
    if (draftTime.value !== null) {
      if (!isActiveProgressPointer(event)) return
      const nextTime = getProgressTime(track, event.clientX)
      if (nextTime !== null) {
        draftTime.value = nextTime
      }
    }
    scheduleLyricPreview(event)
  }

  function commitProgress(event: PointerEvent) {
    if (draftTime.value === null) return
    if (!isActiveProgressPointer(event)) return
    const track = event.currentTarget as HTMLElement
    finishProgressDrag(getProgressTime(track, event.clientX), { seek: true })
  }

  function cancelProgressDrag(event?: PointerEvent) {
    if (event && !isActiveProgressPointer(event)) return
    finishProgressDrag(null, { seek: false })
    clearLyricPreviewHover()
  }

  function seekByKeyboard(event: KeyboardEvent) {
    if (!Number.isFinite(duration.value) || duration.value <= 0) return
    const step = event.shiftKey ? 10 : 5
    const pageStep = Math.max(10, duration.value * 0.1)
    let nextTime: number | null = null
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      nextTime = Math.max(0, displayTime.value - step)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      nextTime = Math.min(duration.value, displayTime.value + step)
    } else if (event.key === 'PageDown') {
      nextTime = Math.max(0, displayTime.value - pageStep)
    } else if (event.key === 'PageUp') {
      nextTime = Math.min(duration.value, displayTime.value + pageStep)
    } else if (event.key === 'Home') {
      nextTime = 0
    } else if (event.key === 'End') {
      nextTime = duration.value
    }
    if (nextTime === null) return
    event.preventDefault()
    props.onSeek(nextTime)
  }

  function getPreviewAnchorX(track: HTMLElement, clientX: number): number {
    const rect = track.getBoundingClientRect()
    return Math.min(rect.right, Math.max(rect.left, clientX))
  }

  function getPreviewBubbleWidth() {
    const width = previewWidth.value ?? previewBubble.value?.getBoundingClientRect().width
    if (width && width > 0) return width
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    return viewportWidth ? Math.min(320, Math.max(0, viewportWidth - 24)) : 320
  }

  function updatePreviewSize() {
    const content = previewContent.value
    if (!content) return
    const text = previewTextElement.value
    const time = content.querySelector<HTMLElement>('.lyric-preview-time')
    const styles = window.getComputedStyle(content)
    const horizontalPadding =
      Number.parseFloat(styles.paddingLeft) + Number.parseFloat(styles.paddingRight)
    const verticalPadding =
      Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
    const maxWidth = Math.min(
      320,
      Math.max(0, (window.innerWidth || document.documentElement.clientWidth || 0) - 24),
    )
    const intrinsicTextWidth = text?.scrollWidth ?? 0
    const intrinsicTimeWidth = time?.scrollWidth ?? 0
    const measuredWidth = Math.min(
      maxWidth,
      Math.max(intrinsicTextWidth, intrinsicTimeWidth) + horizontalPadding,
    )
    if (measuredWidth > 0) previewWidth.value = measuredWidth

    const rect = content.getBoundingClientRect()
    const measuredHeight = Math.max(
      rect.height,
      (text?.scrollHeight ?? 0) + (time?.scrollHeight ?? 0) + verticalPadding,
    )
    if (measuredHeight > 0) previewHeight.value = measuredHeight
  }

  function updatePreviewPosition(clientX: number, clientY: number, track: HTMLElement) {
    const rect = track.getBoundingClientRect()
    const margin = 12
    const gap = 26
    const maxVerticalFloat = 3
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    const bubbleWidth = getPreviewBubbleWidth()
    const trackLeft = viewportWidth ? Math.max(margin, rect.left) : rect.left
    const trackRight = viewportWidth ? Math.min(viewportWidth - margin, rect.right) : rect.right
    const viewportLeft = viewportWidth ? margin : trackLeft
    const viewportRight = viewportWidth ? viewportWidth - margin : trackRight
    const canFitInsideTrack = trackRight - trackLeft >= bubbleWidth
    const availableLeft = canFitInsideTrack ? trackLeft : viewportLeft
    const availableRight = canFitInsideTrack ? trackRight : viewportRight
    const minCenterX = availableLeft + bubbleWidth / 2
    const maxCenterX = availableRight - bubbleWidth / 2
    const preferredX = getPreviewAnchorX(track, clientX)
    const centerX =
      minCenterX <= maxCenterX
        ? Math.min(maxCenterX, Math.max(minCenterX, preferredX))
        : viewportWidth / 2
    const centerY = rect.top + rect.height / 2
    const verticalFloat = Math.min(
      maxVerticalFloat,
      Math.max(-maxVerticalFloat, (clientY - centerY) * 0.18),
    )
    previewX.value = centerX
    previewY.value = Math.max(margin, rect.top - gap + verticalFloat)
  }

  function scheduleLyricPreview(event: PointerEvent) {
    pendingPreviewEvent = {
      track: event.currentTarget as HTMLElement,
      clientX: event.clientX,
      clientY: event.clientY,
      pointerType: event.pointerType,
    }
    if (previewFrame) return
    previewFrame = window.requestAnimationFrame(() => {
      previewFrame = 0
      const pending = pendingPreviewEvent
      pendingPreviewEvent = null
      if (pending) updateLyricPreview(pending)
    })
  }

  function cancelPendingPreviewFrame() {
    pendingPreviewEvent = null
    if (!previewFrame) return
    window.cancelAnimationFrame(previewFrame)
    previewFrame = 0
  }

  function updateLyricPreview(event: {
    track: HTMLElement
    clientX: number
    clientY: number
    pointerType: string
  }) {
    const { track, clientX, clientY, pointerType } = event
    previewHover.value = event
    if (!props.previewEnabled || !settings.value.progressLyricPreview || pointerType === 'touch') {
      hideLyricPreview()
      return
    }
    const nextTime = getProgressTime(track, clientX)
    if (nextTime === null) {
      hideLyricPreview()
      return
    }
    updatePreviewScrollDirection(nextTime)
    previewTime.value = nextTime
    previewVisible.value = true
    updatePreviewPosition(clientX, clientY, track)
    void nextTick(() => {
      updatePreviewSize()
      if (previewVisible.value) updatePreviewPosition(clientX, clientY, track)
    })
  }

  function hideLyricPreview() {
    previewVisible.value = false
    previewTime.value = null
    previewWidth.value = null
    previewHeight.value = null
    previewScrollDirection.value = 'idle'
    lastPreviewTime = null
  }

  function clearLyricPreviewHover() {
    previewHover.value = null
    cancelPendingPreviewFrame()
    hideLyricPreview()
  }

  function restoreLyricPreviewFromHover() {
    const hover = previewHover.value
    if (
      !hover ||
      !props.previewEnabled ||
      !settings.value.progressLyricPreview ||
      hover.pointerType === 'touch'
    ) {
      return
    }
    const nextTime = getProgressTime(hover.track, hover.clientX)
    if (nextTime === null) return
    updatePreviewScrollDirection(nextTime)
    previewTime.value = nextTime
    if (!previewLine.value) return
    previewVisible.value = true
    updatePreviewPosition(hover.clientX, hover.clientY, hover.track)
    void nextTick(() => {
      updatePreviewSize()
      if (previewVisible.value) updatePreviewPosition(hover.clientX, hover.clientY, hover.track)
    })
  }

  watch(currentTime, () => {
    if (draftTime.value !== null && !Number.isFinite(draftTime.value)) draftTime.value = null
  })
  watch(
    () => props.lyricPreview,
    () => {
      restoreLyricPreviewFromHover()
      if (!previewLine.value) {
        hideLyricPreview()
      }
    },
  )
  watch(
    () => props.previewEnabled,
    (enabled) => {
      if (!enabled) {
        clearLyricPreviewHover()
      } else {
        restoreLyricPreviewFromHover()
      }
    },
  )
  watch(
    () => settings.value.progressLyricPreview,
    (enabled) => {
      if (!enabled) {
        clearLyricPreviewHover()
      }
    },
  )
  watch(previewContentKey, () => {
    if (!previewVisible.value || !previewLine.value) return
    void nextTick(updatePreviewSize)
  })

  function updatePreviewScrollDirection(nextTime: number) {
    if (lastPreviewTime === null) {
      lastPreviewTime = nextTime
      previewScrollDirection.value = 'idle'
      return
    }

    const delta = nextTime - lastPreviewTime
    lastPreviewTime = nextTime
    if (Math.abs(delta) < 0.05) return
    previewScrollDirection.value = delta > 0 ? 'forward' : 'backward'
  }

  onBeforeUnmount(() => {
    finishProgressDrag(null, { seek: false })
    removeGlobalProgressListeners()
    cancelPendingPreviewFrame()
  })
</script>

<template>
  <div class="progress-row" :class="`is-${variant}`">
    <span v-if="variant === 'progress'" class="time elapsed">{{ formatTime(displayTime) }}</span>
    <div
      class="range progress"
      :class="{ 'is-dragging': draftTime !== null }"
      role="slider"
      tabindex="0"
      aria-label="播放进度"
      aria-valuemin="0"
      :aria-valuemax="Math.round(duration || 0)"
      :aria-valuenow="Math.round(displayTime)"
      :aria-valuetext="`${formatTime(displayTime)} / ${formatTime(duration || 0)}`"
      :style="{ '--range-progress': `${progress}%` }"
      @pointerdown="beginProgressDrag"
      @pointerenter="scheduleLyricPreview"
      @pointermove="updateProgressDrag"
      @pointerleave="clearLyricPreviewHover"
      @pointerup="commitProgress"
      @pointercancel="cancelProgressDrag"
      @keydown="seekByKeyboard"
      @touchstart.stop
      @touchmove.stop
    >
      <span class="range-track" aria-hidden="true">
        <span class="progress-fill" />
      </span>
    </div>
    <span v-if="variant === 'progress'" class="time remaining">{{ formatRemaining() }}</span>
    <div v-else class="time-row">
      <span>{{ formatTime(displayTime) }}</span>
      <span>{{ formatRemaining() }}</span>
    </div>
  </div>

  <Teleport to="body">
    <Transition name="lyric-preview">
      <div
        v-if="previewVisible && previewLine"
        ref="previewBubble"
        class="lyric-preview-bubble"
        :class="`scroll-${previewScrollDirection}`"
        :style="previewStyle"
        role="status"
        aria-live="polite"
      >
        <div ref="previewContent" class="lyric-preview-content">
          <span class="lyric-preview-time">{{ formatTime(previewTime ?? 0) }}</span>
          <Transition name="lyric-preview-content">
            <div :key="previewContentKey" ref="previewTextElement" class="lyric-preview-text">
              <strong>{{ previewText }}</strong>
              <span v-if="previewTranslation" class="lyric-preview-translation">
                {{ previewTranslation }}
              </span>
            </div>
          </Transition>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped lang="scss">
  .progress-row {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 3px;
    color: var(--text-subtle);
    font-size: 0.65rem;
    font-variant-numeric: tabular-nums;
  }

  .progress-row.is-progress {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
  }

  .time {
    color: rgba(255, 255, 255, 0.58);
    font-size: 0.82rem;
    font-weight: 580;
    line-height: 1;
    white-space: nowrap;
  }

  .elapsed {
    text-align: right;
  }

  .remaining {
    text-align: left;
  }

  .time-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .range {
    --track-height: 11px;
    position: relative;
    display: flex;
    overflow: hidden;
    width: 100%;
    height: 28px;
    align-items: center;
    margin: 0;
    border-radius: 99px;
    background: transparent;
    cursor: pointer;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;

    .range-track {
      position: absolute;
      top: 50%;
      right: 0;
      left: 0;
      height: var(--track-height);
      overflow: hidden;
      border-radius: 99px;
      background: rgba(255, 255, 255, 0.19);
      transform: translateY(-50%);
      transition:
        height 160ms ease,
        background 160ms ease;
    }

    .progress-fill {
      position: absolute;
      top: -1px;
      bottom: -1px;
      left: 0;
      width: var(--range-progress);
      border-radius: 0;
      background: rgba(255, 255, 255, 0.56);
    }
  }

  .progress-row:hover .range,
  .range:focus-visible,
  .range:active {
    --track-height: 14px;
  }

  .lyric-preview-bubble {
    position: fixed;
    z-index: 9999;
    width: max-content;
    max-width: min(320px, calc(100vw - 24px));
    overflow: hidden;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.13);
    border-radius: 12px;
    background: rgba(42, 41, 45, 0.62);
    box-shadow:
      0 12px 38px rgba(0, 0, 0, 0.28),
      inset 0 1px rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.92);
    pointer-events: none;
    transform: translate(-50%, -100%);
    transition:
      width 110ms cubic-bezier(0.2, 0.8, 0.2, 1),
      height 110ms cubic-bezier(0.2, 0.8, 0.2, 1),
      opacity 120ms ease,
      scale 120ms ease;
    backdrop-filter: blur(34px) saturate(150%);
    -webkit-backdrop-filter: blur(34px) saturate(150%);

    strong {
      overflow-wrap: anywhere;
      font-size: 0.82rem;
      font-weight: 700;
      line-height: 1.3;
    }
  }

  .lyric-preview-text,
  .lyric-preview-content strong,
  .lyric-preview-content span {
    display: block;
  }

  .lyric-preview-content {
    display: grid;
    grid-template-areas:
      'time'
      'text';
    width: max-content;
    max-width: min(320px, calc(100vw - 24px));
    padding: 10px 12px 11px;
    box-sizing: border-box;
  }

  .lyric-preview-time {
    grid-area: time;
    margin-bottom: 5px;
    color: rgba(255, 255, 255, 0.52);
    font-size: 0.66rem;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
    line-height: 1;
  }

  .lyric-preview-text {
    grid-area: text;
    min-width: 0;
  }

  .lyric-preview-translation {
    margin-top: 4px;
    overflow-wrap: anywhere;
    color: rgba(255, 255, 255, 0.64);
    font-size: 0.72rem;
    line-height: 1.32;
  }

  .lyric-preview-enter-active,
  .lyric-preview-leave-active {
    transition:
      opacity 120ms ease,
      scale 120ms ease;
  }

  .lyric-preview-enter-from,
  .lyric-preview-leave-to {
    opacity: 0;
    scale: 0.98;
  }

  .lyric-preview-content-enter-active,
  .lyric-preview-content-leave-active {
    transition:
      opacity 150ms ease,
      filter 150ms ease,
      transform 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  .lyric-preview-content-enter-from {
    opacity: 0;
    filter: blur(5px);
    transform: translateY(42%);
  }

  .lyric-preview-content-leave-to {
    opacity: 0;
    filter: blur(5px);
    transform: translateY(-42%);
  }

  .lyric-preview-bubble.scroll-forward {
    .lyric-preview-content-enter-from {
      transform: translateY(42%);
    }

    .lyric-preview-content-leave-to {
      transform: translateY(-42%);
    }
  }

  .lyric-preview-bubble.scroll-backward {
    .lyric-preview-content-enter-from {
      transform: translateY(-42%);
    }

    .lyric-preview-content-leave-to {
      transform: translateY(42%);
    }
  }

  @media (max-width: 720px) {
    .progress-row.is-page {
      gap: 7px;
      font-size: 0.67rem;
    }

    .progress-row.is-page .range {
      --track-height: 11px;
      height: 36px;
    }

    .progress-row.is-page:hover .range,
    .progress-row.is-page .range:focus-visible,
    .progress-row.is-page .range:active {
      --track-height: 14px;
    }

    .progress-row.is-page .range .range-track {
      background: rgba(255, 255, 255, 0.22);
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
    }
  }

  @media (max-width: 420px) {
    .progress-row.is-page {
      gap: 5px;
      font-size: 0.64rem;
    }

    .progress-row.is-page:hover .range,
    .progress-row.is-page .range:focus-visible,
    .progress-row.is-page .range:active {
      --track-height: 13px;
    }
  }
</style>
