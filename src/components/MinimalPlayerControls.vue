<script setup lang="ts">
  import { Pause, Play, SkipForward } from '@lucide/vue'
  import { computed } from 'vue'

  const props = withDefaults(
    defineProps<{
      isPlaying: boolean
      currentTime: number
      duration: number
      disabled?: boolean
      onToggle: () => void
      onNext: () => void
    }>(),
    { disabled: false },
  )

  const safeDuration = computed(() =>
    Number.isFinite(props.duration) ? Math.max(0, props.duration) : 0,
  )
  const safeCurrentTime = computed(() =>
    Number.isFinite(props.currentTime)
      ? Math.min(safeDuration.value, Math.max(0, props.currentTime))
      : 0,
  )
  const progress = computed(() =>
    safeDuration.value > 0 ? (safeCurrentTime.value / safeDuration.value) * 100 : 0,
  )
  const progressText = computed(
    () => `${formatTime(safeCurrentTime.value)} / ${formatTime(safeDuration.value)}`,
  )

  function formatTime(value: number): string {
    const seconds = Math.floor(value)
    const minutes = Math.floor(seconds / 60)
    const remainder = String(seconds % 60).padStart(2, '0')
    if (minutes < 60) return `${minutes}:${remainder}`
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}`
  }

  function togglePlayback(): void {
    if (!props.disabled) props.onToggle()
  }

  function nextTrack(): void {
    if (!props.disabled) props.onNext()
  }
</script>

<template>
  <div class="minimal-player-controls" role="group" aria-label="播放控制">
    <div class="minimal-play-control">
      <button
        class="minimal-button minimal-play"
        type="button"
        :disabled="disabled"
        :aria-label="isPlaying ? '暂停' : '播放'"
        :title="isPlaying ? '暂停' : '播放'"
        @click="togglePlayback"
      >
        <Pause v-if="isPlaying" aria-hidden="true" fill="currentColor" />
        <Play v-else aria-hidden="true" fill="currentColor" />
      </button>
      <svg
        class="minimal-progress"
        :class="{ disabled }"
        viewBox="0 0 64 64"
        role="progressbar"
        aria-label="播放进度"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="progress"
        :aria-valuetext="progressText"
        focusable="false"
      >
        <circle class="minimal-progress-track" cx="32" cy="32" r="28" />
        <circle
          class="minimal-progress-fill"
          cx="32"
          cy="32"
          r="28"
          pathLength="100"
          stroke-dasharray="100"
          :stroke-dashoffset="100 - progress"
          :opacity="progress > 0 ? 1 : 0"
          transform="rotate(-90 32 32)"
        />
      </svg>
    </div>
    <button
      class="minimal-button minimal-next"
      type="button"
      :disabled="disabled"
      aria-label="下一首"
      title="下一首"
      @click="nextTrack"
    >
      <SkipForward aria-hidden="true" fill="currentColor" />
    </button>
  </div>
</template>

<style scoped lang="scss">
  .minimal-player-controls {
    --minimal-button-size: max(44px, var(--minimal-control-size, 56px));
    display: flex;
    flex: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: clamp(4px, calc(var(--player-viewport-height, 100dvh) * 0.035), 14px);
    min-width: 0;
  }

  .minimal-play-control {
    position: relative;
    width: var(--minimal-button-size);
    height: var(--minimal-button-size);
    flex: none;
  }

  .minimal-button {
    position: relative;
    display: grid;
    width: var(--minimal-button-size);
    height: var(--minimal-button-size);
    flex: none;
    padding: 0;
    place-items: center;
    border: 0;
    border-radius: 50%;
    color: rgba(255, 255, 255, 0.9);
    background: transparent;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition:
      background 180ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 180ms cubic-bezier(0.16, 1, 0.3, 1);

    &::before {
      position: absolute;
      inset: 6px;
      border-radius: inherit;
      background: rgba(255, 255, 255, 0.1);
      content: '';
      transition: background 180ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    &:hover:not(:disabled)::before {
      background: rgba(255, 255, 255, 0.18);
    }

    &:active:not(:disabled)::before {
      background: rgba(255, 255, 255, 0.25);
    }

    &:focus-visible {
      outline: 2px solid rgba(255, 255, 255, 0.9);
      outline-offset: 2px;
    }

    &:disabled {
      opacity: 0.4;
      cursor: default;
    }

    svg {
      position: relative;
      display: block;
      width: 40%;
      height: 40%;
      flex: none;
      overflow: visible;
    }
  }

  .minimal-next::before {
    inset: 4px;
    background: rgba(255, 255, 255, 0.06);
  }

  .minimal-progress {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
    fill: none;
    stroke-width: 3;
    pointer-events: none;

    &.disabled {
      opacity: 0.4;
    }
  }

  .minimal-progress-track {
    stroke: rgba(255, 255, 255, 0.16);
  }

  .minimal-progress-fill {
    stroke: rgba(255, 255, 255, 0.9);
    stroke-linecap: round;
    transition: stroke-dashoffset 160ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  @media (prefers-reduced-motion: reduce) {
    .minimal-button,
    .minimal-button::before,
    .minimal-progress-fill {
      transition: none;
    }
  }

  @media (prefers-contrast: more) {
    .minimal-button,
    .minimal-progress-fill {
      color: #fff;
      stroke: #fff;
    }

    .minimal-progress-track {
      stroke: rgba(255, 255, 255, 0.5);
    }
  }
</style>
