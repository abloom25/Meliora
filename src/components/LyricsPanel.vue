<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { Music2 } from '@lucide/vue'
import { usePlayerStore } from '../stores/player'
import { hasCachedLyrics, loadLyricsText } from '../services/lyrics'
import {
  findActiveLyricIndex,
  hasMeaningfulLyrics,
  insertLyricGapMarkers,
  parseLyrics,
} from '../utils/lyrics'
import type { LyricAvailability, LyricLine, LyricsSnapshot } from '../types/music'

const emit = defineEmits<{
  seek: [time: number]
  availability: [availability: LyricAvailability]
  snapshot: [snapshot: LyricsSnapshot]
}>()
const LYRIC_MOTION_LEAD = 0.42
const store = usePlayerStore()
const { currentTrack, currentTime, settings } = storeToRefs(store)
const lines = ref<LyricLine[]>([])
const activeIndex = ref(-1)
const targetIndex = ref(-1)
const status = ref<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle')
const scroller = ref<HTMLElement>()
const lineElements = ref<HTMLElement[]>([])
const userScrolling = ref(false)
let scrollTimer = 0
let requestId = 0
let lyricsController: AbortController | null = null
const lineAnimations = new Set<Animation>()
let highlightTimer = 0

function updateStatus(nextStatus: typeof status.value) {
  status.value = nextStatus
  const availability: LyricAvailability = nextStatus === 'ready'
    ? 'available'
    : nextStatus === 'loading'
      ? 'loading'
      : 'unavailable'
  emit('availability', availability)
  emitSnapshot()
}

function emitSnapshot() {
  emit('snapshot', {
    lines: lines.value.map((line) => ({ ...line })),
    activeIndex: activeIndex.value,
    status: status.value,
  })
}

async function loadLyrics(url?: string) {
  const id = ++requestId
  lines.value = []
  lineElements.value = []
  activeIndex.value = -1
  targetIndex.value = -1
  window.clearTimeout(highlightTimer)
  lyricsController?.abort()
  if (!url) {
    updateStatus('empty')
    return
  }
  if (!hasCachedLyrics(url)) updateStatus('loading')
  lyricsController = new AbortController()
  try {
    const text = await loadLyricsText(url)
    if (id !== requestId) return
    const parsedLines = parseLyrics(text)
    if (!hasMeaningfulLyrics(parsedLines)) {
      lines.value = []
      updateStatus('empty')
      return
    }
    lines.value = insertLyricGapMarkers(parsedLines)
    updateStatus('ready')
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    if (id === requestId) updateStatus('error')
  }
}

function handleScroll() {
  cancelLineAnimations()
  userScrolling.value = true
  window.clearTimeout(scrollTimer)
  scrollTimer = window.setTimeout(() => {
    userScrolling.value = false
    scrollToIndex(targetIndex.value)
  }, 3200)
}

function cancelLineAnimations() {
  lineAnimations.forEach((animation) => animation.cancel())
  lineAnimations.clear()
}

function scrollToIndex(index: number, onComplete?: () => void) {
  if (!settings.value.lyricAutoScroll || userScrolling.value || index < 0) {
    onComplete?.()
    return
  }
  const container = scroller.value
  const element = lineElements.value[index]
  if (!container || !element) {
    onComplete?.()
    return
  }
  const target = Math.max(
    0,
    Math.min(
      element.offsetTop - container.clientHeight / 2 + element.clientHeight / 2,
      container.scrollHeight - container.clientHeight,
    ),
  )

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
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
  const before = lineElements.value.map((line) => line.getBoundingClientRect().top)
  container.scrollTop = target
  const viewport = container.getBoundingClientRect()
  const previousIndex = activeIndex.value >= 0 ? activeIndex.value : index
  const animationStart = Math.max(0, Math.min(previousIndex, index) - 5)
  const animationEnd = Math.min(
    lineElements.value.length - 1,
    Math.max(previousIndex, index) + 7,
  )
  const visibleLines = lineElements.value
    .map((line, index) => ({
      line,
      index,
      before: before[index] ?? 0,
      rect: line.getBoundingClientRect(),
    }))
    .filter(({ index: lineIndex, rect }) =>
      (lineIndex >= animationStart && lineIndex <= animationEnd)
      || (rect.bottom >= viewport.top - 140 && rect.top <= viewport.bottom + 180),
    )
    .map(({ line, index: lineIndex, before: previousTop, rect }) => ({
      line,
      index: lineIndex,
      before: previousTop,
      after: rect.top,
    }))
    .sort((left, right) => left.after - right.after)

  visibleLines.forEach(({ line, before: previousTop, after }, order) => {
    const measuredOffset = previousTop - after
    const offset = Math.abs(measuredOffset) >= 0.5 ? measuredOffset : movement
    const delayOrder = movement > 0 ? order : visibleLines.length - order - 1
    const directionalLag = movement > 0
      ? Math.min(delayOrder, 7) * 5
      : -Math.min(delayOrder, 7) * 5
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

function visibleCountdownDots(line: LyricLine) {
  if (line.kind !== 'gap' || line.endTime === undefined) return 0
  const elapsed = currentTime.value - (line.time ?? currentTime.value)
  return Math.max(1, Math.min(3, Math.floor(elapsed) + 1))
}

function gapStyle(line: LyricLine) {
  if (line.kind !== 'gap' || line.time === null || line.endTime === undefined) return {}
  const elapsed = currentTime.value - line.time
  const remaining = line.endTime - currentTime.value
  const enterProgress = Math.max(0, Math.min(1, elapsed / 0.38))
  const leaveProgress = Math.max(0, Math.min(1, remaining / 0.48))
  const visibility = Math.min(enterProgress, leaveProgress)
  return {
    '--gap-opacity': visibility.toFixed(3),
    '--gap-shift': `${((1 - enterProgress) * 5) - ((1 - leaveProgress) * 8)}px`,
    '--gap-scale': (0.86 + visibility * 0.14).toFixed(3),
  }
}

function lyricStyle(index: number) {
  if (activeIndex.value < 0) {
    return {
      '--line-distance': 0,
    }
  }
  return {
    '--line-distance': Math.min(Math.abs(index - activeIndex.value), 5),
  }
}

watch(() => currentTrack.value?.lyricsUrl, (url) => void loadLyrics(url), { immediate: true })
watch(currentTime, (time) => {
  const nextIndex = findActiveLyricIndex(lines.value, time + LYRIC_MOTION_LEAD)
  if (nextIndex === targetIndex.value) return
  targetIndex.value = nextIndex
  window.clearTimeout(highlightTimer)
  activeIndex.value = nextIndex
  emitSnapshot()
  window.requestAnimationFrame(() => {
    scrollToIndex(nextIndex)
  })
})
onBeforeUnmount(() => {
  window.clearTimeout(scrollTimer)
  window.clearTimeout(highlightTimer)
  lyricsController?.abort()
  cancelLineAnimations()
})
</script>

<template>
  <section class="lyrics-panel" :class="{ browsing: userScrolling }" aria-label="歌词">
    <div ref="scroller" class="lyrics-scroll" @wheel.passive="handleScroll" @touchmove.passive="handleScroll">
      <Transition name="lyric-state-change" mode="out-in">
        <div v-if="status === 'loading'" key="loading" class="lyric-stage">
          <div class="lyric-state loading-state">
            <span class="activity-indicator" aria-hidden="true">
              <i v-for="index in 8" :key="index" :style="{ '--spoke': index - 1 }" />
            </span>
            <span>载入歌词</span>
          </div>
        </div>
        <div v-else-if="status === 'empty' || status === 'idle'" key="empty" class="lyric-stage">
          <div class="lyric-state">
            <Music2 :size="30" /><strong>暂无歌词</strong><span>让旋律自己说话</span>
          </div>
        </div>
        <div v-else-if="status === 'error'" key="error" class="lyric-stage">
          <div class="lyric-state">
            <Music2 :size="30" /><strong>歌词暂时无法载入</strong><span>音乐播放不会受到影响</span>
          </div>
        </div>
        <div v-else key="lyrics" class="lyric-stage">
          <div class="lyrics-content">
            <button
              v-for="(line, index) in lines"
              :key="`${line.time}-${index}`"
              :ref="(element) => { if (element) lineElements[index] = element as HTMLElement }"
              class="lyric-line"
              :class="{
                active: index === activeIndex,
                timed: line.time !== null,
                gap: line.kind === 'gap',
                targeted: index === targetIndex,
              }"
              :style="{
                '--lyric-size': `${settings.lyricFontSize}px`,
                ...lyricStyle(index),
                ...gapStyle(line),
              }"
              :disabled="line.time === null || line.kind === 'gap'"
              @click="seekLine(line)"
            >
              <span
                v-if="line.kind === 'gap' && index === activeIndex"
                class="waiting-dots"
                :aria-label="`下一句还有 ${visibleCountdownDots(line)} 秒`"
              >
                <i
                  v-for="dot in 3"
                  :key="dot"
                  :class="{ pending: dot > visibleCountdownDots(line) }"
                />
              </span>
              <template v-else-if="line.kind !== 'gap'">
                <span class="lyric-original">{{ line.text }}</span>
                <span v-if="line.translation" class="lyric-translation">{{ line.translation }}</span>
              </template>
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

  &::-webkit-scrollbar { display: none; }
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
  gap: clamp(18px, 2.5vh, 28px);
  padding: 42vh 7% 46vh 3%;
}

.lyric-line {
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

  &.timed { cursor: pointer; }
  &:hover:not(.active) { color: rgba(255, 255, 255, 0.48); }

  &.active {
    color: #fff;
    opacity: 1;
    filter: blur(0);
    text-shadow:
      0 0 10px rgba(255, 255, 255, 0.22),
      0 0 30px rgba(255, 255, 255, 0.15),
      0 8px 34px rgba(0, 0, 0, 0.3);
  }

  &.gap {
    min-height: 34px;
    filter: none;
    opacity: 0.48;
  }

  &.gap:not(.active):not(.targeted) {
    display: none;
  }

  &.gap.targeted:not(.active) {
    display: block;
    visibility: hidden;
  }

  &.gap.active {
    opacity: 1;
    text-shadow: none;
  }
}

.lyric-original,
.lyric-translation {
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
  margin-top: 0.18em;
  font-size: 0.72em;
  font-weight: 590;
  line-height: 1.26;
  letter-spacing: -0.02em;
  opacity: 0.76;
}

.waiting-dots {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  opacity: var(--gap-opacity, 0);
  transform:
    translateY(var(--gap-shift, 0))
    scale(var(--gap-scale, 0.86));
  transition: opacity 90ms linear, transform 90ms linear;

  i {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.92;
    transform: scale(1);
    transition:
      opacity 320ms cubic-bezier(0.22, 1, 0.36, 1),
      transform 320ms cubic-bezier(0.22, 1, 0.36, 1);

    &.pending {
      opacity: 0;
      transform: scale(0.35);
    }
  }
}

.lyrics-panel.browsing .lyric-line {
  opacity: 0.72;
  filter: blur(0);
  text-shadow: none;

  &.active {
    color: rgba(255, 255, 255, 0.84);

    .lyric-original,
    .lyric-translation {
      scale: 1;
    }
  }
}

.lyric-state {
  display: flex;
  height: 100%;
  align-items: flex-start;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  padding-left: 6%;
  color: var(--text-subtle);

  strong { color: var(--text); font-size: 1.15rem; }
  span { font-size: 0.82rem; }
}

.loading-state {
  gap: 12px;
  color: rgba(255, 255, 255, 0.38);
}

.activity-indicator {
  position: relative;
  width: 22px;
  height: 22px;

  i {
    position: absolute;
    top: 9px;
    left: 9px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.9);
    opacity: 0.16;
    transform:
      rotate(calc(var(--spoke) * 45deg))
      translateY(-8px);
    animation: activity-spoke 880ms linear infinite;
    animation-delay: calc(var(--spoke) * -110ms);
  }
}

@keyframes activity-spoke {
  0% { opacity: 0.92; }
  25% { opacity: 0.48; }
  100% { opacity: 0.14; }
}

@media (prefers-reduced-motion: reduce) {
  .lyric-state-change-enter-active,
  .lyric-state-change-leave-active {
    transition-duration: 0ms;
  }

  .lyric-line {
    transition-duration: 0ms;
  }

  .activity-indicator i {
    animation-duration: 1.6s;
  }

}

@media (max-width: 720px) {
  .lyrics-content {
    gap: 22px;
    padding: 40vh 7% 44vh;
  }

  .lyric-line {
    width: 100%;
    font-size: clamp(22px, calc(var(--lyric-size) * 1.35), 34px);
  }
}
</style>
