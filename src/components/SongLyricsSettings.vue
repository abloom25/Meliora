<script setup lang="ts">
  import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import { ChevronDown, Minus, Plus, RefreshCw } from '@lucide/vue'
  import { usePlayerStore } from '../stores/player'
  import { useSongLyricsPreferences } from '../composables/useSongLyricsPreferences'
  import { loadTrackLyricsChoices, type TrackLyricsChoice } from '../services/lyrics'
  import type { LyricProviderSource } from '../core/types'
  import Collapse from './Collapse.vue'
  import SongInfoValue from './SongInfoValue.vue'
  import LyricsTimingCalibration from './LyricsTimingCalibration.vue'
  import type { LyricCalibrationContext } from '../core/lyrics/calibration'
  import type { LyricPlaybackState } from '../core/lyrics/render-schedule'

  const props = defineProps<{
    getCalibrationLyrics?: () => LyricCalibrationContext | null
    getPlaybackState?: () => LyricPlaybackState
  }>()
  const { currentTrack, currentTrackVersion, isPlaying } = storeToRefs(usePlayerStore())
  const preferences = useSongLyricsPreferences(currentTrack)
  const calibration = computed(() => {
    const value = props.getCalibrationLyrics?.()
    return value?.trackId === currentTrack.value?.id &&
      value?.source === preferences.resolvedSource.value
      ? (value ?? null)
      : null
  })
  const sectionId = useId()
  const expanded = ref(false)
  const loading = ref(false)
  const refreshing = ref(false)
  const failed = ref(false)
  const choices = shallowRef<TrackLyricsChoice[]>([])
  const previewSource = ref<LyricProviderSource | null>(null)
  let controller: AbortController | null = null
  const names: Record<LyricProviderSource, string> = {
    amll: 'AMLL 逐字歌词库',
    netease: '网易云逐字歌词',
    qq: 'QQ 音乐逐字歌词',
    meting: '歌曲原始歌词',
    local: '本地歌词',
  }
  const selectionLabel = computed(() =>
    preferences.selection.value === 'auto' ? '自动选择' : names[preferences.selection.value],
  )
  const preview = computed(() =>
    choices.value.find((choice) => choice.source === previewSource.value),
  )
  const sourceListHeight = computed(() => {
    const count = choices.value.length || (loading.value ? 2 : 0)
    return count ? Math.min(count, 3) * 64 + Math.min(count - 1, 2) * 8 : 44
  })
  const offsetLabel = computed(() => {
    const offset = preferences.offsetMs.value
    return offset === 0
      ? '未调整'
      : `${offset < 0 ? '提前' : '延后'} ${(Math.abs(offset) / 1000).toFixed(1)} 秒`
  })
  const offsetValue = computed(() => {
    const offset = preferences.offsetMs.value
    const sign = offset < 0 ? '−' : offset > 0 ? '+' : ''
    return `${sign}${(Math.abs(offset) / 1000).toFixed(1)}`
  })
  const fallback = computed(
    () =>
      preferences.selection.value !== 'auto' &&
      preferences.resolvedSource.value &&
      preferences.selection.value !== preferences.resolvedSource.value,
  )

  async function loadChoices(): Promise<void> {
    controller?.abort()
    const track = currentTrack.value
    if (!expanded.value || !track) return
    const request = new AbortController()
    controller = request
    loading.value = true
    failed.value = false
    try {
      const loaded = await loadTrackLyricsChoices(track, request.signal)
      if (request.signal.aborted || controller !== request) return
      choices.value = loaded
      if (!loaded.some((choice) => choice.source === previewSource.value))
        previewSource.value = loaded[0]?.source ?? null
    } catch {
      if (!request.signal.aborted) failed.value = true
    } finally {
      if (controller === request) loading.value = false
    }
  }

  function toggleSources(): void {
    expanded.value = !expanded.value
    if (expanded.value) void loadChoices()
    else {
      controller?.abort()
      loading.value = false
    }
  }

  async function refresh(): Promise<void> {
    if (refreshing.value || !currentTrack.value) return
    refreshing.value = true
    failed.value = false
    controller?.abort()
    try {
      await preferences.refresh()
      await loadChoices()
    } catch {
      failed.value = true
    } finally {
      refreshing.value = false
    }
  }

  function adjustOffset(delta: number): void {
    preferences.setOffset(preferences.offsetMs.value + delta)
  }

  watch(
    () => [currentTrack.value?.id, currentTrackVersion.value],
    () => {
      controller?.abort()
      choices.value = []
      previewSource.value = null
      failed.value = false
      loading.value = false
      if (expanded.value) void loadChoices()
    },
  )
  onBeforeUnmount(() => controller?.abort())
</script>

<template>
  <div v-if="currentTrack" class="song-lyrics-settings">
    <div class="lyrics-source-section">
      <div class="source-heading">
        <strong>本曲歌词</strong>
        <button
          class="source-toggle"
          type="button"
          aria-label="选择本曲歌词来源"
          :aria-describedby="`${sectionId}-selection`"
          :aria-controls="`${sectionId}-sources`"
          :aria-expanded="expanded"
          :title="selectionLabel"
          @click="toggleSources"
        >
          <span :id="`${sectionId}-selection`">{{ selectionLabel }}</span>
          <ChevronDown :size="16" :class="{ collapsed: !expanded }" aria-hidden="true" />
        </button>
      </div>
      <Collapse :id="`${sectionId}-sources`" :expanded="expanded">
        <div class="source-options" aria-label="本曲歌词来源">
          <div class="source-auto-row">
            <button
              class="source-choice"
              :aria-pressed="preferences.selection.value === 'auto'"
              @click="preferences.setSource('auto')"
            >
              自动选择<small>优先逐字歌词，自动补充译文</small>
            </button>
            <button
              class="refresh-button"
              type="button"
              :disabled="refreshing"
              aria-label="刷新本曲歌词"
              title="刷新本曲歌词"
              @click="refresh"
            >
              <RefreshCw :size="15" :class="{ spinning: refreshing }" aria-hidden="true" />
            </button>
          </div>
          <SongInfoValue
            class="choices-state"
            :loading="loading"
            :value-key="choices.map((choice) => choice.source).join(',')"
            loading-label="正在查找可用歌词来源"
            :style="{ '--source-list-height': `${sourceListHeight}px` }"
          >
            <span class="source-results">
              <span
                v-for="choice in choices"
                :key="choice.source"
                class="source-option"
                :class="{ selected: preferences.selection.value === choice.source }"
              >
                <button
                  class="source-choice"
                  :aria-pressed="preferences.selection.value === choice.source"
                  @click="preferences.setSource(choice.source)"
                >
                  {{ names[choice.source] }}
                  <small
                    >{{
                      choice.lines.some((line) => line.words?.length) ? '逐字时间轴' : '逐行时间轴'
                    }}
                    · {{ choice.lines.length }} 行</small
                  >
                </button>
                <button
                  class="preview-button"
                  :aria-pressed="previewSource === choice.source"
                  @click="previewSource = choice.source"
                >
                  预览
                </button>
              </span>
              <span v-if="!choices.length" class="source-message">
                暂未找到可选歌词，可刷新重试。
              </span>
            </span>
          </SongInfoValue>
          <SongInfoValue class="preview-state" :loading="loading" :value-key="previewSource ?? ''">
            <span
              class="source-preview"
              :aria-label="preview ? `${names[preview.source]}预览` : '歌词预览'"
            >
              <span
                v-for="(line, index) in preview?.lines.slice(0, 3) ?? []"
                :key="index"
                :title="line.text"
                >{{ line.text }}</span
              >
              <span v-if="!preview" class="source-message">暂无歌词预览</span>
            </span>
          </SongInfoValue>
          <p class="source-message">自动保存选择，来源不可用时自动回退。</p>
        </div>
      </Collapse>
      <p v-if="fallback" class="source-message" role="status">
        已选来源暂不可用，目前使用{{ names[preferences.resolvedSource.value!] }}。
      </p>
      <p v-if="failed" class="source-message" role="status">歌词刷新失败，请稍后重试。</p>
    </div>
    <div class="lyrics-offset-section">
      <div class="offset-heading">
        <strong>时间校准</strong>
        <div class="offset-controls" role="group" aria-label="本曲歌词时间校准">
          <button
            type="button"
            :disabled="!preferences.resolvedSource.value"
            aria-label="歌词提前 0.1 秒"
            title="提前 0.1 秒"
            @click="adjustOffset(-100)"
          >
            <Minus :size="16" aria-hidden="true" />
          </button>
          <button
            class="offset-value"
            type="button"
            :disabled="!preferences.resolvedSource.value || preferences.offsetMs.value === 0"
            aria-label="重置本曲歌词时间"
            :aria-describedby="`${sectionId}-offset`"
            :title="`${offsetLabel}，点击重置`"
            @click="preferences.setOffset(0)"
          >
            <output
              :id="`${sectionId}-offset`"
              :aria-label="offsetLabel"
              aria-live="polite"
              aria-atomic="true"
              >{{ offsetValue }}<span class="offset-unit">秒</span></output
            >
          </button>
          <button
            type="button"
            :disabled="!preferences.resolvedSource.value"
            aria-label="歌词延后 0.1 秒"
            title="延后 0.1 秒"
            @click="adjustOffset(100)"
          >
            <Plus :size="16" aria-hidden="true" />
          </button>
        </div>
      </div>
      <p class="source-message">每次 0.1 秒 · 点数值重置</p>
      <LyricsTimingCalibration
        :context="calibration"
        :get-playback-state="getPlaybackState"
        :playing="isPlaying"
        :offset-ms="preferences.offsetMs.value"
        :on-apply="preferences.setOffset"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
  .song-lyrics-settings {
    display: grid;
    min-width: 0;
    gap: 14px;
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }
  .lyrics-source-section,
  .lyrics-offset-section {
    min-width: 0;
  }
  .lyrics-offset-section {
    display: grid;
    gap: 10px;
    padding-top: 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }
  .source-heading,
  .source-auto-row,
  .source-option,
  .offset-heading {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 10px;
  }
  .source-heading,
  .offset-heading {
    justify-content: space-between;
  }
  .source-heading > strong,
  .offset-heading > strong {
    flex: 0 0 auto;
  }
  .offset-heading {
    flex-wrap: wrap;
    gap: 6px 8px;
  }
  button {
    min-width: 0;
    min-height: 44px;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 12px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.035);
    color: rgba(255, 255, 255, 0.82);
    font: inherit;
    font-size: 0.72rem;
    line-height: 1.4;
    cursor: pointer;
    transition:
      background 220ms cubic-bezier(0.16, 1, 0.3, 1),
      border-color 220ms cubic-bezier(0.16, 1, 0.3, 1),
      color 220ms cubic-bezier(0.16, 1, 0.3, 1),
      transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    color: #fff;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.65);
    outline-offset: -2px;
  }
  button[aria-pressed='true'] {
    border-color: rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.075);
    color: #fff;
  }
  .source-toggle {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-muted);
    text-align: right;
  }
  .source-toggle:hover:not(:disabled) {
    background: none;
  }
  .source-choice {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
  }
  .source-toggle > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  strong {
    color: #fff;
    font-size: 0.8rem;
    font-weight: 560;
  }
  small,
  .source-message,
  output {
    color: var(--text-subtle);
    font-size: 0.66rem;
    line-height: 1.5;
  }
  .source-message {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .lyrics-source-section > .source-message {
    margin-top: 10px;
  }
  .source-toggle svg {
    flex: none;
    color: rgba(255, 255, 255, 0.45);
    transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
    transform: rotate(0);
  }
  .source-toggle svg.collapsed {
    transform: rotate(-90deg);
  }
  .refresh-button {
    display: grid;
    flex: 0 0 44px;
    place-items: center;
    padding: 0;
    border-color: transparent;
    background: transparent;
    color: rgba(255, 255, 255, 0.48);
  }
  .source-options {
    display: grid;
    min-width: 0;
    gap: 10px;
    padding-top: 12px;
  }
  .choices-state {
    --song-info-placeholder-width: 100%;
    --song-info-placeholder-height: calc(var(--source-list-height) - 4px);
    height: var(--source-list-height);
    align-items: start;
    overflow: hidden;
    transition: height 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .source-results {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
    max-height: var(--source-list-height);
    overflow-y: auto;
    white-space: normal;
    scrollbar-width: thin;
  }
  .source-option {
    flex: 0 0 auto;
    min-height: 64px;
    gap: 4px;
    padding-right: 4px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 12px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.025);
    transition:
      border-color 180ms ease,
      background 180ms ease;
  }
  .source-option.selected {
    border-color: rgba(255, 255, 255, 0.25);
    background: rgba(255, 255, 255, 0.075);
  }
  .source-choice {
    flex: 1;
    justify-content: center;
    text-align: left;
    overflow-wrap: anywhere;
  }
  .source-option .source-choice {
    align-self: stretch;
    border: 0;
    background: transparent;
  }
  .preview-button {
    flex: 0 0 auto;
    padding-inline: 9px;
    border-color: transparent;
    background: transparent;
    color: rgba(255, 255, 255, 0.5);
    font-size: 0.66rem;
  }
  .preview-button[aria-pressed='true'] {
    border-color: transparent;
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.86);
  }
  .preview-state {
    --song-info-placeholder-width: 100%;
    --song-info-placeholder-height: 84px;
    block-size: 84px;
  }
  .source-preview {
    display: flex;
    min-width: 0;
    min-height: 84px;
    flex-direction: column;
    justify-content: center;
    padding: 12px;
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.1);
    color: rgba(255, 255, 255, 0.68);
    font-size: 0.72rem;
    line-height: 1.65;
  }
  .source-preview > span {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .offset-controls {
    display: inline-grid;
    flex: 0 0 auto;
    min-width: 0;
    grid-template-columns: 44px 68px 44px;
    margin-left: auto;
    border: 1px solid rgba(255, 255, 255, 0.07);
    border-radius: 14px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.035);
  }
  .offset-controls button {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 13px;
    background: transparent;
  }
  .offset-controls button:not(:disabled):active {
    transform: scale(0.94);
  }
  .offset-controls .offset-value {
    color: var(--text);
  }
  .offset-controls .offset-value:disabled {
    opacity: 1;
    color: var(--text-muted);
  }
  .offset-value output {
    color: inherit;
    font-size: 0.76rem;
    font-weight: 550;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .offset-unit {
    margin-left: 4px;
    color: var(--text-subtle);
    font-size: 0.62rem;
    font-weight: 400;
  }
  .spinning {
    animation: lyrics-refresh 1s linear infinite;
  }
  @keyframes lyrics-refresh {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 720px) {
    .song-lyrics-settings {
      padding: 13px 12px;
      gap: 12px;
    }
    .lyrics-offset-section {
      padding-top: 12px;
    }
    strong {
      font-size: 0.76rem;
    }
    small,
    .source-message,
    output {
      font-size: 0.62rem;
    }
  }
  @media (max-width: 360px), (max-height: 700px) and (max-width: 720px) {
    .song-lyrics-settings {
      padding: 11px 10px;
    }
    .source-heading {
      gap: 6px;
    }
    .source-choice {
      padding-inline: 9px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :deep(.collapse-wrapper),
    :deep(.collapse-body),
    .choices-state,
    .source-option,
    button,
    .source-toggle svg {
      transition: none;
    }
    .spinning {
      animation: none;
    }
    .offset-controls button:not(:disabled):active {
      transform: none;
    }
  }
  @media (prefers-contrast: more) {
    .offset-controls {
      border-color: var(--text-muted);
    }
    .source-toggle,
    .source-toggle svg,
    .offset-controls .offset-value:disabled,
    .offset-unit {
      color: var(--text);
    }
  }
</style>
