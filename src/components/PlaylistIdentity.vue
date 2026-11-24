<script setup lang="ts">
  import { Disc3 } from '@lucide/vue'
  import { useCoverCache } from '../composables/useCoverCache'
  import type { LibraryPlaylist } from '../services/music'

  defineProps<{ playlist?: Omit<LibraryPlaylist, 'trackKeys'>; placeholder?: string }>()
  const { failedCovers, markCoverFailed } = useCoverCache()
</script>

<template>
  <span class="playlist-art" aria-hidden="true">
    <img
      v-if="playlist?.cover && !failedCovers.has(playlist.cover)"
      :src="playlist.cover"
      alt=""
      loading="lazy"
      @error="markCoverFailed(playlist.id, playlist.cover)"
    />
    <Disc3 v-else :size="24" :stroke-width="1.4" />
  </span>
  <span class="playlist-copy">
    <strong>{{ playlist?.label ?? placeholder }}</strong>
    <small v-if="playlist">{{ playlist.platform }}</small>
  </span>
</template>

<style scoped lang="scss">
  .playlist-art {
    display: grid;
    width: var(--playlist-art-size, 44px);
    aspect-ratio: 1;
    flex: none;
    place-items: center;
    overflow: hidden;
    border-radius: 9px;
    background: linear-gradient(145deg, rgba(var(--accent-rgb), 0.22), rgba(255, 255, 255, 0.06));
    color: var(--text-muted);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .playlist-copy {
    display: grid;
    flex: 1;
    min-width: 0;
    gap: 3px;
    text-align: start;
  }
  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  strong {
    color: var(--text);
    font-size: var(--playlist-title-size, 0.9rem);
    font-weight: 700;
    line-height: 1.25;
  }
  small {
    color: var(--text-muted);
    font-size: 0.72rem;
    line-height: 1.4;
  }
</style>
