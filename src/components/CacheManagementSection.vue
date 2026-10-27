<script setup lang="ts">
  import { computed, ref, toRef, watch } from 'vue'
  import { ChevronDown, Pin, Trash2 } from '@lucide/vue'
  import type { Track } from '../core/types'
  import { useCacheManagement } from '../composables/useCacheManagement'
  import SettingsSectionHeader from './SettingsSectionHeader.vue'
  import SettingRange from './SettingRange.vue'
  import Collapse from './Collapse.vue'

  const props = defineProps<{ currentTrack?: Track | null }>()
  const cache = useCacheManagement(toRef(props, 'currentTrack'))
  const { loading, busy, error, lyrics, modelBytes, tracks, models, beat } = cache
  const budget = ref(beat.value.maxBytes / 1024 / 1024)
  const expanded = ref(false)
  const page = ref(0)
  const pageSize = 20
  const pageCount = computed(() => Math.max(1, Math.ceil(tracks.value.length / pageSize)))
  const visibleTracks = computed(() =>
    tracks.value.slice(page.value * pageSize, (page.value + 1) * pageSize),
  )
  const modelIds = ['small', 'standard'] as const
  watch(
    () => beat.value.maxBytes,
    (bytes) => {
      budget.value = bytes / 1024 / 1024
    },
  )
  watch(pageCount, (count) => {
    page.value = Math.min(page.value, count - 1)
  })
  function size(bytes: number): string {
    return bytes < 1024 * 1024
      ? `${Math.ceil(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
</script>

<template>
  <section class="settings-section cache-management-section" :aria-busy="loading">
    <SettingsSectionHeader title="缓存管理" />
    <div v-if="loading" class="cache-loading" role="status" aria-label="正在读取缓存占用">
      <span /><span /><span />
    </div>
    <div v-else class="cache-content">
      <div class="cache-group">
        <SettingsSectionHeader
          title="歌词"
          :resettable="lyrics.entries > 0 || !!error"
          reset-label="清除歌词缓存"
          confirm-label="再次点击清除"
          :reset-disabled="!!busy"
          @reset="cache.clearLyrics"
        />
        <p>{{ lyrics.entries }} 份 · 约 {{ size(lyrics.bytes) }}</p>
      </div>
      <div class="cache-group">
        <SettingsSectionHeader
          title="节拍分析结果"
          :resettable="beat.cachedTracks > 0 || !!error"
          reset-label="清除节拍缓存"
          confirm-label="再次点击清除"
          :reset-disabled="!!busy"
          @reset="cache.clearBeats"
        />
        <p>{{ beat.cachedTracks }} 首 · {{ size(beat.cacheBytes) }} / {{ budget }} MB</p>
        <div class="cache-budget">
          <span>容量上限</span><output>{{ budget }} MB</output>
          <SettingRange
            v-model="budget"
            :min="8"
            :max="128"
            :step="8"
            :disabled="!!busy"
            aria-label="节拍缓存容量上限"
            :aria-value-text="`${budget} MB`"
            @change="cache.setBudget"
          />
        </div>
        <Collapse v-if="tracks.length" v-model:expanded="expanded">
          <template #trigger="{ toggle }">
            <button
              class="cache-list-toggle"
              type="button"
              :aria-expanded="expanded"
              @click="toggle"
            >
              管理已缓存歌曲 <ChevronDown :size="14" :class="{ collapsed: !expanded }" />
            </button>
          </template>
          <ul class="cache-tracks" aria-label="已缓存的节拍分析">
            <li v-for="track in visibleTracks" :key="track.track">
              <div class="cache-track-info">
                <strong :title="track.title">{{ track.title }}</strong>
                <span
                  >{{ track.artist }}{{ track.artist ? ' · ' : '' }}{{ size(track.bytes)
                  }}{{ track.current ? ' · 当前歌曲' : '' }}</span
                >
                <span v-if="track.pinned">已固定 · 优先保留</span>
              </div>
              <button
                type="button"
                :aria-label="`${track.pinned ? '取消固定' : '固定缓存'}：${track.title}`"
                :title="track.pinned ? '取消固定' : '优先保留缓存'"
                :aria-pressed="track.pinned"
                :disabled="!!busy"
                @click="cache.pinTrack(track.track, !track.pinned)"
              >
                <Pin :size="16" />
              </button>
              <button
                type="button"
                :aria-label="`清除节拍缓存：${track.title}`"
                title="清除此曲的节拍缓存"
                :disabled="!!busy"
                @click="cache.removeTrack(track.track)"
              >
                <Trash2 :size="16" />
              </button>
            </li>
          </ul>
          <div v-if="pageCount > 1" class="cache-pagination">
            <button type="button" :disabled="page === 0" @click="page--">上一页</button>
            <span>{{ page + 1 }} / {{ pageCount }}</span>
            <button type="button" :disabled="page + 1 >= pageCount" @click="page++">下一页</button>
          </div>
        </Collapse>
      </div>
      <div class="cache-group">
        <div v-for="id in modelIds" :key="id" class="cache-model">
          <SettingsSectionHeader
            :title="id === 'small' ? 'Beat This! Small' : 'Beat This! 标准版'"
            :resettable="modelBytes[id] > 0 || models[id].phase === 'downloading'"
            reset-label="删除模型"
            confirm-label="再次点击删除"
            :reset-disabled="!!busy"
            @reset="cache.removeModel(id)"
          />
          <p>
            {{ size(modelBytes[id])
            }}{{
              models[id].phase === 'downloading'
                ? ' · 正在下载'
                : models[id].phase === 'ready'
                  ? ' · 已下载'
                  : modelBytes[id] > 0
                    ? ' · 部分下载'
                    : ' · 未下载'
            }}
          </p>
        </div>
        <p class="cache-note">
          共用运行文件 {{ size(modelBytes.runtime) }}，删除最后一个模型时一并清理。
        </p>
      </div>
      <p class="cache-note">
        固定的结果优先保留，仍受容量、有效期和版本限制。这里只保存歌词、模型与节拍分析，不保存整首音频。听歌记录在「听歌统计」中单独清理。
      </p>
      <p v-if="!lyrics.storageAvailable || !beat.storageAvailable" class="cache-note" role="status">
        本地存储暂不可用，缓存占用可能无法完整读取。
      </p>
      <p v-if="error" class="cache-error" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped lang="scss">
  .cache-content {
    padding: 0 14px 14px;
  }
  .cache-group {
    padding-bottom: 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    margin-bottom: 10px;
  }
  .cache-group :deep(.settings-section-header) {
    padding: 10px 0;
  }
  .cache-model + .cache-model {
    margin-top: 12px;
  }
  .cache-group p {
    margin: 0;
    color: rgba(255, 255, 255, 0.65);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
  }
  .cache-budget {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 6px;
    margin-top: 14px;
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.65);
  }
  .cache-budget :deep(.setting-range) {
    grid-column: 1 / -1;
  }
  .cache-note {
    font-size: 0.64rem !important;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.45) !important;
    margin-top: 8px !important;
  }
  .cache-error {
    color: rgba(255, 170, 160, 0.95);
    font-size: 0.7rem;
  }
  .cache-list-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 10px 0;
    margin-top: 6px;
  }
  button {
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: rgba(255, 255, 255, 0.65);
    cursor: pointer;
    font: inherit;
    font-size: 0.7rem;
  }
  button:hover {
    color: rgba(255, 255, 255, 0.95);
    background: rgba(255, 255, 255, 0.06);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button[aria-pressed='true'] {
    color: var(--accent);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .cache-list-toggle svg {
    transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .cache-list-toggle .collapsed {
    transform: rotate(-90deg);
  }
  .cache-tracks {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .cache-tracks li {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    padding: 8px 0;
  }
  .cache-tracks button {
    flex: 0 0 36px;
    height: 36px;
    display: grid;
    place-items: center;
  }
  .cache-track-info {
    flex: 1;
    min-width: 0;
  }
  .cache-track-info strong,
  .cache-track-info span {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .cache-track-info strong {
    font-size: 0.73rem;
    font-weight: 550;
    color: rgba(255, 255, 255, 0.8);
  }
  .cache-track-info span {
    font-size: 0.64rem;
    color: rgba(255, 255, 255, 0.45);
    margin-top: 3px;
  }
  .cache-pagination {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 0.7rem;
    color: rgba(255, 255, 255, 0.6);
  }
  .cache-pagination button {
    padding: 8px;
  }
  .cache-loading {
    display: grid;
    gap: 16px;
    padding: 10px 14px 20px;
  }
  .cache-loading span {
    height: 34px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.07);
    animation: cache-pulse 1.4s ease-in-out infinite alternate;
  }
  @keyframes cache-pulse {
    to {
      opacity: 0.4;
    }
  }
  @media (pointer: coarse) {
    .cache-tracks button {
      flex-basis: 44px;
      height: 44px;
    }
  }
  @media (max-width: 720px) {
    .cache-content {
      padding: 0 12px 12px;
    }
    .cache-loading {
      padding: 8px 12px 16px;
    }
  }
  @media (max-width: 360px), (max-height: 700px) and (max-width: 720px) {
    .cache-content {
      padding: 0 10px 11px;
    }
    .cache-loading {
      gap: 12px;
      padding: 6px 10px 14px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .cache-loading span {
      animation: none;
    }
    .cache-list-toggle svg {
      transition: none;
    }
  }
  @media (prefers-contrast: more) {
    .cache-note,
    .cache-track-info span {
      color: rgba(255, 255, 255, 0.8) !important;
    }
  }
</style>
