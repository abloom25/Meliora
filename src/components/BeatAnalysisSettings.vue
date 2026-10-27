<script setup lang="ts">
  import { Check, Download, LoaderCircle, RotateCcw, Trash2, X } from '@lucide/vue'
  import { computed, onMounted, ref, watch } from 'vue'
  import { BEAT_THIS_MODELS } from '../core/analysis/beat-this-models'
  import { continuousBeatCoverage } from '../core/analysis/beat-scheduling'
  import type {
    BeatBuildStatus,
    BeatPreloadStatus,
    BeatTimeRange,
  } from '../core/analysis/beat-timeline'
  import type { BeatAnalysisMode } from '../core/types'
  import { useBeatThisModels } from '../platform/web/useBeatThisModels'
  import { usePlayerStore } from '../stores/player'

  const props = defineProps<{ status?: BeatBuildStatus }>()
  const emit = defineEmits<{ retry: [] }>()
  const store = usePlayerStore()
  const models = useBeatThisModels()
  const selectedMode = ref<BeatAnalysisMode>(store.settings.beatAnalysisMode)
  const modeOptions = [
    { value: 'basic', label: '基础模式' },
    { value: 'beat-this-small', label: 'Small' },
    { value: 'beat-this-standard', label: '标准版' },
  ] as const
  const selectedModeIndex = computed(() =>
    modeOptions.findIndex((option) => option.value === selectedMode.value),
  )
  const modelDetailsRef = ref<HTMLElement | null>(null)

  function holdModelDetailsHeight(element: Element): void {
    const container = modelDetailsRef.value
    if (container) container.style.height = `${container.getBoundingClientRect().height}px`
    // Outgoing controls must not activate against the newly selected model during the fade.
    if (element instanceof HTMLElement) element.inert = true
  }

  function resizeModelDetails(element: Element): void {
    const container = modelDetailsRef.value
    if (container) container.style.height = `${element.getBoundingClientRect().height}px`
  }

  function releaseModelDetailsHeight(): void {
    modelDetailsRef.value?.style.removeProperty('height')
  }
  const activeModeLabel = computed(
    () => modeOptions.find((option) => option.value === store.settings.beatAnalysisMode)?.label,
  )
  const selectedModelId = computed(() => {
    if (selectedMode.value === 'beat-this-small') return 'small'
    if (selectedMode.value === 'beat-this-standard') return 'standard'
    return null
  })
  const selectedModel = computed(() =>
    selectedModelId.value ? BEAT_THIS_MODELS[selectedModelId.value] : null,
  )
  const modelState = computed(() =>
    selectedModelId.value ? models.status.value[selectedModelId.value] : null,
  )
  const modelProgress = computed(() =>
    Math.round(Math.max(0, Math.min(1, modelState.value?.progress ?? 0)) * 100),
  )
  const selectedIsActive = computed(() => selectedMode.value === store.settings.beatAnalysisMode)
  const usesModel = computed(() => store.settings.beatAnalysisMode !== 'basic')
  const modelSize = computed(() =>
    selectedModel.value ? `${(selectedModel.value.downloadBytes / 1_000_000).toFixed(1)} MB` : '',
  )
  const runtimeSize = `${(models.runtimeBytes / 1_000_000).toFixed(1)} MB`
  const anotherDownload = computed(() =>
    (['small', 'standard'] as const).some(
      (id) => id !== selectedModelId.value && models.status.value[id].phase === 'downloading',
    ),
  )
  const modelStatusLabel = computed(() => {
    switch (modelState.value?.phase) {
      case 'checking':
        return '正在检查本机模型'
      case 'downloading':
        return `正在下载模型 · ${modelProgress.value}%`
      case 'removing':
        return '正在删除本机模型'
      case 'ready':
        return selectedIsActive.value ? '已启用 · 模型已保存在本机' : '已下载 · 可启用'
      case 'error':
        return modelState.value.error ?? '模型下载失败，请重试'
      default:
        return modelProgress.value > 0
          ? `已保留下载 · ${modelProgress.value}% · 可继续`
          : '尚未下载 · 点击下载后保存在本机'
    }
  })
  watch(
    () => store.settings.beatAnalysisMode,
    (mode) => (selectedMode.value = mode),
  )
  onMounted(() => void models.initialize())

  function selectMode(mode: BeatAnalysisMode): void {
    selectedMode.value = mode
    if (mode === 'basic' || modelState.value?.phase === 'ready') {
      store.settings.beatAnalysisMode = mode
    }
  }

  function downloadModel(): void {
    const id = selectedModelId.value
    if (id) void models.download(id)
  }

  function cancelDownload(): void {
    const id = selectedModelId.value
    if (id) models.cancel(id)
  }

  function enableModel(): void {
    if (modelState.value?.phase === 'ready') store.settings.beatAnalysisMode = selectedMode.value
  }

  function removeModel(): void {
    const id = selectedModelId.value
    if (!id) return
    if (selectedIsActive.value) store.settings.beatAnalysisMode = 'basic'
    void models.remove(id)
  }

  const state = computed<BeatBuildStatus>(
    () => props.status ?? { phase: 'idle', progress: 0, error: null },
  )
  const busy = computed(() =>
    ['fetching', 'decoding', 'loading-model', 'analysing'].includes(state.value.phase),
  )
  const indeterminate = computed(() =>
    ['fetching', 'decoding', 'loading-model'].includes(state.value.phase),
  )
  function finiteSeconds(value: number | undefined): number {
    return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0
  }
  const durationSeconds = computed(() => finiteSeconds(state.value.durationSeconds))
  function clipRange(range: BeatTimeRange): BeatTimeRange | null {
    if (!Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds)) return null
    const startSeconds = Math.max(0, Math.min(durationSeconds.value, range.startSeconds))
    const endSeconds = Math.max(0, Math.min(durationSeconds.value, range.endSeconds))
    return endSeconds > startSeconds ? { startSeconds, endSeconds } : null
  }
  const completedRanges = computed(() => {
    const ranges =
      state.value.completedRanges ??
      (state.value.phase === 'ready'
        ? [{ startSeconds: 0, endSeconds: durationSeconds.value }]
        : [])
    const sorted = ranges
      .map(clipRange)
      .filter((range): range is BeatTimeRange => range !== null)
      .sort((left, right) => left.startSeconds - right.startSeconds)
    const merged: BeatTimeRange[] = []
    for (const range of sorted) {
      const previous = merged.at(-1)
      if (previous && range.startSeconds <= previous.endSeconds)
        previous.endSeconds = Math.max(previous.endSeconds, range.endSeconds)
      else merged.push({ ...range })
    }
    return merged
  })
  const availableSeconds = computed(() => {
    const measured =
      state.value.completedRanges !== undefined
        ? completedRanges.value.reduce(
            (total, range) => total + range.endSeconds - range.startSeconds,
            0,
          )
        : (state.value.availableSeconds ??
          completedRanges.value.reduce(
            (total, range) => total + range.endSeconds - range.startSeconds,
            0,
          ))
    return Math.min(durationSeconds.value || Infinity, finiteSeconds(measured))
  })
  const showTimeline = computed(
    () =>
      durationSeconds.value > 0 &&
      (['analysing', 'buffered', 'ready', 'error'].includes(state.value.phase) ||
        completedRanges.value.length > 0),
  )
  const progress = computed(() =>
    Math.round(
      Math.max(
        0,
        Math.min(
          1,
          showTimeline.value
            ? availableSeconds.value / durationSeconds.value
            : state.value.progress,
        ),
      ) * 100,
    ),
  )
  const activeRange = computed(() =>
    state.value.phase === 'analysing' && state.value.activeRange
      ? clipRange(state.value.activeRange)
      : null,
  )
  const playbackSeconds = computed(() =>
    Math.min(
      durationSeconds.value,
      finiteSeconds(
        store.currentTrack ? store.currentTime : (state.value.playbackSeconds ?? store.currentTime),
      ),
    ),
  )
  const playbackPercent = computed(() =>
    durationSeconds.value > 0 ? (playbackSeconds.value / durationSeconds.value) * 100 : 0,
  )
  const continuousSeconds = computed(() =>
    continuousBeatCoverage(completedRanges.value, playbackSeconds.value, durationSeconds.value),
  )
  const positionLabel = computed(() => {
    if (playbackSeconds.value >= durationSeconds.value) return '已到歌曲结尾'
    if (continuousSeconds.value > 0) {
      const duration =
        continuousSeconds.value < 1 ? '不足 1 秒' : formatAnalysisTime(continuousSeconds.value)
      return `当前位置${usesModel.value ? '模型结果' : ''}已就绪 · 可连续高亮 ${duration}`
    }
    if (activeRange.value) {
      if (activeRange.value.startSeconds > playbackSeconds.value) return '正在提前准备后续区间'
      if (playbackSeconds.value < activeRange.value.endSeconds) return '正在优先准备当前位置'
    }
    return usesModel.value ? '当前位置模型结果尚未就绪' : '当前位置尚未就绪'
  })
  function rangeStyle(range: BeatTimeRange): { left: string; width: string } {
    return {
      left: `${(range.startSeconds / durationSeconds.value) * 100}%`,
      width: `${((range.endSeconds - range.startSeconds) / durationSeconds.value) * 100}%`,
    }
  }
  function formatAnalysisTime(seconds: number): string {
    const total = Math.floor(seconds)
    return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`
  }
  const timelineDescription = computed(() => {
    const completed = completedRanges.value
      .map(
        (range) =>
          `${formatAnalysisTime(range.startSeconds)} 至 ${formatAnalysisTime(range.endSeconds)}`,
      )
      .join('、')
    const active = activeRange.value
      ? `；正在分析 ${formatAnalysisTime(activeRange.value.startSeconds)} 至 ${formatAnalysisTime(activeRange.value.endSeconds)}`
      : ''
    const coverage = usesModel.value ? '正式模型区间' : '可高亮区间'
    return `已完成 ${progress.value}%${completed ? `；${coverage} ${completed}` : `；尚无${coverage}`}${active}；播放位置 ${formatAnalysisTime(playbackSeconds.value)}`
  })
  const statusLabel = computed(() => {
    switch (state.value.phase) {
      case 'fetching':
        return '正在读取整首音频'
      case 'decoding':
        return '正在解码音频'
      case 'loading-model':
        return '正在加载本机模型'
      case 'analysing':
        if (durationSeconds.value > 0)
          return `已完成 ${formatAnalysisTime(availableSeconds.value)} / ${formatAnalysisTime(durationSeconds.value)} · ${progress.value}%`
        return `正在构建节奏 · ${progress.value}%`
      case 'buffered':
        if (durationSeconds.value > 0)
          return `已缓冲 ${formatAnalysisTime(availableSeconds.value)} / ${formatAnalysisTime(durationSeconds.value)} · ${progress.value}%`
        return '已缓冲 · 随播放自动续建'
      case 'ready':
        return '预分析已完成 · 高亮跟随播放位置'
      case 'error':
        return '本曲预分析未完成'
      default:
        return '等待播放后预分析'
    }
  })
  const detailLabel = computed(() => {
    if (state.value.error) return state.value.error
    if (state.value.phase === 'ready') return '拖动进度或切换闪烁频率，无需重新分析'
    if (state.value.phase === 'buffered')
      return store.isPlaying ? '接近已准备区间末端时自动续建' : '已保留分析结果，继续播放后按需续建'
    if (state.value.phase === 'analysing')
      return usesModel.value
        ? '已算好的基础结果会先用于高亮，模型完成后接管；进度仅统计模型结果'
        : '根据播放位置与分析速度，优先准备即将播放的部分'
    if (busy.value) return '正在准备音频，当前位置就绪后开始高亮'
    return '播放后优先分析当前位置，分段就绪即开始高亮'
  })
  function preloadLabel(target: BeatPreloadStatus): string {
    if (target.phase === 'ready') return '已就绪'
    if (target.phase === 'error') return '暂不可用'
    const duration = finiteSeconds(target.durationSeconds)
    const available = Math.min(duration || Infinity, finiteSeconds(target.availableSeconds))
    if (target.phase === 'buffered') {
      const prefix =
        target.completedRanges !== undefined
          ? continuousBeatCoverage(target.completedRanges, 0, duration)
          : available
      if (prefix > 0)
        return prefix < 1 ? '开头已备好不足1秒' : `开头已备好 ${formatAnalysisTime(prefix)}`
      return available > 0 ? '已保留部分结果' : '等待预分析'
    }
    if (available > 0)
      return available < 1 ? '已备好不足1秒' : `已备好 ${formatAnalysisTime(available)}`
    if (target.phase === 'idle') return '等待预分析'
    if (target.phase === 'analysing' && Number.isFinite(target.progress) && target.progress > 0)
      return `正在准备 · ${Math.round(Math.min(1, target.progress) * 100)}%`
    return '正在准备'
  }
  const adjacent = computed(() => {
    if (!store.settings.preloadNextTrack) return []
    // Playback order is independent of the background queue (which prepares next first).
    return (['previous', 'next'] as const).flatMap((direction) => {
      const target = state.value.adjacent?.find((entry) => entry.direction === direction)
      if (!target) return []
      const label = preloadLabel(target)
      return [
        {
          direction,
          directionLabel: direction === 'previous' ? '上一首' : '下一首',
          title: target.title.trim() || '未命名歌曲',
          label,
          detail: target.phase === 'error' && target.error ? `${label}；${target.error}` : label,
          busy: ['loading-model', 'fetching', 'decoding', 'analysing'].includes(target.phase),
          ready: target.phase === 'ready',
          failed: target.phase === 'error',
        },
      ]
    })
  })
</script>

<template>
  <div class="beat-analysis-settings">
    <div class="beat-analysis-heading">
      <strong>节奏识别</strong>
      <span class="beat-analysis-size">当前：{{ activeModeLabel }}</span>
    </div>
    <div class="beat-analysis-modes" role="group" aria-label="节奏识别模式">
      <button
        v-for="option in modeOptions"
        :key="option.value"
        type="button"
        :data-mode="option.value"
        :aria-pressed="selectedMode === option.value"
        @click="selectMode(option.value)"
      >
        {{ option.label }}
      </button>
      <span
        class="beat-mode-indicator"
        :style="{ transform: `translateX(calc(${selectedModeIndex} * (100% + 4px)))` }"
        aria-hidden="true"
      />
    </div>
    <div ref="modelDetailsRef" class="beat-model-details">
      <Transition
        name="beat-model-switch"
        mode="out-in"
        @before-leave="holdModelDetailsHeight"
        @enter="resizeModelDetails"
        @after-enter="releaseModelDetailsHeight"
        @enter-cancelled="holdModelDetailsHeight"
      >
        <div :key="selectedMode" class="beat-mode-detail">
          <div v-if="selectedModel && modelState" class="beat-model-card">
            <div class="beat-analysis-heading">
              <strong>{{ selectedModel.label }}</strong>
              <span class="beat-analysis-size">下载 {{ modelSize }}</span>
            </div>
            <p class="beat-analysis-detail">
              {{
                selectedModelId === 'small' ? '轻量模型，优先推荐' : '更完整的模型，分析更耗时'
              }}；结合原有算法控制高亮强弱。
            </p>
            <p class="beat-analysis-detail">
              首次下载另需 {{ runtimeSize }} 运行组件，两个模型共用。
            </p>
            <p class="beat-analysis-status beat-model-status" role="status" aria-live="polite">
              <LoaderCircle
                v-if="['checking', 'downloading', 'removing'].includes(modelState.phase)"
                class="beat-analysis-spinner"
                :size="13"
                aria-hidden="true"
              />
              <span>{{ modelStatusLabel }}</span>
            </p>
            <div class="beat-model-controls">
              <div
                v-if="modelState.phase === 'downloading'"
                class="beat-analysis-progress beat-model-progress"
                role="progressbar"
                aria-label="模型下载进度"
                :aria-valuenow="modelProgress"
                :aria-valuemin="0"
                :aria-valuemax="100"
              >
                <span :style="{ width: `${modelProgress}%` }" />
              </div>
              <div class="beat-analysis-actions">
                <button
                  v-if="modelState.phase === 'missing' || modelState.phase === 'error'"
                  class="beat-analysis-action"
                  type="button"
                  :disabled="anotherDownload"
                  @click="downloadModel"
                >
                  <Download :size="14" aria-hidden="true" />
                  {{
                    modelProgress > 0
                      ? '继续下载'
                      : modelState.phase === 'error'
                        ? '重试下载'
                        : '下载模型'
                  }}
                </button>
                <button
                  v-if="modelState.phase === 'downloading'"
                  class="beat-analysis-action"
                  type="button"
                  @click="cancelDownload"
                >
                  <X :size="14" aria-hidden="true" />取消下载
                </button>
                <template
                  v-if="
                    modelState.phase === 'ready' ||
                    modelState.phase === 'error' ||
                    (modelState.phase === 'missing' && modelProgress > 0)
                  "
                >
                  <button
                    v-if="modelState.phase === 'ready' && !selectedIsActive"
                    class="beat-analysis-action"
                    type="button"
                    @click="enableModel"
                  >
                    <Check :size="14" aria-hidden="true" />启用模型
                  </button>
                  <button class="beat-analysis-action" type="button" @click="removeModel">
                    <Trash2 :size="14" aria-hidden="true" />删除模型
                  </button>
                </template>
              </div>
            </div>
            <p v-if="!selectedIsActive" class="beat-analysis-detail">
              {{
                anotherDownload
                  ? '另一个模型正在下载，可切换回该模型取消。'
                  : '下载完成后点击启用；当前模式保持不变。'
              }}
            </p>
          </div>
          <p v-else class="beat-analysis-detail beat-basic-detail">
            无需下载模型，使用原有节奏算法。
          </p>
        </div>
      </Transition>
    </div>
    <div class="beat-analysis-feedback" :aria-busy="busy">
      <p class="beat-analysis-status" role="status" aria-live="polite" aria-atomic="true">
        <LoaderCircle v-if="busy" class="beat-analysis-spinner" :size="13" aria-hidden="true" />
        <span>{{ statusLabel }}</span>
      </p>
      <div class="beat-analysis-position-slot">
        <p v-if="showTimeline" class="beat-analysis-position" aria-live="off">
          {{ positionLabel }}
        </p>
      </div>
      <p class="beat-analysis-detail">{{ detailLabel }}</p>
      <div class="beat-analysis-progress-slot">
        <div
          v-if="showTimeline"
          class="beat-analysis-timeline"
          role="progressbar"
          aria-label="节奏分析完成度"
          :aria-valuenow="progress"
          :aria-valuemin="0"
          :aria-valuemax="100"
          :aria-valuetext="timelineDescription"
        >
          <div class="beat-analysis-timeline-rail" aria-hidden="true">
            <span
              v-for="range in completedRanges"
              :key="range.startSeconds"
              class="beat-analysis-completed-range"
              :style="rangeStyle(range)"
            />
            <span
              v-if="activeRange"
              class="beat-analysis-active-range"
              :style="rangeStyle(activeRange)"
            />
          </div>
          <span
            class="beat-analysis-playhead"
            :style="{ left: `${playbackPercent}%` }"
            aria-hidden="true"
          />
        </div>
        <div
          v-else-if="busy"
          class="beat-analysis-progress"
          :class="{ indeterminate }"
          role="progressbar"
          :aria-label="statusLabel"
          :aria-valuenow="indeterminate ? undefined : progress"
          :aria-valuemin="0"
          :aria-valuemax="100"
        >
          <span :style="{ width: `${progress}%` }" />
        </div>
        <div v-if="showTimeline" class="beat-analysis-legend" aria-hidden="true">
          <span><i class="legend-completed" />已完成</span>
          <span><i class="legend-active" />分析中</span>
          <span><i class="legend-playhead" />播放位置</span>
        </div>
      </div>
    </div>
    <div v-if="state.phase === 'error'" class="beat-analysis-actions">
      <button class="beat-analysis-action" type="button" @click="emit('retry')">
        <RotateCcw :size="14" aria-hidden="true" />重新分析
      </button>
    </div>
    <Transition name="beat-preload">
      <ul
        v-if="adjacent.length"
        class="beat-preload-list"
        role="list"
        aria-label="相邻歌曲节奏预分析"
        aria-live="off"
      >
        <li
          v-for="target in adjacent"
          :key="target.direction"
          class="beat-preload-row"
          :aria-label="`${target.directionLabel}：${target.title}，${target.detail}`"
        >
          <span class="beat-preload-direction">{{ target.directionLabel }}</span>
          <span class="beat-preload-title" :title="target.title">{{ target.title }}</span>
          <span class="beat-preload-status" :title="target.detail" :aria-busy="target.busy">
            <span class="beat-preload-indicator" aria-hidden="true">
              <LoaderCircle v-if="target.busy" class="beat-analysis-spinner" :size="12" />
              <Check v-else-if="target.ready" :size="12" />
              <X v-else-if="target.failed" :size="12" />
            </span>
            <span class="beat-preload-label">{{ target.label }}</span>
          </span>
        </li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
  .beat-analysis-settings {
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }
  .beat-analysis-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 12px;
  }
  .beat-analysis-heading strong {
    color: var(--text-primary, rgba(255, 255, 255, 0.94));
    font-size: 0.8rem;
    font-weight: 560;
  }
  .beat-analysis-size {
    color: var(--text-subtle);
    font-size: 0.62rem;
    font-variant-numeric: tabular-nums;
    text-decoration: none;
  }
  .beat-analysis-modes {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 4px;
    margin-top: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  }
  .beat-analysis-modes button,
  .beat-analysis-action {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    gap: 5px;
    min-block-size: 32px;
    padding: 6px 9px;
    border: 1px solid transparent;
    border-radius: 9px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.68rem;
    cursor: pointer;
    transition:
      background 220ms cubic-bezier(0.16, 1, 0.3, 1),
      color 220ms cubic-bezier(0.16, 1, 0.3, 1),
      border-color 220ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .beat-analysis-modes button {
    position: relative;
    min-width: 0;
    min-block-size: 44px;
    padding: 10px 4px 13px;
    border: 0;
    border-radius: 0;
    color: var(--text-subtle);
    font-size: 0.77rem;
    font-weight: 550;
    white-space: nowrap;
    transition: color 220ms cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      color: var(--text-muted);
    }
    &[aria-pressed='true'] {
      color: var(--text);
    }
  }
  .beat-mode-indicator {
    position: absolute;
    inset: auto auto 0 0;
    width: calc((100% - 8px) / 3);
    height: 2px;
    color: var(--text);
    font-size: 0.77rem;
    pointer-events: none;
    transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1);

    &::after {
      content: '';
      position: absolute;
      inset: 0 auto 0 calc(50% - 0.65em);
      width: 1.3em;
      border-radius: 2px;
      background: currentColor;
      opacity: 0.9;
    }
  }
  .beat-model-details {
    overflow: clip;
    transition: height 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .beat-mode-detail {
    display: flow-root;
  }
  .beat-model-switch-enter-active,
  .beat-model-switch-leave-active {
    transition:
      opacity 240ms cubic-bezier(0.16, 1, 0.3, 1),
      filter 240ms cubic-bezier(0.16, 1, 0.3, 1),
      transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .beat-model-switch-leave-active {
    transition-duration: 180ms;
    pointer-events: none;
  }
  .beat-model-switch-enter-from,
  .beat-model-switch-leave-to {
    opacity: 0;
    filter: blur(3px);
  }
  .beat-model-switch-enter-from {
    transform: translateY(6px);
  }
  .beat-model-switch-leave-to {
    transform: translateY(-4px);
  }
  .beat-model-card {
    margin-top: 12px;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.025);
  }
  .beat-model-card .beat-analysis-heading strong {
    font-size: 0.72rem;
  }
  .beat-model-status {
    margin-top: 8px !important;
    min-block-size: 2.1em;
  }
  .beat-model-controls {
    position: relative;
    padding-top: 4px;
  }
  .beat-model-progress {
    position: absolute;
    inset: 0 0 auto;
    block-size: 4px !important;
  }
  .beat-basic-detail {
    margin-top: 10px !important;
  }
  .beat-analysis-modes button:disabled,
  .beat-analysis-action:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .beat-analysis-action:not(:disabled):hover {
    background: rgba(255, 255, 255, 0.15);
  }
  .beat-analysis-modes button:focus-visible,
  .beat-analysis-action:focus-visible {
    outline: 2px solid currentColor;
    outline-offset: 2px;
  }
  .beat-analysis-modes button:focus-visible {
    outline-offset: -3px;
    border-radius: 6px;
  }
  .beat-analysis-feedback {
    margin-top: 12px;
    min-block-size: 3.4rem;
  }
  .beat-analysis-status,
  .beat-analysis-position,
  .beat-analysis-detail {
    margin: 0;
    font-size: 0.64rem;
    line-height: 1.6;
  }
  .beat-analysis-position-slot {
    min-block-size: 1.2rem;
    display: flex;
    align-items: center;
  }
  .beat-analysis-position {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .beat-analysis-status {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--text-muted);
  }
  .beat-analysis-status svg {
    flex-shrink: 0;
  }
  .beat-analysis-detail {
    margin-top: 3px;
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .beat-analysis-progress-slot {
    block-size: 30px;
    margin-top: 8px;
  }
  .beat-analysis-progress-slot > .beat-analysis-progress {
    block-size: 4px;
    margin-top: 4px;
  }
  .beat-analysis-timeline {
    position: relative;
    block-size: 12px;
  }
  .beat-analysis-timeline-rail {
    position: absolute;
    inset: 4px 0;
    overflow: hidden;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.1);
  }
  .beat-analysis-timeline-rail > span {
    position: absolute;
    block-size: 100%;
    border-radius: inherit;
  }
  .beat-analysis-completed-range {
    background: rgba(255, 255, 255, 0.72);
    animation: beat-range-reveal 220ms ease-out both;
    transition: width 220ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .beat-analysis-active-range,
  .legend-active {
    background: repeating-linear-gradient(
      110deg,
      rgba(255, 255, 255, 0.32) 0 4px,
      transparent 4px 8px
    );
  }
  .beat-analysis-active-range {
    animation: beat-range-pulse 1.4s ease-in-out infinite alternate;
  }
  .beat-analysis-playhead {
    position: absolute;
    inset-block: 1px;
    inline-size: 2px;
    border-radius: 1px;
    background: rgba(255, 255, 255, 0.95);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.24);
    transform: translateX(-50%);
    transition: left 120ms linear;
  }
  .beat-analysis-legend {
    display: flex;
    align-items: center;
    gap: 12px;
    block-size: 18px;
    color: var(--text-subtle);
    font-size: 0.58rem;
    line-height: 1;
  }
  .beat-analysis-legend span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .beat-analysis-legend i {
    display: inline-block;
    inline-size: 10px;
    block-size: 3px;
    border-radius: 1px;
  }
  .legend-completed {
    background: rgba(255, 255, 255, 0.72);
  }
  .beat-analysis-legend .legend-playhead {
    inline-size: 2px;
    block-size: 7px;
    background: rgba(255, 255, 255, 0.95);
  }
  @keyframes beat-range-reveal {
    from {
      opacity: 0;
    }
  }
  @keyframes beat-range-pulse {
    from {
      opacity: 0.4;
    }
    to {
      opacity: 1;
    }
  }
  .beat-analysis-progress {
    overflow: hidden;
    block-size: 100%;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
  }
  .beat-analysis-progress span {
    display: block;
    block-size: 100%;
    background: rgba(255, 255, 255, 0.65);
    transition: width 220ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .beat-analysis-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    min-block-size: 32px;
    margin-top: 8px;
  }
  .beat-analysis-action {
    border-color: rgba(255, 255, 255, 0.11);
    background: rgba(255, 255, 255, 0.06);
  }
  .beat-analysis-detail a {
    color: inherit;
    text-underline-offset: 3px;
  }
  .beat-preload-list {
    margin: 10px 0 0;
    padding: 6px 0 0;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
    list-style: none;
  }
  .beat-preload-row {
    display: grid;
    grid-template-columns: 3em minmax(0, 1fr) 13.5em;
    align-items: center;
    gap: 6px;
    block-size: 1.8rem;
    color: var(--text-subtle);
    font-size: 0.62rem;
    line-height: 1.5;
  }
  .beat-preload-direction,
  .beat-preload-title,
  .beat-preload-label {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .beat-preload-title {
    color: var(--text-muted);
  }
  .beat-preload-status {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    min-inline-size: 0;
    font-variant-numeric: tabular-nums;
  }
  .beat-preload-indicator {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 12px;
    block-size: 12px;
  }
  .beat-preload-enter-active,
  .beat-preload-leave-active {
    transition: opacity 220ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .beat-preload-enter-from,
  .beat-preload-leave-to {
    opacity: 0;
  }
  .beat-analysis-progress.indeterminate span {
    width: 35% !important;
    animation: beat-analysis-progress 1.4s ease-in-out infinite alternate;
  }
  @keyframes beat-analysis-progress {
    to {
      transform: translateX(180%);
    }
  }
  .beat-analysis-spinner {
    animation: beat-analysis-spin 1.2s linear infinite;
  }
  @keyframes beat-analysis-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 720px) {
    .beat-analysis-settings {
      padding: 13px 12px;
    }
    .beat-analysis-heading strong {
      font-size: 0.76rem;
    }
  }
  @media (pointer: coarse) {
    .beat-analysis-action {
      min-block-size: 44px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .beat-model-switch-enter-from,
    .beat-model-switch-leave-to {
      filter: none;
      transform: none;
    }
    .beat-analysis-spinner,
    .beat-analysis-completed-range,
    .beat-analysis-active-range,
    .beat-analysis-progress.indeterminate span {
      animation: none;
    }
    .beat-analysis-modes button,
    .beat-mode-indicator,
    .beat-model-details,
    .beat-model-switch-enter-active,
    .beat-model-switch-leave-active,
    .beat-analysis-action,
    .beat-analysis-completed-range,
    .beat-analysis-playhead,
    .beat-analysis-progress span,
    .beat-preload-enter-active,
    .beat-preload-leave-active {
      transition: none;
    }
  }
  @media (prefers-contrast: more) {
    .beat-analysis-action {
      outline: 1px solid currentColor;
    }
    .beat-analysis-modes button {
      color: var(--text);
    }
    .beat-mode-indicator {
      height: 3px;
      opacity: 1;
    }
    .beat-analysis-status,
    .beat-analysis-position,
    .beat-analysis-detail,
    .beat-analysis-legend,
    .beat-analysis-size,
    .beat-preload-row,
    .beat-preload-title {
      color: rgba(255, 255, 255, 0.94);
    }
    .beat-analysis-timeline-rail {
      outline: 1px solid currentColor;
    }
    .beat-analysis-completed-range,
    .legend-completed {
      background: currentColor;
    }
    .beat-analysis-active-range {
      outline: 1px dashed currentColor;
      outline-offset: -1px;
    }
  }
</style>
