<script setup lang="ts">
  import { computed, ref, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import { Pause, Play, SkipBack, SkipForward } from '@lucide/vue'
  import { usePlayerStore } from '../stores/player'

  const props = withDefaults(
    defineProps<{
      variant?: 'bar' | 'page' | 'progress' | 'mini'
      onToggle: () => void
      onPrevious: () => void
      onNext: () => void
      onSeek: (time: number) => void
    }>(),
    {
      variant: 'bar',
    },
  )

  const store = usePlayerStore()
  const { isPlaying, currentTime, duration } = storeToRefs(store)
  const draftTime = ref<number | null>(null)
  const displayTime = computed(() => draftTime.value ?? currentTime.value)
  const progress = computed(() => (duration.value ? (displayTime.value / duration.value) * 100 : 0))

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

  function updateProgress(event: Event) {
    draftTime.value = Number((event.target as HTMLInputElement).value)
  }

  function beginProgressDrag(event: Event) {
    draftTime.value = Number((event.target as HTMLInputElement).value)
  }

  function commitProgress(event: Event) {
    if (draftTime.value === null) return
    const nextTime = Number((event.target as HTMLInputElement).value)
    draftTime.value = null
    props.onSeek(nextTime)
  }

  function cancelProgressDrag() {
    draftTime.value = null
  }

  watch(currentTime, () => {
    if (draftTime.value !== null && !Number.isFinite(draftTime.value)) draftTime.value = null
  })
</script>

<template>
  <div class="controls" :class="`is-${variant}`">
    <div v-if="variant !== 'mini'" class="transport">
      <div v-if="variant !== 'progress'" class="transport-buttons">
        <button class="control-button" aria-label="上一首" @click="onPrevious">
          <SkipBack :size="variant === 'page' ? 28 : 21" fill="currentColor" />
        </button>
        <button class="play-button" :aria-label="isPlaying ? '暂停' : '播放'" @click="onToggle">
          <Pause v-if="isPlaying" :size="variant === 'page' ? 30 : 22" fill="currentColor" />
          <Play v-else :size="variant === 'page' ? 30 : 22" fill="currentColor" />
        </button>
        <button class="control-button" aria-label="下一首" @click="onNext">
          <SkipForward :size="variant === 'page' ? 28 : 21" fill="currentColor" />
        </button>
      </div>

      <div v-if="variant !== 'bar'" class="progress-row">
        <span v-if="variant === 'progress'" class="time elapsed">{{
          formatTime(displayTime)
        }}</span>
        <input
          class="range progress"
          type="range"
          min="0"
          :max="duration || 0"
          step="0.1"
          :value="displayTime"
          :style="{ '--range-progress': `${progress}%` }"
          aria-label="播放进度"
          @pointerdown="beginProgressDrag"
          @input="updateProgress"
          @change="commitProgress"
          @pointerup="commitProgress"
          @pointercancel="cancelProgressDrag"
          @touchstart.stop
          @touchmove.stop
        />
        <span v-if="variant === 'progress'" class="time remaining">{{ formatRemaining() }}</span>
        <div v-else class="time-row">
          <span>{{ formatTime(displayTime) }}</span>
          <span>{{ formatRemaining() }}</span>
        </div>
      </div>
    </div>

    <div v-if="variant === 'mini'" class="mini-buttons">
      <button class="control-button" aria-label="上一首" @click="onPrevious">
        <SkipBack :size="19" fill="currentColor" />
      </button>
      <button class="mini-play" :aria-label="isPlaying ? '暂停' : '播放'" @click="onToggle">
        <Pause v-if="isPlaying" :size="19" fill="currentColor" />
        <Play v-else :size="19" fill="currentColor" />
      </button>
      <button class="control-button" aria-label="下一首" @click="onNext">
        <SkipForward :size="19" fill="currentColor" />
      </button>
    </div>
  </div>
</template>

<style scoped lang="scss">
  .controls {
    display: contents;
  }

  .transport {
    display: flex;
    min-width: 280px;
    max-width: 560px;
    flex: 1;
    flex-direction: column;
    align-items: center;
    gap: 3px;
  }

  .is-bar .transport {
    display: grid;
    min-width: 0;
    width: 100%;
    max-width: none;
    flex: none;
    grid-template-columns: auto;
  }

  .is-bar .transport-buttons {
    gap: 10px;
  }

  .is-bar .progress-row {
    display: none;
  }

  .transport-buttons {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }

  .control-button,
  .play-button,
  .mini-play {
    display: grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.66);
    cursor: pointer;
    transition:
      opacity 160ms ease,
      transform 160ms ease,
      background 160ms ease;

    &:hover {
      opacity: 1;
      transform: scale(1.06);
    }

    &:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
    }
  }

  .control-button {
    width: 34px;
    height: 32px;
    border-radius: 50%;
    opacity: 0.78;
  }

  .play-button {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.88);
    color: rgba(18, 18, 20, 0.86);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.38);

    &:hover {
      background: rgba(255, 255, 255, 0.94);
    }
  }

  .progress-row {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 3px;
    color: var(--text-subtle);
    font-size: 0.65rem;
    font-variant-numeric: tabular-nums;
  }

  .is-progress {
    display: block;
    min-width: 0;

    .transport {
      display: block;
      min-width: 0;
      max-width: none;
    }

    .progress-row {
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
  }

  .time-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .range {
    --track-height: 11px;
    width: 100%;
    height: 28px;
    margin: 0;
    appearance: none;
    border-radius: 99px;
    background: transparent;
    cursor: pointer;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
    transition: background 160ms ease;

    &::-webkit-slider-runnable-track {
      height: var(--track-height);
      border-radius: 99px;
      background: linear-gradient(
        to right,
        rgba(255, 255, 255, 0.56) 0 var(--range-progress),
        rgba(255, 255, 255, 0.19) var(--range-progress) 100%
      );
      transition:
        height 160ms ease,
        background 160ms ease;
    }

    &::-moz-range-track {
      height: var(--track-height);
      border-radius: 99px;
      background: linear-gradient(
        to right,
        rgba(255, 255, 255, 0.56) 0 var(--range-progress),
        rgba(255, 255, 255, 0.19) var(--range-progress) 100%
      );
      transition:
        height 160ms ease,
        background 160ms ease;
    }

    &::-webkit-slider-thumb {
      width: 24px;
      height: 24px;
      appearance: none;
      border: 0;
      border-radius: 50%;
      background: transparent;
      margin-top: calc((var(--track-height) - 24px) / 2);
      cursor: pointer;
    }

    &::-moz-range-thumb {
      width: 24px;
      height: 24px;
      border: 0;
      border-radius: 50%;
      background: transparent;
      cursor: pointer;
    }
  }

  .progress-row:hover .range,
  .range:focus-visible,
  .range:active {
    --track-height: 14px;
  }

  .is-page {
    display: block;
    width: 100%;

    .transport {
      display: flex;
      min-width: 0;
      max-width: none;
      gap: 20px;
    }

    .transport-buttons {
      order: 2;
      gap: clamp(24px, 7vw, 42px);
    }

    .play-button {
      width: 58px;
      height: 58px;
      background: rgba(255, 255, 255, 0.86);
      color: rgba(18, 18, 20, 0.86);

      &:hover {
        background: rgba(255, 255, 255, 0.94);
      }
    }

    .control-button {
      width: 46px;
      height: 46px;
    }

    .progress-row {
      order: 1;
      font-size: 0.72rem;
    }
  }

  .is-mini {
    display: block;
  }

  .mini-buttons {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .mini-play {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.86);
    color: rgba(18, 18, 20, 0.86);
  }

  .is-mini .mini-play {
    background: transparent;
    color: #fff;
  }

  @media (max-width: 720px) {
    .is-page .transport {
      gap: clamp(16px, 2.8svh, 24px);
    }

    .is-page .transport-buttons {
      width: 100%;
      justify-content: center;
      gap: clamp(34px, 12vw, 56px);
      padding: 0 10px;
    }

    .is-page .progress-row {
      gap: 7px;
      font-size: 0.67rem;
    }

    .is-page .range {
      --track-height: 11px;
    }

    .is-page .progress-row:hover .range,
    .is-page .range:focus-visible,
    .is-page .range:active {
      --track-height: 14px;
    }

    .is-page .range::-webkit-slider-runnable-track {
      background: linear-gradient(
        to right,
        rgba(255, 255, 255, 0.58) 0 var(--range-progress),
        rgba(255, 255, 255, 0.22) var(--range-progress) 100%
      );
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
    }

    .is-page .range::-moz-range-track {
      background: linear-gradient(
        to right,
        rgba(255, 255, 255, 0.58) 0 var(--range-progress),
        rgba(255, 255, 255, 0.22) var(--range-progress) 100%
      );
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.16);
    }

    .is-page .time-row {
      padding: 0 1px;
      color: rgba(255, 255, 255, 0.56);
      font-size: 0.69rem;
      font-weight: 520;
    }

    .is-page .control-button {
      width: 46px;
      height: 46px;
    }

    .is-page .play-button {
      width: 62px;
      height: 62px;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.24);
    }
  }

  @media (max-width: 360px), (max-height: 700px) and (max-width: 720px) {
    .is-page .transport {
      gap: 12px;
    }
    .is-page .transport-buttons {
      gap: 28px;
    }
    .is-page .play-button {
      width: 54px;
      height: 54px;
    }
    .is-page .control-button {
      width: 40px;
      height: 40px;
    }
    .is-page .range {
      --track-height: 10px;
    }
    .is-page .progress-row:hover .range,
    .is-page .range:focus-visible,
    .is-page .range:active {
      --track-height: 13px;
    }
  }
</style>
