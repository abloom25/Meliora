<script setup lang="ts">
  import { storeToRefs } from 'pinia'
  import { usePlayerStore } from '../stores/player'
  import ProgressControl from './ProgressControl.vue'
  import TransportButtons from './TransportButtons.vue'
  import type { LyricsSnapshot } from '../types/music'

  withDefaults(
    defineProps<{
      variant?: 'bar' | 'page' | 'progress' | 'mini' | 'vertical'
      onToggle: () => void
      onPrevious: () => void
      onNext: () => void
      onSeek: (time: number) => void
      lyricPreview?: LyricsSnapshot | null
      previewEnabled?: boolean
    }>(),
    {
      variant: 'bar',
      lyricPreview: null,
      previewEnabled: true,
    },
  )

  const store = usePlayerStore()
  const { isPlaying } = storeToRefs(store)
</script>

<template>
  <div class="controls" :class="`is-${variant}`">
    <div v-if="variant !== 'mini'" class="transport">
      <TransportButtons
        v-if="variant !== 'progress'"
        :variant="variant"
        :is-playing="isPlaying"
        :on-toggle="onToggle"
        :on-previous="onPrevious"
        :on-next="onNext"
      />
      <ProgressControl
        v-if="variant !== 'bar' && variant !== 'vertical'"
        :variant="variant === 'progress' ? 'progress' : 'page'"
        :on-seek="onSeek"
        :lyric-preview="lyricPreview"
        :preview-enabled="previewEnabled"
      />
    </div>

    <TransportButtons
      v-else
      variant="mini"
      :is-playing="isPlaying"
      :on-toggle="onToggle"
      :on-previous="onPrevious"
      :on-next="onNext"
    />
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

  .is-progress {
    display: block;
    min-width: 0;

    .transport {
      display: block;
      min-width: 0;
      max-width: none;
    }
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
  }

  .is-mini {
    display: block;
  }

  .is-vertical {
    display: block;
    width: 54px;

    .transport {
      min-width: 0;
      width: 100%;
      max-width: none;
      flex: none;
    }
  }

  @media (max-width: 720px) {
    .is-page .transport {
      gap: clamp(16px, 2.8svh, 24px);
    }
  }

  @media (max-width: 420px) {
    .is-page .transport {
      gap: 13px;
    }
  }
</style>
