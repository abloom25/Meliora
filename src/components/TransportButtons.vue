<script setup lang="ts">
  import { Pause, Play, SkipBack, SkipForward } from '@lucide/vue'

  const props = withDefaults(
    defineProps<{
      variant?: 'bar' | 'page' | 'mini' | 'vertical'
      isPlaying: boolean
      onToggle: () => void
      onPrevious: () => void
      onNext: () => void
    }>(),
    {
      variant: 'bar',
    },
  )

  const iconSize = () => {
    if (props.variant === 'page') return 28
    if (props.variant === 'mini') return 19
    return 21
  }

  const playIconSize = () => {
    if (props.variant === 'page') return 30
    if (props.variant === 'mini') return 19
    return 22
  }
</script>

<template>
  <div :class="[variant === 'mini' ? 'mini-buttons' : 'transport-buttons', `is-${variant}`]">
    <button class="control-button" aria-label="上一首" @click="onPrevious">
      <SkipBack :size="iconSize()" fill="currentColor" />
    </button>
    <button
      :class="variant === 'mini' ? 'mini-play' : 'play-button'"
      :aria-label="isPlaying ? '暂停' : '播放'"
      @click="onToggle"
    >
      <Pause v-if="isPlaying" :size="playIconSize()" fill="currentColor" />
      <Play v-else :size="playIconSize()" fill="currentColor" />
    </button>
    <button class="control-button" aria-label="下一首" @click="onNext">
      <SkipForward :size="iconSize()" fill="currentColor" />
    </button>
  </div>
</template>

<style scoped lang="scss">
  .transport-buttons,
  .mini-buttons {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }

  .mini-buttons {
    gap: 2px;
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

  .mini-play {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    background: transparent;
    color: #fff;
  }

  .transport-buttons.is-bar {
    gap: 10px;
  }

  .transport-buttons.is-page {
    order: 2;
    gap: clamp(24px, 7vw, 42px);
  }

  .transport-buttons.is-page .play-button {
    width: 58px;
    height: 58px;
    background: rgba(255, 255, 255, 0.86);
    color: rgba(18, 18, 20, 0.86);

    &:hover {
      background: rgba(255, 255, 255, 0.94);
    }
  }

  .transport-buttons.is-page .control-button {
    width: 46px;
    height: 46px;
  }

  .transport-buttons.is-vertical {
    flex-direction: column;
    gap: 8px;
    padding: 6px 0;
  }

  .transport-buttons.is-vertical .control-button {
    width: 38px;
    height: 38px;
    color: rgba(255, 255, 255, 0.7);

    &:hover {
      background: rgba(255, 255, 255, 0.09);
      color: rgba(255, 255, 255, 0.94);
    }

    &:focus-visible {
      background: rgba(255, 255, 255, 0.12);
    }
  }

  .transport-buttons.is-vertical .play-button {
    width: 46px;
    height: 46px;
    background: rgba(255, 255, 255, 0.9);
    color: rgba(18, 18, 20, 0.9);
    box-shadow:
      0 8px 22px rgba(0, 0, 0, 0.2),
      inset 0 1px rgba(255, 255, 255, 0.45);

    &:hover {
      background: #fff;
      transform: scale(1.05);
    }

    &:focus-visible {
      outline-offset: 4px;
    }
  }

  @media (max-width: 720px) {
    .transport-buttons.is-page {
      width: 100%;
      justify-content: center;
      gap: clamp(34px, 12vw, 56px);
      padding: 0 10px;
    }
  }

  @media (max-width: 420px) {
    .transport-buttons.is-page {
      gap: clamp(28px, 10vw, 42px);
      padding: 0;
    }
  }
</style>
