<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { ListMusic, Music, Play, RefreshCw, Search, Shuffle, X } from '@lucide/vue'
import type { Track } from '../types/music'

defineProps<{
  tracks: Track[]
  total: number
  currentTrackId: string | null
  isPlaying: boolean
  loading: boolean
  query: string
}>()

const emit = defineEmits<{
  'update:query': [value: string]
  select: [track: Track]
  playAll: []
  shuffle: []
  reload: []
}>()

const loadedCovers = ref(new Set<string>())
const failedCovers = ref(new Set<string>())
const isScrolling = ref(false)
let scrollTimer = 0

function markCoverLoaded(trackId: string) {
  loadedCovers.value = new Set(loadedCovers.value).add(trackId)
}

function markCoverFailed(trackId: string) {
  failedCovers.value = new Set(failedCovers.value).add(trackId)
}

function handleListScroll() {
  isScrolling.value = true
  window.clearTimeout(scrollTimer)
  scrollTimer = window.setTimeout(() => {
    isScrolling.value = false
  }, 850)
}

onBeforeUnmount(() => window.clearTimeout(scrollTimer))
</script>

<template>
  <section class="track-panel">
    <header class="track-header">
      <div>
        <h2>播放队列</h2>
        <p>{{ total }} 首歌曲</p>
      </div>
    </header>

    <div class="search-row">
      <label class="search-box">
        <Search :size="16" />
        <input
          :value="query"
          type="search"
          placeholder="搜索"
          @input="emit('update:query', ($event.target as HTMLInputElement).value)"
        />
        <button v-if="query" aria-label="清空搜索" @click="emit('update:query', '')"><X :size="14" /></button>
      </label>
      <button class="reload-button" aria-label="重新加载歌曲" title="重新加载歌曲" :disabled="loading" @click="emit('reload')">
        <RefreshCw :size="16" :class="{ spinning: loading }" />
      </button>
    </div>

    <div class="list-actions">
      <button :disabled="!tracks.length" @click="emit('playAll')"><Play :size="15" fill="currentColor" />播放</button>
      <button :disabled="!tracks.length" @click="emit('shuffle')"><Shuffle :size="15" />随机播放</button>
    </div>

    <div class="track-list" :class="{ scrolling: isScrolling }" @scroll.passive="handleListScroll">
      <button
        v-for="(track, index) in tracks"
        :key="track.id"
        class="track-item"
        :class="{ active: track.id === currentTrackId }"
        @click="emit('select', track)"
      >
        <span class="thumb" :class="{ loaded: loadedCovers.has(track.id) }">
          <span class="cover-placeholder"><Music :size="20" fill="currentColor" /></span>
          <img
            v-if="track.cover && !failedCovers.has(track.id)"
            :src="track.cover"
            alt=""
            loading="lazy"
            @load="markCoverLoaded(track.id)"
            @error="markCoverFailed(track.id)"
          />
        </span>
        <span class="track-copy">
          <strong>{{ track.title }}</strong>
          <small>{{ track.artist }}</small>
        </span>
        <span class="track-status">
          <span v-if="track.id === currentTrackId && isPlaying" class="equalizer"><i /><i /><i /></span>
          <span v-else>{{ index + 1 }}</span>
        </span>
      </button>

      <div v-if="loading && !total" class="list-state">
        <span class="loader" />正在载入音乐
      </div>
      <div v-else-if="!tracks.length" class="list-state">
        <ListMusic :size="25" />{{ query ? '没有找到匹配的歌曲' : '暂无歌曲' }}
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.track-panel {
  display: flex;
  min-width: 0;
  height: 100%;
  flex-direction: column;
  padding: 24px 18px 16px;
  color: var(--text);
}

.track-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 5px 17px;

  h2 {
    margin: 0;
    color: #fff;
    font-size: 1.18rem;
    font-weight: 700;
    letter-spacing: -0.035em;
  }

  p {
    margin: 4px 0 0;
    color: var(--text-subtle);
    font-size: 0.72rem;
  }
}

.reload-button {
  display: grid;
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  corner-shape: squircle;
  background: rgba(255, 255, 255, 0.055);
  backdrop-filter: blur(18px) saturate(145%);
  color: var(--text-subtle);
  cursor: pointer;

  &:hover { background: rgba(255, 255, 255, 0.13); color: #fff; }
  &:disabled { cursor: wait; opacity: 0.55; }
}

.search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 5px;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  padding: 0 11px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 15px;
  corner-shape: squircle;
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(18px) saturate(145%);
  color: var(--text-subtle);

  input {
    min-width: 0;
    height: 36px;
    flex: 1;
    border: 0;
    outline: 0;
    background: none;
    color: #fff;
    font-size: 0.78rem;

    &::placeholder { color: var(--text-subtle); }
    &::-webkit-search-cancel-button { display: none; }
  }

  button {
    display: grid;
    padding: 3px;
    border: 0;
    background: none;
    color: var(--text-subtle);
    cursor: pointer;
  }
}

.list-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 9px;
  padding: 12px 5px 10px;

  button {
    display: flex;
    height: 36px;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 14px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.045);
    backdrop-filter: blur(18px) saturate(145%);
    color: var(--accent);
    font-size: 0.72rem;
    font-weight: 600;
    cursor: pointer;

    &:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
    &:disabled { opacity: 0.35; }
  }
}

.track-list {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  scrollbar-color: transparent transparent;
  scrollbar-width: thin;
  transition: scrollbar-color 180ms ease;

  &.scrolling {
    scrollbar-color: rgba(255, 255, 255, 0.24) transparent;
  }

  &::-webkit-scrollbar {
    width: 5px;
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    border-radius: 99px;
    background: transparent;
  }

  &.scrolling::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.24);
  }
}

.track-item {
  display: grid;
  width: 100%;
  grid-template-columns: 46px minmax(0, 1fr) 28px;
  align-items: center;
  gap: 11px;
  padding: 6px;
  border: 0;
  border-radius: 14px;
  corner-shape: squircle;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: background 130ms ease;

  &:hover { background: rgba(255, 255, 255, 0.07); }

  &.active {
    background: color-mix(in srgb, var(--accent) 17%, transparent);

    .track-copy strong,
    .track-status { color: var(--accent); }
  }
}

.thumb {
  position: relative;
  display: grid;
  width: 46px;
  height: 46px;
  place-items: center;
  overflow: hidden;
  border-radius: 11px;
  corner-shape: squircle;
  background: #2c2c2e;
  color: rgba(255, 255, 255, 0.26);
  font-size: 0.8rem;
  font-weight: 700;

  img {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 220ms ease;
  }

  &.loaded img { opacity: 1; }
}

.cover-placeholder {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle at 32% 22%, rgba(255, 255, 255, 0.07), transparent 42%),
    #2c2c2e;
}

.track-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;

  strong,
  small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  strong { color: rgba(255, 255, 255, 0.93); font-size: 0.78rem; font-weight: 560; }
  small { color: var(--text-subtle); font-size: 0.66rem; }
}

.track-status {
  color: rgba(255, 255, 255, 0.25);
  font-size: 0.64rem;
  text-align: center;
}

.equalizer {
  display: flex;
  height: 13px;
  align-items: flex-end;
  justify-content: center;
  gap: 2px;

  i {
    width: 2px;
    border-radius: 2px;
    background: currentColor;
    animation: equalize 0.75s ease-in-out infinite alternate;
    &:nth-child(1) { height: 45%; }
    &:nth-child(2) { height: 100%; animation-delay: -0.25s; }
    &:nth-child(3) { height: 65%; animation-delay: -0.45s; }
  }
}

.list-state {
  display: flex;
  min-height: 180px;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 10px;
  color: var(--text-subtle);
  font-size: 0.76rem;
}

.loader {
  width: 22px;
  height: 22px;
  border: 2px solid rgba(255, 255, 255, 0.13);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes equalize { to { height: 20%; } }

@media (max-width: 720px) {
  .track-panel {
    padding:
      max(22px, env(safe-area-inset-top))
      14px
      max(14px, env(safe-area-inset-bottom));
  }

  .track-header {
    padding: 3px 7px 18px;

    h2 { font-size: 1.42rem; }
    p { margin-top: 5px; font-size: 0.75rem; }
  }

  .search-row { margin: 0 4px; }

  .search-box {
    height: 42px;
    border-radius: 17px;

    input {
      height: 40px;
      font-size: 0.82rem;
    }
  }

  .reload-button {
    width: 42px;
    height: 42px;
    border-radius: 17px;
  }

  .list-actions {
    padding: 12px 4px 10px;

    button {
      height: 40px;
      border-radius: 16px;
      font-size: 0.76rem;
    }
  }

  .track-item {
    grid-template-columns: 50px minmax(0, 1fr) 25px;
    gap: 11px;
    padding: 6px 5px;
    border-radius: 16px;
  }

  .thumb {
    width: 50px;
    height: 50px;
    border-radius: 13px;
  }

  .track-copy {
    strong { font-size: 0.82rem; }
    small { font-size: 0.69rem; }
  }
}
</style>
