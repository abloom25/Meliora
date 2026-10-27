<script setup lang="ts">
  import { computed, ref } from 'vue'
  import type { ListeningStatsSummary } from '../platform/web/listening-history'
  import type { Track } from '../core/types'
  import { listeningTrackKey } from '../core/playback/listening-stats'
  import SettingsSectionHeader from './SettingsSectionHeader.vue'

  const props = defineProps<{
    stats: ListeningStatsSummary
    track?: Track | null
    onClear: () => Promise<void>
  }>()
  const clearing = ref(false)
  const error = ref('')
  const favorites = computed(() =>
    [...props.stats.trackedTracks]
      .filter((track) => track.qualifiedPlays > 0)
      .sort((a, b) => b.qualifiedPlays - a.qualifiedPlays || b.listenedSeconds - a.listenedSeconds)
      .slice(0, 5),
  )
  const current = computed(() =>
    props.track
      ? props.stats.trackedTracks.find((record) => record.key === listeningTrackKey(props.track!))
      : undefined,
  )
  function listeningTime(seconds: number): string {
    if (seconds < 60) return `${Math.floor(seconds)} 秒`
    const minutes = Math.floor(seconds / 60)
    return minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
  }
  async function clear(): Promise<void> {
    if (clearing.value) return
    clearing.value = true
    error.value = ''
    try {
      await props.onClear()
    } catch {
      error.value = '清除未完成，请稍后重试'
    } finally {
      clearing.value = false
    }
  }
</script>

<template>
  <section class="settings-section listening-stats-section">
    <SettingsSectionHeader
      title="听歌统计"
      :resettable="stats.trackedTracks.length > 0 || clearing || !!error"
      :reset-label="clearing ? '正在清除' : '清除听歌记录'"
      confirm-label="再次点击清除"
      :reset-disabled="clearing"
      @reset="clear"
    />
    <div class="listening-content">
      <dl class="listening-totals">
        <div>
          <dt>累计收听</dt>
          <dd>{{ listeningTime(stats.totalListenedSeconds) }}</dd>
        </div>
        <div>
          <dt>有效播放</dt>
          <dd>{{ stats.totalQualifiedPlays }} 次</dd>
        </div>
        <div>
          <dt>常听歌曲</dt>
          <dd>{{ stats.frequentTracks }} 首</dd>
        </div>
      </dl>
      <p v-if="current" class="listening-current">
        当前歌曲已听 {{ current.qualifiedPlays }} 次 · {{ listeningTime(current.listenedSeconds) }}
        <span v-if="current.frequent">常听歌曲，优先保留分析结果</span>
      </p>
      <ol v-if="favorites.length" class="listening-ranking" aria-label="最常听的歌曲">
        <li v-for="(record, index) in favorites" :key="record.key">
          <span class="listening-rank">{{ index + 1 }}</span>
          <div class="listening-song">
            <strong :title="record.title">{{ record.title || '未命名歌曲' }}</strong>
            <span :title="record.artist">{{ record.artist || '未知歌手' }}</span>
          </div>
          <span class="listening-count">{{ record.qualifiedPlays }} 次</span>
        </li>
      </ol>
      <p v-else class="listening-empty">播放音乐后，这里会逐渐记录你的常听歌曲。</p>
      <p class="listening-note">
        单次实际收听满 30 秒（短歌为半首）记一次，播放 2 次后优先缓存节拍结果。
        统计仅保存在此浏览器。清除听歌记录不会删除歌词、模型或节拍缓存。
      </p>
      <p v-if="!stats.storageAvailable" class="listening-note" role="status">
        本地存储暂不可用，部分记录或缓存只能在本次打开期间保留。
      </p>
      <p v-if="error" class="listening-note" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped lang="scss">
  .listening-content {
    padding: 0 14px 14px;
  }
  .listening-totals {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px 18px;
    margin: 6px 0 14px;
    font-variant-numeric: tabular-nums;
    dt {
      color: rgba(255, 255, 255, 0.48);
      font-size: 0.66rem;
    }
    dd {
      margin: 4px 0 0;
      color: rgba(255, 255, 255, 0.86);
      font-size: 0.79rem;
      overflow-wrap: anywhere;
    }
  }
  .listening-current,
  .listening-empty {
    color: rgba(255, 255, 255, 0.65);
    font-size: 0.71rem;
    line-height: 1.6;
  }
  .listening-current span {
    display: block;
    color: rgba(255, 255, 255, 0.45);
    font-size: 0.66rem;
  }
  .listening-ranking {
    list-style: none;
    padding: 0;
    margin: 14px 0;
  }
  .listening-ranking li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 0;
  }
  .listening-rank {
    flex: 0 0 12px;
    color: rgba(255, 255, 255, 0.35);
    font-size: 0.65rem;
  }
  .listening-song {
    flex: 1;
    min-width: 0;
  }
  .listening-song strong,
  .listening-song span {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .listening-song strong {
    color: rgba(255, 255, 255, 0.8);
    font-size: 0.73rem;
    font-weight: 550;
  }
  .listening-song span {
    margin-top: 2px;
    color: rgba(255, 255, 255, 0.4);
    font-size: 0.65rem;
  }
  .listening-count {
    color: rgba(255, 255, 255, 0.55);
    font-size: 0.7rem;
    font-variant-numeric: tabular-nums;
  }
  .listening-note {
    margin: 8px 0 0;
    color: rgba(255, 255, 255, 0.4);
    font-size: 0.64rem;
    line-height: 1.7;
  }
  @media (max-width: 720px) {
    .listening-content {
      padding: 0 12px 12px;
    }
  }
  @media (prefers-contrast: more) {
    .listening-note,
    .listening-song span,
    .listening-rank,
    .listening-totals dt {
      color: rgba(255, 255, 255, 0.8);
    }
  }
</style>
