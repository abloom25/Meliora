<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import { usePlayerStore } from '../stores/player'
  import { wordEdgeSoftness, wordFillProgress } from '../core/lyrics'
  import { harmonyParentsOf, resolveLyricScene } from '../core/lyrics'
  import type { LyricsSnapshot } from '../core/types'

  /** 气泡里的一个音节。fill / edge 是预览时刻的静态扫光快照 */
  interface PreviewWord {
    text: string
    fill: string
    edge: string
    trailingSpace: boolean
  }

  /** 气泡里的一行。对唱的第二声部靠右,背景和声更小更淡地附在主句下方 */
  interface PreviewRow {
    index: number
    text: string
    roman?: string
    translation?: string
    secondary: boolean
    background: boolean
    words: PreviewWord[] | null
  }

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
  const previewHover = ref<{
    track: HTMLElement
    clientX: number
    clientY: number
    pointerType: string
  } | null>(null)
  const displayTime = computed(() => draftTime.value ?? currentTime.value)
  const progress = computed(() => (duration.value ? (displayTime.value / duration.value) * 100 : 0))
  const previewLines = computed(() => props.lyricPreview?.lines ?? [])
  const previewHarmonyParents = computed(() => harmonyParentsOf(previewLines.value))
  // 预览与面板共用同一套场景解析:对唱双声部同时亮、和声按自己的时间轴、
  // 间奏保留上一句。旧实现是"最后一个开始的行",和声会把主句挤掉,
  // 唱完的句子也会一直显示成正在唱
  const previewScene = computed(() => {
    if (previewTime.value === null || props.lyricPreview?.status !== 'ready') return null
    if (!previewLines.value.length) return null
    return resolveLyricScene(previewLines.value, previewTime.value, previewHarmonyParents.value)
  })
  const previewRows = computed<PreviewRow[]>(() => {
    const scene = previewScene.value
    const time = previewTime.value
    if (!scene || time === null) return []
    const shown = new Set(scene.active)
    // 和声只在它所属的主句被唱到时跟着出现。这里必须按"有主句"过滤:
    // 找不到主句的和声在面板里是常驻的,气泡只显示当前这一句,不能把它也带上
    for (const [index] of previewHarmonyParents.value) {
      if (scene.harmonyOpen[index]) shown.add(index)
    }
    return [...shown]
      .sort((left, right) => left - right)
      .map((index) => {
        const line = previewLines.value[index]!
        return {
          index,
          text: line.text,
          roman: line.roman,
          translation: line.translation,
          secondary: line.agent === 'secondary',
          background: Boolean(line.background),
          words:
            line.words?.map((word) => {
              const progress = wordFillProgress(time, word)
              return {
                text: word.text,
                fill: progress.toFixed(3),
                edge: wordEdgeSoftness(progress).toFixed(3),
                trailingSpace: Boolean(word.trailingSpace),
              }
            }) ?? null,
        }
      })
  })
  // 间奏:这一句其实已经唱完了,只是保留着高亮。整体压暗以示区别
  const previewHeld = computed(() => previewScene.value?.held ?? false)
  const previewStyle = computed(() => ({
    left: `${previewX.value}px`,
    top: `${previewY.value}px`,
    width: previewWidth.value === null ? undefined : `${previewWidth.value}px`,
    height: previewHeight.value === null ? undefined : `${previewHeight.value}px`,
  }))
  // 只在"显示哪几行"变化时才换 key:逐字进度每帧都在变,拿它当 key 会让
  // 气泡每帧重新播一次进出场动画
  const previewContentKey = computed(() => {
    const rows = previewRows.value
    if (!rows.length) return 'empty'
    return `${previewHeld.value ? 'held' : 'sung'}:${rows.map((row) => row.index).join(',')}`
  })
  let progressDragTarget: HTMLElement | null = null
  let progressDragPointerId: number | null = null
  // 拖动开始时锁定的时长:拖动全程用它换算指针位置,
  // 避免拖动中切歌导致松手时按新时长 seek 到错误位置
  let dragLockedDuration: number | null = null
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
    const effectiveDuration =
      draftTime.value !== null && dragLockedDuration !== null ? dragLockedDuration : duration.value
    if (!Number.isFinite(effectiveDuration) || effectiveDuration <= 0) return null
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return null
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return ratio * effectiveDuration
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
    dragLockedDuration = null
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
    dragLockedDuration = duration.value
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

  function getPreviewAnchorX(rect: DOMRect, clientX: number): number {
    return Math.min(rect.right, Math.max(rect.left, clientX))
  }

  function getPreviewBubbleWidth() {
    const width = previewWidth.value ?? previewBubble.value?.getBoundingClientRect().width
    if (width && width > 0) return width
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0
    return viewportWidth ? Math.min(320, Math.max(0, viewportWidth - 24)) : 320
  }

  // 量气泡在"没有显式尺寸"时的自然大小。内容盒的宽度跟着气泡走(见样式里的注释),
  // 带着上一次的宽度去量只会量回上一次的值;过渡也要一起摘掉,否则这次临时改宽
  // 自己会动画起来,恢复时又动画回去
  function updatePreviewSize() {
    const bubble = previewBubble.value
    if (!bubble) return
    const inlineWidth = bubble.style.width
    const inlineHeight = bubble.style.height
    const inlineTransition = bubble.style.transition
    // 正在淡出的旧内容与新内容落在同一个网格单元里,不摘掉它,量到的是新旧两块的并集,
    // 气泡就会停在偏大的宽度上不再收回来
    const leaving = [...bubble.querySelectorAll<HTMLElement>('.lyric-preview-content-leave-active')]
    for (const element of leaving) element.style.display = 'none'
    bubble.style.transition = 'none'
    bubble.style.width = ''
    bubble.style.height = ''

    // 自然外框已经含边框与内边距,并被样式里的 max-width 收住
    const natural = bubble.getBoundingClientRect()
    const measuredWidth = natural.width
    const measuredHeight = natural.height

    bubble.style.width = inlineWidth
    bubble.style.height = inlineHeight
    for (const element of leaving) element.style.display = ''
    // 先把恢复的尺寸提交掉,再放开过渡 —— 否则"临时宽度 → 恢复宽度"这一步
    // 会被当成一次过渡的起点,气泡自己抖一下
    void bubble.offsetWidth
    bubble.style.transition = inlineTransition

    if (measuredWidth > 0) previewWidth.value = measuredWidth
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
    const preferredX = getPreviewAnchorX(rect, clientX)
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
      // 尺寸只在未知(重新显示)时测量;内容变化的尺寸更新由 previewContentKey watcher 覆盖,
      // hover 每帧只做位置更新,避免每帧强制同步布局
      if (previewWidth.value === null) updatePreviewSize()
      if (previewVisible.value) updatePreviewPosition(clientX, clientY, track)
    })
  }

  function hideLyricPreview() {
    previewVisible.value = false
    previewTime.value = null
    previewWidth.value = null
    previewHeight.value = null
    previewScrollDirection.value = 'idle'
    pendingPreviewDirection = 'idle'
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
    if (!previewRows.value.length) return
    previewVisible.value = true
    updatePreviewPosition(hover.clientX, hover.clientY, hover.track)
    void nextTick(() => {
      if (previewWidth.value === null) updatePreviewSize()
      if (previewVisible.value) updatePreviewPosition(hover.clientX, hover.clientY, hover.track)
    })
  }

  watch(
    () => props.lyricPreview,
    () => {
      restoreLyricPreviewFromHover()
      if (!previewRows.value.length) {
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
  let pendingPreviewDirection: 'forward' | 'backward' | 'idle' = 'idle'

  watch(previewContentKey, () => {
    // 方向 class 只影响歌词文本切换的进出场方向,仅在真正换行(内容 key 变化)时应用,
    // pointermove 期间只累积 pending 值,避免每帧触发气泡重渲染
    previewScrollDirection.value = pendingPreviewDirection
    if (!previewVisible.value || !previewRows.value.length) return
    void nextTick(updatePreviewSize)
  })

  function updatePreviewScrollDirection(nextTime: number) {
    if (lastPreviewTime === null) {
      lastPreviewTime = nextTime
      pendingPreviewDirection = 'idle'
      return
    }

    const delta = nextTime - lastPreviewTime
    lastPreviewTime = nextTime
    if (Math.abs(delta) < 0.05) return
    pendingPreviewDirection = delta > 0 ? 'forward' : 'backward'
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
        v-if="previewVisible && previewRows.length"
        ref="previewBubble"
        class="lyric-preview-bubble"
        :class="[`scroll-${previewScrollDirection}`, { held: previewHeld }]"
        :style="previewStyle"
        aria-hidden="true"
      >
        <div class="lyric-preview-content">
          <span class="lyric-preview-time">{{ formatTime(previewTime ?? 0) }}</span>
          <Transition name="lyric-preview-content">
            <div :key="previewContentKey" class="lyric-preview-text">
              <div
                v-for="row in previewRows"
                :key="row.index"
                class="lyric-preview-row"
                :class="{ secondary: row.secondary, harmony: row.background }"
              >
                <strong>
                  <template v-if="row.words">
                    <template v-for="(word, wordIndex) in row.words" :key="wordIndex">
                      <span
                        class="lyric-preview-word"
                        :style="{
                          '--lyric-word-fill': word.fill,
                          '--lyric-word-edge': word.edge,
                        }"
                        >{{ word.text }}</span
                      >
                      <span v-if="word.trailingSpace" class="lyric-preview-gap">{{ ' ' }}</span>
                    </template>
                  </template>
                  <template v-else>{{ row.text }}</template>
                </strong>
                <span v-if="row.roman" class="lyric-preview-roman">{{ row.roman }}</span>
                <span v-if="row.translation" class="lyric-preview-translation">
                  {{ row.translation }}
                </span>
              </div>
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

  /* 间奏:这一句已经唱完,只是保留着高亮 */
  .lyric-preview-bubble.held .lyric-preview-text {
    opacity: 0.62;
  }

  .lyric-preview-text,
  .lyric-preview-content strong,
  .lyric-preview-content span {
    display: block;
  }

  /* 音节必须留在行内。选择器要压过上面那条把 span 一律设为 block 的兜底规则,
     否则每个音节各占一行,气泡会被撑成又窄又高的一条 */
  .lyric-preview-content .lyric-preview-word,
  .lyric-preview-content .lyric-preview-gap {
    display: inline;
  }

  /* 同一时刻的多行(对唱双声部 + 背景和声)依次排开,间距比行内的译文更松 */
  .lyric-preview-row + .lyric-preview-row {
    margin-top: 7px;
  }

  /* 对唱的第二声部靠右,与主唱形成左右分栏,和面板同一套语义 */
  .lyric-preview-row.secondary {
    text-align: right;
  }

  /* 背景和声更小更淡,附在主句下方 */
  .lyric-preview-row.harmony {
    margin-top: 4px;
    opacity: 0.72;

    strong {
      font-size: 0.72rem;
      font-weight: 650;
    }
  }

  /* 预览时刻的静态扫光快照:唱过的部分是亮色,没唱到的是暗色,
     前沿留一段渐变,看起来是"唱到这里"而不是一条硬边的进度条。
     不支持 background-clip: text 时整段保持亮色,不会变透明 */
  .lyric-preview-word {
    --lyric-word-fill: 1;
    --lyric-word-edge: 0;

    color: rgba(255, 255, 255, 0.92);
  }

  @supports (background-clip: text) or (-webkit-background-clip: text) {
    .lyric-preview-word {
      background-image: linear-gradient(
        90deg,
        rgba(255, 255, 255, 0.92) 0%,
        rgba(255, 255, 255, 0.92) calc(var(--lyric-word-fill) * 100%),
        rgba(255, 255, 255, 0.42)
          calc(var(--lyric-word-fill) * 100% + 0.5em * var(--lyric-word-edge)),
        rgba(255, 255, 255, 0.42) 100%
      );
      color: transparent;
      -webkit-background-clip: text;
      background-clip: text;
    }
  }

  /* 音节之间要留一个真实的空白文本节点,否则英文长句没有换行机会 */
  .lyric-preview-gap {
    white-space: pre-wrap;
  }

  .lyric-preview-roman {
    margin-top: 3px;
    overflow-wrap: anywhere;
    color: rgba(255, 255, 255, 0.5);
    font-size: 0.66rem;
    line-height: 1.3;
  }

  .lyric-preview-content {
    display: grid;
    grid-template-areas:
      'time'
      'text';
    /* 宽度跟着气泡走,不自己按 max-content 算。气泡的宽度是 JS 量出来的、带 110ms 过渡,
       内容盒若自己算宽,过渡期间两者不一致 —— 右对齐的行会离开气泡右缘,
       内容更宽时甚至被 overflow: hidden 裁掉一截,看起来就是横向跳一下。
       气泡没有显式宽度时(首次显示、测量时)它自己是 max-content,这里的 100% 仍是固有宽度 */
    width: 100%;
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
