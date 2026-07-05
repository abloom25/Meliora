<script setup lang="ts">
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import type { ComponentPublicInstance } from 'vue'
  import { Music, RefreshCw, Search, X } from '@lucide/vue'
  import type { Track } from '../types/music'
  import { useCoverCache } from '../composables/useCoverCache'

  const props = defineProps<{
    tracks: Track[]
    total: number
    currentTrackId: string | null
    isPlaying: boolean
    loading: boolean
    query: string
    spectrumLevels: number[]
    loadFailed?: boolean
  }>()

  const emit = defineEmits<{
    'update:query': [value: string]
    select: [track: Track]
    reload: []
  }>()

  const { loadedCovers, failedCovers, markCoverLoaded, markCoverFailed } = useCoverCache()
  const isScrolling = ref(false)
  const ITEM_HEIGHT = 66
  const BUFFER_COUNT = 5
  const SEARCH_DEBOUNCE_MS = 180

  const scrollTop = ref(0)
  const containerRef = ref<HTMLElement | null>(null)
  // 容器高度通过 ResizeObserver 维护为响应式 ref,
  // 这样窗口/抽屉尺寸变化时 virtualItems 会重新计算可见区域,而不必等待下一次滚动。
  const containerHeight = ref(600)
  const activeTrackElement = ref<HTMLElement | null>(null)
  const focusPulseTrackId = ref<string | null>(null)
  const debouncedQuery = ref(props.query)
  let scrollTimer = 0
  let focusTimer = 0
  let searchTimer = 0
  let resizeObserver: ResizeObserver | null = null

  const displayList = computed(() =>
    props.tracks.map((track, index) => ({
      track,
      display: {
        title: track.title,
        versions: track.titleVersions ?? [],
      },
      index,
    })),
  )

  const virtualItems = computed(() => {
    const height = containerHeight.value
    const total = displayList.value.length
    const start = Math.max(0, Math.floor(scrollTop.value / ITEM_HEIGHT) - BUFFER_COUNT)
    const visibleCount = Math.ceil(height / ITEM_HEIGHT) + BUFFER_COUNT * 2
    const end = Math.min(total, start + visibleCount)
    const topOffset = start * ITEM_HEIGHT
    const bottomOffset = Math.max(0, (total - end) * ITEM_HEIGHT)
    return {
      items: displayList.value.slice(start, end).map((item, i) => ({
        ...item,
        offset: (start + i) * ITEM_HEIGHT,
      })),
      topOffset,
      bottomOffset,
      totalHeight: total * ITEM_HEIGHT,
      total,
    }
  })

  function handleScroll(e: Event) {
    const target = e.target as HTMLElement
    scrollTop.value = target.scrollTop
    isScrolling.value = true
    window.clearTimeout(scrollTimer)
    scrollTimer = window.setTimeout(() => {
      isScrolling.value = false
    }, 850)
  }

  function handleSearchInput(value: string) {
    window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => {
      emit('update:query', value)
    }, SEARCH_DEBOUNCE_MS)
  }

  function clearSearch() {
    window.clearTimeout(searchTimer)
    debouncedQuery.value = ''
    emit('update:query', '')
  }

  function bindActiveTrackElement(
    trackId: string,
    element: Element | ComponentPublicInstance | null,
  ) {
    if (trackId !== props.currentTrackId) return
    activeTrackElement.value = element instanceof HTMLElement ? element : null
  }

  async function scrollActiveTrackIntoView(animate = true) {
    if (!props.currentTrackId) return
    await nextTick()
    const container = containerRef.value
    if (!container) return

    const targetIndex = displayList.value.findIndex(
      (item) => item.track.id === props.currentTrackId,
    )
    if (targetIndex < 0) return

    const targetOffset = targetIndex * ITEM_HEIGHT
    const focusOffset = 30
    container.scrollTo({
      top: targetOffset - focusOffset,
      behavior: animate ? 'smooth' : 'auto',
    })
    focusPulseTrackId.value = props.currentTrackId
    window.clearTimeout(focusTimer)
    focusTimer = window.setTimeout(() => {
      if (focusPulseTrackId.value === props.currentTrackId) focusPulseTrackId.value = null
    }, 1200)
  }

  onMounted(() => void scrollActiveTrackIntoView(false))
  // 监听容器节点:挂载时测量初始高度并接入 ResizeObserver,卸载/重建时断开旧 observer。
  // immediate 在 setup 阶段 containerRef.value 为 null,首次触发走 else 分支无副作用,
  // 节点真正绑定后再次触发完成接入。
  watch(
    () => containerRef.value,
    (el) => {
      resizeObserver?.disconnect()
      resizeObserver = null
      if (!el) return
      containerHeight.value = el.clientHeight
      if (typeof ResizeObserver === 'undefined') return
      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0]
        if (entry) containerHeight.value = entry.contentRect.height
      })
      resizeObserver.observe(el)
    },
    { immediate: true },
  )
  watch(
    () => props.currentTrackId,
    () => void scrollActiveTrackIntoView(),
  )
  watch(debouncedQuery, (value) => {
    handleSearchInput(value)
  })
  // 用 tracks.length + 首个 track.id 替代全量 concat.join，避免 O(n) 字符串拼接
  watch(
    () => [props.tracks.length, props.tracks[0]?.id],
    () => void scrollActiveTrackIntoView(false),
  )
  onBeforeUnmount(() => {
    window.clearTimeout(scrollTimer)
    window.clearTimeout(focusTimer)
    window.clearTimeout(searchTimer)
    resizeObserver?.disconnect()
    resizeObserver = null
  })
</script>

<template>
  <section class="track-panel">
    <header class="track-header">
      <div>
        <h2>播放队列</h2>
        <p>{{ total }} 首歌曲</p>
      </div>
    </header>

    <div class="list-toolbar">
      <div class="search-row">
        <label class="search-box">
          <Search :size="16" />
          <input v-model="debouncedQuery" type="search" placeholder="搜索" />
          <button v-if="query" aria-label="清空搜索" @click="clearSearch">
            <X :size="14" />
          </button>
        </label>
        <button
          class="reload-button"
          aria-label="重新加载歌曲"
          title="重新加载歌曲"
          :disabled="loading"
          @click="emit('reload')"
        >
          <RefreshCw :size="16" :class="{ spinning: loading }" />
        </button>
      </div>
    </div>

    <div
      ref="containerRef"
      class="track-list"
      :class="{ scrolling: isScrolling }"
      @scroll.passive="handleScroll"
    >
      <div
        v-if="virtualItems.total > 0"
        class="track-virtual-spacer"
        :style="{ height: `${virtualItems.totalHeight}px` }"
      >
        <button
          v-for="{ track, display, index, offset } in virtualItems.items"
          :key="track.id"
          :ref="(el) => bindActiveTrackElement(track.id, el)"
          class="track-item"
          :class="{ active: track.id === currentTrackId, focused: track.id === focusPulseTrackId }"
          :style="{ position: 'absolute', top: `${offset}px`, left: '0', right: '0' }"
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
            <strong>
              <span class="track-title-main">{{ display.title }}</span>
              <span v-if="display.versions.length" class="track-title-versions">
                <span
                  v-for="version in display.versions"
                  :key="version"
                  class="track-title-version"
                >
                  {{ version }}
                </span>
              </span>
            </strong>
            <small>{{ track.artist }}</small>
          </span>
          <span class="track-status">
            <span
              v-if="track.id === currentTrackId && isPlaying"
              class="spectrum-meter"
              aria-label="正在播放"
            >
              <i
                v-for="(level, band) in spectrumLevels"
                :key="band"
                :style="{ '--spectrum-level': `${Math.max(0.08, Math.min(1, level)) * 100}%` }"
              />
            </span>
            <span v-else>{{ index + 1 }}</span>
          </span>
        </button>
      </div>

      <div v-if="loading && !total" class="list-state"><span class="loader" />正在载入音乐</div>
      <div v-else-if="loadFailed && !tracks.length" class="list-state">
        <span class="empty-line">音乐列表载入失败,请稍后重试</span>
      </div>
      <div v-else-if="!tracks.length" class="list-state">
        <span class="empty-line">{{ query ? '没有找到匹配的歌曲' : '暂无歌曲' }}</span>
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

    &:hover {
      background: rgba(255, 255, 255, 0.13);
      color: #fff;
    }
    &:disabled {
      cursor: wait;
      opacity: 0.55;
    }
  }

  .list-toolbar {
    position: sticky;
    top: 0;
    z-index: 2;
    margin: 0 -4px;
    padding: 0 4px 6px;
    background: transparent;
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

      &::placeholder {
        color: var(--text-subtle);
      }
      &::-webkit-search-cancel-button {
        display: none;
      }
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

  .track-list {
    --track-focus-offset: 30px;
    position: relative;
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    scroll-padding-top: var(--track-focus-offset);
    padding-top: 10px;
    padding-bottom: 18px;
    scrollbar-color: transparent transparent;
    scrollbar-width: thin;
    mask-image: linear-gradient(
      180deg,
      transparent 0,
      #000 24px,
      #000 calc(100% - 34px),
      transparent 100%
    );
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

  .track-virtual-spacer {
    position: relative;
    min-height: 100%;
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

    &:hover {
      background: rgba(255, 255, 255, 0.07);
    }

    &.active {
      background: color-mix(in srgb, var(--accent) 17%, transparent);

      .track-copy strong,
      .track-status {
        color: var(--accent);
      }

      .track-title-version {
        color: color-mix(in srgb, var(--accent) 68%, rgba(255, 255, 255, 0.52));
      }
    }

    &.focused {
      animation: focus-glow 1.15s ease both;
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

    &.loaded img {
      opacity: 1;
    }
  }

  .cover-placeholder {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background:
      radial-gradient(circle at 32% 22%, rgba(255, 255, 255, 0.07), transparent 42%), #2c2c2e;
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

    strong {
      display: flex;
      max-width: 100%;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      color: rgba(255, 255, 255, 0.93);
      font-size: 0.78rem;
      font-weight: 560;
    }

    .track-title-main {
      min-width: 0;
      flex: 0 1 auto;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .track-title-versions {
      display: inline-flex;
      max-width: 118px;
      flex: 0 999 118px;
      align-items: baseline;
      gap: 6px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      mask-image: linear-gradient(90deg, #000 0, #000 calc(100% - 24px), transparent);
    }

    .track-title-version {
      display: inline-block;
      flex: 0 0 auto;
      color: rgba(255, 255, 255, 0.62);
      font-size: 0.78em;
      font-weight: 620;
      line-height: 1;
      white-space: nowrap;
    }

    small {
      color: var(--text-subtle);
      font-size: 0.66rem;
    }
  }

  .track-status {
    color: rgba(255, 255, 255, 0.25);
    font-size: 0.64rem;
    text-align: center;
  }

  .spectrum-meter {
    display: flex;
    height: 13px;
    align-items: center;
    justify-content: center;
    gap: 2.5px;

    i {
      width: 2px;
      height: var(--spectrum-level);
      min-height: 3px;
      max-height: 13px;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.92;
      transition: height 80ms linear;
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

  .spinning {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes focus-glow {
    0% {
      background: color-mix(in srgb, var(--accent) 28%, transparent);
      transform: scale(0.992);
    }
    45% {
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      transform: scale(1);
    }
    100% {
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      transform: scale(1);
    }
  }

  @media (max-width: 720px) {
    .track-panel {
      padding: 18px 30px max(16px, env(safe-area-inset-bottom));
    }

    .track-header {
      padding: 2px 6px 13px;

      h2 {
        font-size: 1.22rem;
      }
      p {
        margin-top: 4px;
        font-size: 0.68rem;
      }
    }

    .list-toolbar {
      padding-bottom: 3px;
    }

    .search-row {
      margin: 0 4px;
    }

    .search-box {
      height: 40px;
      border-radius: 16px;

      input {
        height: 38px;
        font-size: 16px;
      }
    }

    .reload-button {
      width: 40px;
      height: 40px;
      border-radius: 16px;
    }

    .track-list {
      --track-focus-offset: 24px;
      padding-top: 8px;
      padding-bottom: max(56px, calc(18px + env(safe-area-inset-bottom)));
      mask-image: linear-gradient(
        180deg,
        transparent 0,
        #000 18px,
        #000 calc(100% - 72px),
        transparent 100%
      );
    }

    .track-item {
      grid-template-columns: 46px minmax(0, 1fr) 23px;
      gap: 10px;
      padding: 5px 4px;
      border-radius: 15px;
    }

    .thumb {
      width: 46px;
      height: 46px;
      border-radius: 12px;
    }

    .track-copy {
      strong {
        font-size: 0.78rem;
      }
      small {
        font-size: 0.66rem;
      }
    }
  }

  @media (max-width: 360px), (max-height: 700px) and (max-width: 720px) {
    .track-panel {
      padding: 14px 24px max(12px, env(safe-area-inset-bottom));
    }

    .track-header {
      padding-bottom: 10px;

      h2 {
        font-size: 1.08rem;
      }
      p {
        font-size: 0.62rem;
      }
    }

    .search-box {
      height: 36px;
      border-radius: 14px;

      input {
        height: 34px;
        font-size: 16px;
      }
    }

    .reload-button {
      width: 36px;
      height: 36px;
      border-radius: 14px;
    }

    .track-list {
      --track-focus-offset: 20px;
      padding-top: 7px;
    }

    .track-item {
      grid-template-columns: 42px minmax(0, 1fr) 22px;
      gap: 9px;
      padding: 4px;
    }

    .thumb {
      width: 42px;
      height: 42px;
      border-radius: 11px;
    }

    .track-copy {
      gap: 2px;

      strong {
        font-size: 0.74rem;
      }
      small {
        font-size: 0.62rem;
      }
    }
  }
</style>
