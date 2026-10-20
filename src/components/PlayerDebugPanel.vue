<script setup lang="ts">
  import { ChevronLeft, ChevronRight, LocateFixed, Pause, Play, X } from '@lucide/vue'
  import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
  import type { BeatComparisonSnapshot } from '../core/analysis/beat-comparison'
  import BeatComparisonSection from './BeatComparisonSection.vue'
  import {
    BEAT_DEBUG_HISTORY_MS,
    type BeatDebugSample,
    type BeatDebugSnapshot,
    type BeatHighlightReason,
    type BeatSchedulerDebug,
  } from '../core/analysis/beat-debug'
  import { continuousBeatCoverage } from '../core/analysis/beat-scheduling'
  import {
    normalizeBeatRanges,
    type BeatBuildStatus,
    type BeatTimeRange,
  } from '../core/analysis/beat-timeline'
  import type { AudioPreloadDebug } from '../core/analysis/player-debug'
  import type {
    LyricsDebugSnapshot,
    LyricsWindowDebugSnapshot,
  } from '../core/diagnostics/lyrics-debug'
  import type { RuntimeDebugSnapshot } from '../core/diagnostics/runtime-debug'
  import { formatTrackDisplayTitle } from '../core/library/tracks'
  import type { Track } from '../core/types'
  import LyricsDebugSection from './LyricsDebugSection.vue'
  import RuntimeDebugSection from './RuntimeDebugSection.vue'

  const props = defineProps<{
    beat: BeatDebugSnapshot | null
    scheduler: BeatSchedulerDebug | null
    comparison?: BeatComparisonSnapshot | null
    canCompare?: boolean
    comparisonExportSampleCount?: number
    comparisonExportTruncated?: boolean
    comparisonExporting?: boolean
    comparisonExportError?: string | null
    flashRate?: number
    build: BeatBuildStatus
    preload: readonly AudioPreloadDebug[]
    queue: readonly Track[]
    currentTrackId: string | null
    playbackSeconds: number
    durationSeconds: number
    playing: boolean
    brightness: number
    playModeText: string
    lyrics?: LyricsDebugSnapshot | null
    lyricsWindow?: LyricsWindowDebugSnapshot | null
    runtime?: RuntimeDebugSnapshot | null
    lyricsWindowSupported?: boolean
    hasCurrentTrack?: boolean
  }>()
  const emit = defineEmits<{
    close: []
    'toggle-lyrics-window': []
    'comparison-visible': [visible: boolean]
    'compare-start': []
    'compare-stop': []
    'compare-export': []
  }>()
  const tabs = [
    { id: 'beat', label: '节拍' },
    { id: 'comparison', label: '对比' },
    { id: 'preload', label: '预加载' },
    { id: 'lyrics', label: '歌词' },
    { id: 'runtime', label: '运行' },
  ] as const
  type DebugTab = (typeof tabs)[number]['id']
  const activeTab = ref<DebugTab>('beat')
  watch(activeTab, (tab) => emit('comparison-visible', tab === 'comparison'), {
    flush: 'sync',
    immediate: true,
  })
  onBeforeUnmount(() => emit('comparison-visible', false))
  const tabId = useId()
  const tabList = ref<HTMLElement | null>(null)
  async function onTabKeydown(event: KeyboardEvent, index: number): Promise<void> {
    let nextIndex: number
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    else return
    event.preventDefault()
    const nextTab = tabs[nextIndex]
    if (!nextTab) return
    activeTab.value = nextTab.id
    await nextTick()
    tabList.value?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus()
  }
  const reasonLabels: Record<BeatHighlightReason, string> = {
    ready: '当前位置可高亮',
    disabled: '节奏高亮已关闭',
    'reduced-motion': '系统已启用减少动态效果',
    hidden: '页面不可见',
    paused: '播放已暂停',
    seeking: '正在拖动播放位置',
    buffering: '音频正在缓冲',
    'audio-unavailable': '尚未取得音频',
    'context-suspended': '音频输出尚未恢复',
    'model-unavailable': '模型尚未就绪',
    'timeline-missing': '尚无节奏分析结果',
    'range-unbuilt': '当前位置尚未构建',
  }
  const phaseLabels: Record<BeatBuildStatus['phase'], string> = {
    idle: '等待预分析',
    'loading-model': '加载模型',
    fetching: '读取音频',
    decoding: '解码音频',
    analysing: '构建中',
    buffered: '已缓冲',
    ready: '整曲就绪',
    error: '暂不可用',
  }
  const roleLabels = { current: '本曲', next: '下一首', previous: '上一首', retiring: '正在收尾' }
  const slotLabels: Record<AudioPreloadDebug['phase'], string> = {
    empty: '空闲',
    loading: '正在加载',
    ready: '可播放',
    error: '加载失败',
    protected: '保留中 · 淡出或回退',
  }
  const readyLabels = ['尚无数据', '已有元数据', '已有当前帧', '可继续播放', '数据充足']
  const networkLabels = ['未初始化', '网络空闲', '正在读取', '无可用来源']
  function finite(value: number | undefined | null): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  function unit(value: number): number {
    return Math.max(0, Math.min(1, finite(value)))
  }
  function fixed(value: number | null | undefined, digits = 3): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—'
  }
  function time(value: number | undefined | null): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—'
    const seconds = Math.floor(Math.max(0, value))
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  }
  function rangeText(range: BeatTimeRange): string {
    return `${time(range.startSeconds)}–${time(range.endSeconds)}`
  }
  function rangesText(ranges: readonly BeatTimeRange[]): string {
    return ranges.length ? ranges.map(rangeText).join('、') : '无'
  }
  // Free-form diagnostic strings must not expose signed media URLs or credentials.
  function diagnosticText(value: string): string {
    return value
      .replace(/https?:\/\/\S+|(?:\/[^\s?]*)?\?[^\s]+/gi, '[地址已隐藏]')
      .replace(/\b(?:token|key|secret|signature|authorization)\s*[:=]\s*\S+/gi, '[凭据已隐藏]')
  }
  const current = computed(() => props.beat?.current)
  const timing = computed(() => current.value?.timing)
  const buildMetrics = computed(() => props.scheduler?.metrics)
  const cacheOriginLabel = computed(() => {
    switch (buildMetrics.value?.cacheOrigin) {
      case 'persistent':
        return '本地持久缓存'
      case 'memory':
        return '内存断点'
      case 'none':
        return '未命中结果缓存'
      default:
        return '未获取'
    }
  })
  const timingSourceLabel = computed(() => {
    switch (timing.value?.timelineSource) {
      case 'basic':
        return '基础分析'
      case 'provisional':
        return '临时基础高亮'
      case 'model':
        return '模型分析'
      case 'none':
        return '当前位置暂无结果'
      default:
        return '尚无时序样本'
    }
  })
  const clockSourceLabel = computed(() => {
    switch (timing.value?.clockSource) {
      case 'output-timestamp':
        return '音频输出时钟映射'
      case 'latency-fallback':
        return '设备延迟估计'
      case 'media':
        return '媒体时钟'
      default:
        return '未获取'
    }
  })
  const writeAgeMs = computed(() => {
    const writtenAt = timing.value?.lastWriteAtMs
    return current.value && typeof writtenAt === 'number' && Number.isFinite(writtenAt)
      ? Math.max(0, current.value.sampledAtMs - writtenAt)
      : null
  })
  const modeLabel = computed(() => {
    const mode = props.beat?.mode ?? props.scheduler?.mode
    return mode === 'basic'
      ? '基础模式'
      : mode === 'beat-this-small'
        ? 'Beat This! Small'
        : mode === 'beat-this-standard'
          ? 'Beat This! 标准版'
          : '模式未获取'
  })
  const outputLabel = computed(() =>
    current.value ? reasonLabels[current.value.reason] : '等待实际输出样本',
  )
  const frozenHistory = ref<readonly BeatDebugSample[] | null>(null)
  const motionPaused = ref(false)
  onMounted(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      motionPaused.value = true
      frozenHistory.value = props.beat?.history.slice() ?? []
    }
  })
  watch([() => props.beat?.source, () => props.beat?.mode], () => {
    if (frozenHistory.value !== null) frozenHistory.value = []
  })
  function toggleCurve(): void {
    frozenHistory.value = frozenHistory.value === null ? (props.beat?.history.slice() ?? []) : null
    motionPaused.value = false
  }
  const history = computed(() => {
    const samples = frozenHistory.value ?? props.beat?.history ?? []
    const lastMs = samples.at(-1)?.sampledAtMs ?? 0
    return samples
      .slice(-660)
      .filter(
        (sample) =>
          Number.isFinite(sample.sampledAtMs) &&
          sample.sampledAtMs >= lastMs - BEAT_DEBUG_HISTORY_MS,
      )
  })
  function curve(key: 'level' | 'sustain'): string {
    const lastMs = history.value.at(-1)?.sampledAtMs
    if (lastMs === undefined) return ''
    let previousMs: number | null = null
    return history.value
      .map((sample) => {
        if (!Number.isFinite(sample[key])) {
          previousMs = null
          return ''
        }
        const x = 8 + unit(1 - (lastMs - sample.sampledAtMs) / BEAT_DEBUG_HISTORY_MS) * 464
        const y = 110 - unit(sample[key]) * 96
        const command = previousMs === null || sample.sampledAtMs - previousMs > 500 ? 'M' : 'L'
        previousMs = sample.sampledAtMs
        return `${command}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }
  const levelCurve = computed(() => curve('level'))
  const sustainCurve = computed(() => curve('sustain'))
  const duration = computed(() =>
    Math.max(0, finite(props.durationSeconds) || finite(props.build.durationSeconds)),
  )
  const position = computed(() =>
    Math.max(0, Math.min(duration.value, finite(props.playbackSeconds))),
  )
  const completed = computed(() =>
    normalizeBeatRanges(
      props.build.completedRanges ??
        (props.build.phase === 'ready' ? [{ startSeconds: 0, endSeconds: duration.value }] : []),
      duration.value,
    ),
  )
  const active = computed(() =>
    props.build.phase === 'analysing' && props.build.activeRange
      ? normalizeBeatRanges([props.build.activeRange], duration.value)[0]
      : undefined,
  )
  const continuous = computed(() =>
    continuousBeatCoverage(completed.value, position.value, duration.value),
  )
  const coverageLabel = computed(() => {
    if (!duration.value) return '尚未获取时长'
    if (position.value >= duration.value) return '已到歌曲结尾'
    if (
      !completed.value.length &&
      props.build.completedRanges === undefined &&
      props.build.phase !== 'ready'
    )
      return '尚未获取已构建区间'
    return continuous.value > 0
      ? `当前位置可连续高亮 ${continuous.value < 1 ? '不足 1 秒' : time(continuous.value)}`
      : '当前位置未覆盖'
  })
  function rangeStyle(range: BeatTimeRange): { left: string; width: string } {
    return {
      left: `${duration.value ? (range.startSeconds / duration.value) * 100 : 0}%`,
      width: `${duration.value ? ((range.endSeconds - range.startSeconds) / duration.value) * 100 : 0}%`,
    }
  }
  const orderedTasks = computed(() =>
    [...(props.scheduler?.queue ?? [])].sort(
      (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity),
    ),
  )
  const orderedSlots = computed(() =>
    [...props.preload].sort(
      (a, b) => Number(a.direction === 'next') - Number(b.direction === 'next'),
    ),
  )
  const PAGE_SIZE = 40
  const page = ref(0)
  const queueElement = ref<HTMLOListElement | null>(null)
  const pageCount = computed(() => Math.max(1, Math.ceil(props.queue.length / PAGE_SIZE)))
  const currentIndex = computed(() =>
    props.currentTrackId === null
      ? -1
      : props.queue.findIndex((track) => track.id === props.currentTrackId),
  )
  const queuePage = computed(() =>
    props.queue.slice(page.value * PAGE_SIZE, (page.value + 1) * PAGE_SIZE),
  )
  watch(pageCount, (count) => {
    page.value = Math.min(page.value, count - 1)
  })
  watch(
    page,
    () => {
      if (queueElement.value) queueElement.value.scrollTop = 0
    },
    { flush: 'post' },
  )
  async function locateCurrent(): Promise<void> {
    if (currentIndex.value < 0) return
    page.value = Math.floor(currentIndex.value / PAGE_SIZE)
    await nextTick()
    queueElement.value
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' })
  }
  function trackTitle(track: Track): string {
    return formatTrackDisplayTitle(track) || '未命名歌曲'
  }
</script>

<template>
  <section class="player-debug-panel" aria-label="播放器调试信息">
    <header class="debug-header">
      <div>
        <h2>播放调试</h2>
        <p>{{ modeLabel }} · {{ playing ? '播放中' : '已暂停' }}</p>
      </div>
      <button
        type="button"
        class="debug-icon-button"
        aria-label="关闭调试面板"
        @click="emit('close')"
      >
        <X :size="18" aria-hidden="true" />
      </button>
    </header>
    <div ref="tabList" class="debug-tabs" role="tablist" aria-label="调试分类">
      <button
        v-for="(tab, index) in tabs"
        :id="`${tabId}-tab-${tab.id}`"
        :key="tab.id"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.id"
        :aria-controls="`${tabId}-panel-${tab.id}`"
        :tabindex="activeTab === tab.id ? 0 : -1"
        @click="activeTab = tab.id"
        @keydown="onTabKeydown($event, index)"
      >
        {{ tab.label }}
      </button>
    </div>
    <Transition name="debug-page" mode="out-in">
      <div
        :id="`${tabId}-panel-${activeTab}`"
        :key="activeTab"
        class="debug-scroll"
        role="tabpanel"
        :aria-labelledby="`${tabId}-tab-${activeTab}`"
        tabindex="0"
        aria-live="off"
      >
        <template v-if="activeTab === 'beat'">
          <section class="debug-section" aria-label="高亮输出">
            <div class="debug-heading">
              <h3>高亮输出</h3>
              <button
                class="debug-button"
                type="button"
                :aria-pressed="frozenHistory !== null"
                @click="toggleCurve"
              >
                <Play v-if="frozenHistory !== null" :size="12" aria-hidden="true" /><Pause
                  v-else
                  :size="12"
                  aria-hidden="true"
                />{{ frozenHistory !== null ? '恢复曲线' : '冻结曲线' }}
              </button>
            </div>
            <p class="debug-status" data-testid="output-status">{{ outputLabel }}</p>
            <div class="debug-chart">
              <svg
                viewBox="0 0 480 124"
                role="img"
                aria-label="最近 20 秒实际高亮输出，实线为瞬时电平，虚线为持续电平"
              >
                <path class="debug-chart-grid" d="M8 14H472 M8 62H472 M8 110H472" />
                <path class="debug-curve debug-level" :d="levelCurve" data-testid="level-curve" />
                <path
                  class="debug-curve debug-sustain"
                  :d="sustainCurve"
                  data-testid="sustain-curve"
                />
                <text x="10" y="11">1</text>
                <text x="10" y="107">0</text>
              </svg>
              <span v-if="!history.length" class="debug-chart-empty">{{
                frozenHistory !== null ? '曲线已冻结' : '尚无采样记录'
              }}</span>
            </div>
            <div class="debug-legend">
              <span><i class="legend-level" />瞬时 level</span
              ><span><i class="legend-sustain" />持续 sustain</span
              ><span class="debug-legend-end">{{
                frozenHistory !== null ? '曲线已冻结' : '最近 20 秒'
              }}</span>
            </div>
            <p v-if="motionPaused" class="debug-note">
              已按系统的减少动态效果设置暂停曲线，可手动恢复。
            </p>
            <dl class="debug-metrics">
              <div>
                <dt>瞬时电平</dt>
                <dd data-testid="level-value">{{ fixed(current?.level) }}</dd>
              </div>
              <div>
                <dt>持续电平</dt>
                <dd>{{ fixed(current?.sustain) }}</dd>
              </div>
              <div>
                <dt>输出补偿</dt>
                <dd>{{ fixed(current?.delayMs, 0) }}<small v-if="current"> ms</small></dd>
              </div>
              <div>
                <dt>亮度倍率</dt>
                <dd>{{ fixed(brightness, 2) }}×</dd>
              </div>
              <div>
                <dt>原始 level / sustain</dt>
                <dd>{{ fixed(current?.rawLevel) }} / {{ fixed(current?.rawSustain) }}</dd>
              </div>
              <div>
                <dt>高亮启用系数</dt>
                <dd>{{ fixed(current?.readyMix) }}</dd>
              </div>
              <div>
                <dt>播放 / 采样位置</dt>
                <dd>
                  {{ fixed(current?.playbackSeconds) }} / {{ fixed(current?.sampleSeconds) }} s
                </dd>
              </div>
              <div>
                <dt>输出允许</dt>
                <dd>{{ current ? (current.canHighlight ? '是' : '否') : '未获取' }}</dd>
              </div>
            </dl>
            <p class="debug-note">曲线为送入背景的实际值；亮度倍率由背景渲染时叠加。</p>
          </section>

          <section class="debug-section" aria-label="高亮响应时序">
            <div class="debug-heading"><h3>响应时序</h3></div>
            <p class="debug-status" data-testid="timing-source">{{ timingSourceLabel }}</p>
            <dl class="debug-details">
              <div>
                <dt>时钟来源</dt>
                <dd>{{ clockSourceLabel }}</dd>
              </div>
              <div>
                <dt>设备侧取样偏移</dt>
                <dd>{{ fixed(timing?.outputOffsetMs, 1) }} ms</dd>
              </div>
              <div>
                <dt>画面帧提前量</dt>
                <dd>{{ fixed(timing?.frameLeadMs, 1) }} ms</dd>
              </div>
              <div>
                <dt>本轮首次可用</dt>
                <dd>{{ fixed(timing?.firstAvailableMs, 0) }} ms</dd>
              </div>
              <div>
                <dt>最近写入距采样</dt>
                <dd>{{ fixed(writeAgeMs, 1) }} ms</dd>
              </div>
              <div>
                <dt>模型接管</dt>
                <dd>
                  {{
                    timing
                      ? timing.handoffPending
                        ? '等待当前脉冲结束'
                        : timing.timelineSource === 'model'
                          ? '已接管'
                          : '无切换待处理'
                      : '未获取'
                  }}
                </dd>
              </div>
            </dl>
            <p v-if="timing?.timelineSource === 'provisional'" class="debug-note">
              当前先使用已算好的基础结果；下方区间和完成度仍只统计模型正式结果。
            </p>
            <p class="debug-note">
              时钟偏移和帧提前量是同步估计；写入时间记录脚本提交高亮值，不代表屏幕实际显示时间。
              首次可用从本曲本模式启动分析起计，暂停和拖动不重计。
            </p>
          </section>

          <section v-if="buildMetrics" class="debug-section" aria-label="最近一轮构建耗时">
            <div class="debug-heading"><h3>最近一轮构建</h3></div>
            <p class="debug-status" data-testid="build-cache-origin">
              {{ cacheOriginLabel }} · {{ buildMetrics.cacheOnly ? '直接恢复结果' : '分析或续建' }}
            </p>
            <dl class="debug-details">
              <div>
                <dt>本轮总耗时</dt>
                <dd>{{ fixed(buildMetrics.totalMs, 0) }} ms</dd>
              </div>
              <div>
                <dt>缓存首次可用</dt>
                <dd>{{ fixed(buildMetrics.cacheReadyMs, 0) }} ms</dd>
              </div>
              <div>
                <dt>音频读取 / 内容校验</dt>
                <dd>
                  {{ fixed(buildMetrics.fetchMs, 0) }} / {{ fixed(buildMetrics.hashMs, 0) }} ms
                </dd>
              </div>
              <div>
                <dt>持久缓存读取</dt>
                <dd>{{ fixed(buildMetrics.cacheReadMs, 0) }} ms</dd>
              </div>
              <div>
                <dt>音频解码</dt>
                <dd>{{ fixed(buildMetrics.decodeMs, 0) }} ms</dd>
              </div>
              <div>
                <dt>模型准备 / 初始化</dt>
                <dd>
                  {{ fixed(buildMetrics.modelPreparationMs, 0) }} /
                  {{ fixed(buildMetrics.initializationMs, 0) }} ms
                </dd>
              </div>
              <div>
                <dt>模型推理</dt>
                <dd>{{ fixed(buildMetrics.inferenceMs, 0) }} ms</dd>
              </div>
              <div>
                <dt>本轮 PCM / 压缩音频</dt>
                <dd>
                  {{ fixed((buildMetrics.pcmBytes ?? 0) / 1048576, 2) }} /
                  {{ fixed((buildMetrics.encodedBytes ?? 0) / 1048576, 2) }} MiB
                </dd>
              </div>
              <div v-if="buildMetrics.featureResidentBytes !== undefined">
                <dt>本曲频谱驻留 / 峰值</dt>
                <dd>
                  {{ fixed(buildMetrics.featureResidentBytes / 1048576, 2) }} /
                  {{ fixed((buildMetrics.featurePeakResidentBytes ?? 0) / 1048576, 2) }} MiB
                </dd>
              </div>
              <div v-if="buildMetrics.featureInputBytes !== undefined">
                <dt>单窗推理输入</dt>
                <dd>{{ fixed(buildMetrics.featureInputBytes / 1048576, 2) }} MiB</dd>
              </div>
            </dl>
            <p class="debug-note">
              仅记录本曲本模式最近一轮；并行阶段耗时不能相加。缓存首次可用从本轮启动计时；0 ms
              表示该阶段未执行或耗时不足 1 ms。PCM 和压缩音频是本轮使用的缓冲大小，不代表进程内存。
              频谱驻留仅计当前歌曲分页缓存，单窗推理输入另列，不含其他歌曲、模型、FFT
              和推理运行时分配。
            </p>
          </section>

          <section class="debug-section" aria-label="节奏构建区间">
            <div class="debug-heading">
              <h3>节奏构建</h3>
              <span>{{ phaseLabels[build.phase] }}</span>
            </div>
            <p class="debug-status" data-testid="coverage-status">{{ coverageLabel }}</p>
            <div
              v-if="duration > 0"
              class="debug-timeline"
              role="img"
              :aria-label="`已构建 ${rangesText(completed)}；正在构建 ${active ? rangeText(active) : '无'}；播放位置 ${time(position)}`"
            >
              <div class="debug-timeline-rail">
                <span
                  v-for="range in completed"
                  :key="range.startSeconds"
                  class="debug-range-completed"
                  :style="rangeStyle(range)"
                /><span v-if="active" class="debug-range-active" :style="rangeStyle(active)" />
              </div>
              <span class="debug-playhead" :style="{ left: `${(position / duration) * 100}%` }" />
            </div>
            <div class="debug-legend">
              <span><i class="legend-completed" />已构建</span
              ><span><i class="legend-active" />构建中</span
              ><span><i class="legend-playhead" />播放头</span
              ><span class="debug-legend-end"
                >{{ time(playbackSeconds) }} / {{ time(duration || null) }}</span
              >
            </div>
            <dl class="debug-details">
              <div>
                <dt>已构建区间</dt>
                <dd data-testid="completed-ranges">{{ rangesText(completed) }}</dd>
              </div>
              <div>
                <dt>当前构建</dt>
                <dd>{{ active ? rangeText(active) : '无' }}</dd>
              </div>
            </dl>
            <p v-if="build.phase === 'error'" class="debug-note">
              本曲分析暂不可用；已完成的区间以实际显示为准。
            </p>
          </section>
        </template>
        <template v-else-if="activeTab === 'preload'">
          <section class="debug-section" aria-label="实际分析调度">
            <div class="debug-heading">
              <h3>分析调度</h3>
              <span>{{ scheduler ? `${scheduler.cacheEntries} 首缓存` : '未获取' }}</span>
            </div>
            <template v-if="scheduler">
              <p class="debug-status" data-testid="scheduler-decision">
                {{ diagnosticText(scheduler.decision) || '尚未作出调度决策' }}
              </p>
              <p class="debug-note">
                {{
                  scheduler.playback.seeking
                    ? '正在拖动，暂不启动新窗口'
                    : scheduler.playback.playing
                      ? '随播放按需续建'
                      : '播放已暂停，按当前调度状态保留结果'
                }}
                · {{ fixed(scheduler.playback.playbackRate, 2) }}×
              </p>
              <dl class="debug-details">
                <div>
                  <dt>正在执行</dt>
                  <dd>
                    {{
                      scheduler.activeTask
                        ? `${roleLabels[scheduler.activeTask.role]} · ${phaseLabels[scheduler.activeTask.phase]}${scheduler.activeTask.yielding ? ' · 正在让出' : ''}${scheduler.activeTask.aborted ? ' · 已取消，正在释放' : ''}`
                        : '无'
                    }}
                  </dd>
                </div>
                <div>
                  <dt>连续缓冲 / 续建阈值</dt>
                  <dd>
                    {{ time(scheduler.continuousCoverageSeconds) }} /
                    {{ time(scheduler.lowWatermarkSeconds) }}–{{
                      time(scheduler.highWatermarkSeconds)
                    }}
                  </dd>
                </div>
              </dl>
              <ol v-if="orderedTasks.length" class="debug-task-list" aria-label="真实分析任务次序">
                <li v-for="task in orderedTasks" :key="task.role" class="debug-task">
                  <span class="debug-task-order">{{
                    task.order === 0 ? '当前' : task.order === null ? '—' : `#${task.order}`
                  }}</span>
                  <div class="debug-task-body">
                    <div class="debug-task-title">
                      <strong>{{ roleLabels[task.role] }}</strong
                      ><span class="debug-truncate" :title="task.title">{{
                        task.title || '未命名歌曲'
                      }}</span
                      ><span>{{ phaseLabels[task.phase] }}</span>
                    </div>
                    <p>{{ diagnosticText(task.reason) }}</p>
                    <p>
                      连续 {{ time(task.continuousCoverageSeconds) }} / 目标
                      {{ time(task.targetBufferSeconds) }} · {{ task.completedWindows }} 窗<span
                        v-if="task.estimatedWorkMs > 0"
                      >
                        · 估时 {{ fixed(task.estimatedWorkMs / 1000, 1) }} 秒/窗</span
                      >
                      · {{ task.resumable ? '可续建' : task.cached ? '已缓存' : '未缓存' }}
                    </p>
                  </div>
                </li>
              </ol>
              <p v-else class="debug-note">当前没有分析任务。</p>
            </template>
            <p v-else class="debug-note">等待调度快照，不推测后续任务顺序。</p>
          </section>

          <section class="debug-section" aria-label="音频预加载槽">
            <div class="debug-heading">
              <h3>音频预加载</h3>
              <span>实际通道状态</span>
            </div>
            <p v-if="!orderedSlots.length" class="debug-note">尚未取得预加载槽状态。</p>
            <div
              v-for="slot in orderedSlots"
              :key="slot.direction"
              class="debug-slot"
              :data-direction="slot.direction"
            >
              <div class="debug-task-title">
                <strong>{{ roleLabels[slot.direction] }}</strong
                ><span class="debug-truncate" :title="slot.title || undefined">{{
                  slot.title || '未分配歌曲'
                }}</span
                ><span>{{ slotLabels[slot.phase] }}</span>
              </div>
              <p v-if="slot.artist" class="debug-note debug-truncate" :title="slot.artist">
                {{ slot.artist }}
              </p>
              <dl class="debug-details">
                <div>
                  <dt>通道 / 位置 / 时长</dt>
                  <dd>
                    {{ diagnosticText(slot.channelId) }} · {{ time(slot.currentTimeSeconds) }} /
                    {{ time(slot.durationSeconds) }}
                  </dd>
                </div>
                <div>
                  <dt>媒体就绪</dt>
                  <dd>
                    {{ slot.readyState }} · {{ readyLabels[slot.readyState] ?? '未知状态' }} ·
                    {{ slot.canStart ? '可启动' : '尚不可启动' }}
                  </dd>
                </div>
                <div>
                  <dt>网络状态</dt>
                  <dd>
                    {{ slot.networkState }} · {{ networkLabels[slot.networkState] ?? '未知状态' }}
                  </dd>
                </div>
                <div>
                  <dt>音频缓冲</dt>
                  <dd>{{ rangesText(slot.bufferedRanges) }}</dd>
                </div>
              </dl>
              <p v-if="slot.failed || slot.error" class="debug-note">
                媒体加载失败，详细地址不在调试面板显示。
              </p>
            </div>
          </section>

          <section class="debug-section" aria-label="完整播放队列">
            <div class="debug-heading">
              <h3>
                播放队列 <small>{{ queue.length }}</small>
              </h3>
              <button
                class="debug-button"
                type="button"
                :disabled="currentIndex < 0"
                @click="locateCurrent"
              >
                <LocateFixed :size="12" aria-hidden="true" />定位当前
              </button>
            </div>
            <p class="debug-note">
              {{ playModeText }} · 下列为播放队列顺序，实际上一首和下一首以预加载槽为准。
            </p>
            <p v-if="!queue.length" class="debug-empty">播放队列为空。</p>
            <ol
              v-else
              ref="queueElement"
              class="debug-queue"
              :start="page * PAGE_SIZE + 1"
              aria-label="歌曲队列"
            >
              <li
                v-for="(track, index) in queuePage"
                :key="`${page * PAGE_SIZE + index}:${track.id}`"
                class="debug-queue-row"
                :class="{ 'is-current': track.id === currentTrackId }"
                :aria-current="track.id === currentTrackId ? 'true' : undefined"
              >
                <span class="debug-queue-index">{{ page * PAGE_SIZE + index + 1 }}</span>
                <div class="debug-queue-title">
                  <span class="debug-truncate" :title="trackTitle(track)">{{
                    trackTitle(track)
                  }}</span
                  ><small class="debug-truncate" :title="track.artist">{{
                    track.artist || '未知歌手'
                  }}</small>
                </div>
                <span v-if="track.id === currentTrackId" class="debug-current-label">当前</span>
              </li>
            </ol>
            <nav v-if="pageCount > 1" class="debug-pagination" aria-label="播放队列分页">
              <button
                type="button"
                class="debug-icon-button"
                aria-label="上一页歌曲"
                :disabled="page === 0"
                @click="page--"
              >
                <ChevronLeft :size="16" aria-hidden="true" /></button
              ><span>{{ page + 1 }} / {{ pageCount }} 页 · 每页 {{ PAGE_SIZE }} 首</span
              ><button
                type="button"
                class="debug-icon-button"
                aria-label="下一页歌曲"
                :disabled="page >= pageCount - 1"
                @click="page++"
              >
                <ChevronRight :size="16" aria-hidden="true" />
              </button>
            </nav>
          </section>
        </template>
        <BeatComparisonSection
          v-else-if="activeTab === 'comparison'"
          :snapshot="comparison ?? null"
          :can-start="canCompare ?? false"
          :playback-seconds="playbackSeconds"
          :flash-rate="flashRate ?? 1"
          :export-sample-count="comparisonExportSampleCount ?? 0"
          :export-truncated="comparisonExportTruncated ?? false"
          :exporting="comparisonExporting ?? false"
          :export-error="comparisonExportError ?? null"
          @start="emit('compare-start')"
          @stop="emit('compare-stop')"
          @export="emit('compare-export')"
        />
        <LyricsDebugSection
          v-else-if="activeTab === 'lyrics'"
          :lyrics="lyrics ?? null"
          :lyrics-window="lyricsWindow ?? null"
          :lyrics-window-supported="lyricsWindowSupported ?? false"
          :has-current-track="hasCurrentTrack ?? false"
          @toggle-lyrics-window="emit('toggle-lyrics-window')"
        />
        <RuntimeDebugSection v-else :runtime="runtime ?? null" />
      </div>
    </Transition>
  </section>
</template>

<style scoped lang="scss">
  .player-debug-panel {
    display: flex;
    flex-direction: column;
    min-block-size: 0;
    block-size: 100%;
    color: var(--text);
    font-size: 0.72rem;
    font-variant-numeric: tabular-nums;
  }
  .debug-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
    padding: 20px 20px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.09);
  }
  .debug-header h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 550;
  }
  .debug-header p {
    margin: 5px 0 0;
    color: var(--text-subtle);
    font-size: 0.66rem;
  }
  .debug-scroll {
    flex: 1;
    min-block-size: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }
  .debug-scroll:focus-visible {
    outline: 1px solid var(--text-subtle);
    outline-offset: -3px;
  }
  .debug-tabs {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 4px;
    flex-shrink: 0;
    margin: 10px 20px 0;
    padding: 4px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.045);
  }
  .debug-tabs button {
    min-inline-size: 0;
    min-block-size: 32px;
    padding: 5px 3px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-subtle);
    font: inherit;
    font-size: 0.68rem;
    cursor: pointer;
    transition:
      color 180ms cubic-bezier(0.16, 1, 0.3, 1),
      background 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .debug-tabs button[aria-selected='true'] {
    background: rgba(255, 255, 255, 0.12);
    color: var(--text);
  }
  .debug-page-enter-active,
  .debug-page-leave-active {
    transition: opacity 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .debug-page-enter-from,
  .debug-page-leave-to {
    opacity: 0;
  }
  .debug-section {
    margin-inline: 20px;
    padding-block: 16px;
  }
  .debug-section + .debug-section {
    border-top: 1px solid rgba(255, 255, 255, 0.09);
  }
  .debug-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px 12px;
    min-block-size: 30px;
  }
  .debug-heading h3 {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 550;
  }
  .debug-heading > span,
  .debug-heading h3 small {
    color: var(--text-subtle);
    font-size: 0.64rem;
    font-weight: 400;
  }
  .debug-heading h3 small {
    margin-left: 5px;
  }
  .debug-status {
    margin: 5px 0 8px;
    color: var(--text-muted);
    line-height: 1.65;
    overflow-wrap: anywhere;
  }
  .debug-note {
    margin: 5px 0 0;
    color: var(--text-subtle);
    font-size: 0.64rem;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }
  .debug-button,
  .debug-icon-button {
    display: inline-flex;
    justify-content: center;
    align-items: center;
    gap: 5px;
    min-block-size: 30px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 5px 8px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-muted);
    font: inherit;
    font-size: 0.64rem;
    cursor: pointer;
    transition: background 180ms ease;
  }
  .debug-icon-button {
    inline-size: 32px;
    padding: 0;
    flex-shrink: 0;
  }
  button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  button:not(:disabled):hover {
    background: rgba(255, 255, 255, 0.12);
  }
  button:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 3px;
  }
  .debug-chart {
    position: relative;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.025);
  }
  .debug-chart svg {
    display: block;
    inline-size: 100%;
    block-size: auto;
    min-block-size: 92px;
  }
  .debug-chart text {
    fill: var(--text-subtle);
    font-size: 9px;
  }
  .debug-chart-grid {
    stroke: var(--text-subtle);
    opacity: 0.2;
    fill: none;
    stroke-width: 0.5;
  }
  .debug-curve {
    fill: none;
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
    stroke-linejoin: round;
    stroke-linecap: round;
  }
  .debug-level {
    stroke: var(--accent);
  }
  .debug-sustain {
    stroke: var(--text-muted);
    stroke-dasharray: 5 4;
  }
  .debug-chart-empty {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: var(--text-subtle);
    font-size: 0.65rem;
  }
  .debug-legend {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 12px;
    margin-block: 7px 4px;
    color: var(--text-subtle);
    font-size: 0.6rem;
  }
  .debug-legend > span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .debug-legend-end {
    margin-inline-start: auto;
  }
  .debug-legend i {
    display: inline-block;
    inline-size: 12px;
    block-size: 2px;
    background: var(--text-muted);
  }
  .debug-legend .legend-level {
    background: var(--accent);
  }
  .debug-legend .legend-sustain {
    block-size: 0;
    background: none;
    border-top: 2px dashed var(--text-muted);
  }
  .debug-metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 14px;
    margin: 14px 0 8px;
  }
  .debug-metrics dt,
  .debug-details dt {
    color: var(--text-subtle);
    font-size: 0.6rem;
  }
  .debug-metrics dd {
    margin: 3px 0 0;
    color: var(--text);
    font-size: 0.75rem;
  }
  .debug-metrics dd small {
    font-size: 0.6rem;
    color: var(--text-muted);
  }
  .debug-details {
    margin: 10px 0 0;
  }
  .debug-details > div {
    display: grid;
    grid-template-columns: minmax(6.5em, auto) minmax(0, 1fr);
    gap: 6px 12px;
    padding-block: 3px;
  }
  .debug-details dd {
    margin: 0;
    text-align: end;
    color: var(--text-muted);
    font-size: 0.63rem;
    overflow-wrap: anywhere;
  }
  .debug-timeline {
    position: relative;
    block-size: 18px;
    margin-block: 10px 4px;
  }
  .debug-timeline-rail {
    position: absolute;
    inset: 5px 0;
    overflow: hidden;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.08);
  }
  .debug-timeline-rail > span {
    position: absolute;
    block-size: 100%;
  }
  .debug-range-completed,
  .legend-completed {
    background: var(--text-muted);
  }
  .debug-range-active,
  .debug-legend .legend-active {
    background: repeating-linear-gradient(110deg, var(--text-subtle) 0 3px, transparent 3px 6px);
  }
  .debug-playhead {
    position: absolute;
    inset-block: 1px;
    inline-size: 2px;
    background: var(--text);
    transform: translateX(-50%);
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  }
  .debug-legend .legend-playhead {
    inline-size: 2px;
    block-size: 7px;
    background: var(--text);
  }
  .debug-task-list {
    padding: 0;
    margin: 10px 0 0;
    list-style: none;
  }
  .debug-task {
    display: flex;
    gap: 8px;
    padding-block: 9px;
  }
  .debug-task + .debug-task {
    border-top: 1px solid rgba(255, 255, 255, 0.055);
  }
  .debug-task-order {
    flex: 0 0 2.8em;
    color: var(--text-subtle);
    font-size: 0.62rem;
    line-height: 1.6;
  }
  .debug-task-body {
    flex: 1;
    min-inline-size: 0;
  }
  .debug-task-title {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 0.67rem;
    min-block-size: 1.4rem;
  }
  .debug-task-title strong {
    flex-shrink: 0;
    font-size: 0.62rem;
    color: var(--text-muted);
    font-weight: 500;
  }
  .debug-task-title > span:last-child:not(.debug-truncate) {
    margin-inline-start: auto;
    flex-shrink: 0;
    color: var(--text-subtle);
    font-size: 0.6rem;
  }
  .debug-task p {
    margin: 3px 0 0;
    color: var(--text-subtle);
    font-size: 0.62rem;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }
  .debug-truncate {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .debug-slot {
    padding-block: 10px;
  }
  .debug-slot + .debug-slot {
    border-top: 1px solid rgba(255, 255, 255, 0.055);
  }
  .debug-slot .debug-details {
    margin-top: 6px;
  }
  .debug-queue {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    max-block-size: 22rem;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .debug-queue-row {
    display: flex;
    align-items: center;
    gap: 9px;
    block-size: 43px;
    padding-inline: 6px;
    border-radius: 5px;
  }
  .debug-queue-row.is-current {
    background: rgba(255, 255, 255, 0.075);
  }
  .debug-queue-index {
    min-inline-size: 3ch;
    text-align: end;
    color: var(--text-subtle);
    font-size: 0.6rem;
  }
  .debug-queue-title {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 3px;
    min-inline-size: 0;
    font-size: 0.68rem;
  }
  .debug-queue-title small {
    color: var(--text-subtle);
    font-size: 0.59rem;
  }
  .debug-current-label {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: 0.6rem;
  }
  .debug-empty {
    padding-block: 14px;
    text-align: center;
    color: var(--text-subtle);
  }
  .debug-pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-top: 12px;
    color: var(--text-subtle);
    font-size: 0.62rem;
  }
  @media (max-width: 420px) {
    .debug-tabs {
      margin-inline: 14px;
    }
    .debug-header {
      padding: 16px 14px 12px;
    }
    .debug-section {
      margin-inline: 14px;
    }
    .debug-details > div {
      gap: 5px 8px;
    }
  }
  @media (pointer: coarse) {
    .debug-tabs button {
      min-block-size: 40px;
    }
    .debug-button,
    .debug-icon-button {
      min-block-size: 40px;
    }
    .debug-icon-button {
      inline-size: 40px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .debug-tabs button,
    .debug-page-enter-active,
    .debug-page-leave-active {
      transition: none;
    }
    .debug-button,
    .debug-icon-button {
      transition: none;
    }
  }
  @media (prefers-contrast: more) {
    .debug-note,
    .debug-details dt,
    .debug-metrics dt,
    .debug-legend,
    .debug-task p {
      color: var(--text);
    }
    .debug-button,
    .debug-icon-button,
    .debug-chart {
      border: 1px solid currentColor;
    }
  }
</style>
