<script setup lang="ts">
  import { computed, onMounted, ref, shallowRef, watch } from 'vue'
  import { Download, Pause, Play, Square } from '@lucide/vue'
  import type {
    BeatComparisonRoute,
    BeatComparisonSample,
    BeatComparisonSnapshot,
  } from '../core/analysis/beat-comparison'
  import {
    BEAT_COMPARISON_CHART,
    beatComparisonCurve,
    type BeatComparisonMetric,
    type BeatComparisonSeries,
  } from '../core/analysis/beat-comparison-chart'
  import type { BeatHighlightReason } from '../core/analysis/beat-debug'
  import { sanitizeBeatFlashRate } from '../core/analysis/beat-envelope'
  import type { BeatAnalysisMode } from '../core/types'

  const props = withDefaults(
    defineProps<{
      snapshot: BeatComparisonSnapshot | null
      playbackSeconds: number
      canStart: boolean
      flashRate?: number
      exportSampleCount?: number
      exportTruncated?: boolean
      exporting?: boolean
      exportError?: string | null
    }>(),
    {
      flashRate: 1,
      exportSampleCount: 0,
      exportTruncated: false,
      exporting: false,
      exportError: null,
    },
  )
  const emit = defineEmits<{
    start: []
    stop: []
    export: []
  }>()
  const metric = ref<BeatComparisonMetric>('level')
  const hidden = ref<BeatComparisonSeries[]>([])
  const frozenHistory = shallowRef<readonly BeatComparisonSample[] | null>(null)
  const motionPaused = ref(false)
  const exportCount = computed(() =>
    Number.isFinite(props.exportSampleCount) ? Math.max(0, Math.floor(props.exportSampleCount)) : 0,
  )
  const modeDefinitions = [
    { mode: 'basic', label: '基础算法', style: 'solid', dash: undefined },
    { mode: 'beat-this-small', label: 'Small', style: 'dashed', dash: '7 4' },
    { mode: 'beat-this-standard', label: '标准版', style: 'dotted', dash: '1 4' },
  ] as const
  const modeLabels: Record<BeatAnalysisMode, string> = {
    basic: '基础模式',
    'beat-this-small': 'Beat This! Small',
    'beat-this-standard': 'Beat This! 标准版',
  }
  const statusLabels: Record<BeatComparisonRoute['status'], string> = {
    idle: '等待开启',
    queued: '等待构建',
    running: '构建中',
    ready: '已缓冲',
    unavailable: '模型未就绪',
    cancelled: '已停止构建',
    error: '构建失败',
  }
  const phaseLabels: Record<BeatComparisonRoute['phase'], string> = {
    idle: '准备构建',
    'loading-model': '读取本地模型',
    fetching: '读取音频',
    decoding: '解码音频',
    analysing: '构建候选结果',
    buffered: '已缓冲',
    ready: '已缓冲',
    error: '构建失败',
  }
  const reasonLabels: Record<BeatHighlightReason, string> = {
    ready: '正在输出',
    disabled: '高亮已关闭',
    'reduced-motion': '减少动态效果',
    hidden: '页面不可见',
    paused: '播放已暂停',
    seeking: '正在拖动进度',
    buffering: '正在缓冲',
    'audio-unavailable': '等待音频',
    'context-suspended': '音频输出未恢复',
    'model-unavailable': '模型未就绪',
    'timeline-missing': '等待分析结果',
    'range-unbuilt': '当前位置未构建',
  }
  const current = computed(() => props.snapshot?.current ?? null)
  const history = computed(() => frozenHistory.value ?? props.snapshot?.history ?? [])
  const running = computed(() => props.snapshot?.phase === 'running')
  const selectedFlashRate = computed(() =>
    sanitizeBeatFlashRate(current.value?.flashRate ?? props.snapshot?.flashRate ?? props.flashRate),
  )
  const routes = computed(() =>
    modeDefinitions.map((definition) => {
      const route = props.snapshot?.routes.find((entry) => entry.mode === definition.mode)
      const value = current.value?.candidates[definition.mode]?.[metric.value]
      return {
        ...definition,
        route,
        value,
        visible: !hidden.value.includes(definition.mode),
        status: route
          ? route.status === 'running'
            ? phaseLabels[route.phase]
            : route.status === 'ready' && value === undefined && current.value?.actual.playing
              ? '等待当前位置结果'
              : statusLabels[route.status]
          : '等待开启',
        curve: beatComparisonCurve(history.value, definition.mode, metric.value),
      }
    }),
  )
  const actualVisible = computed(() => !hidden.value.includes('actual'))
  const actualCurve = computed(() => beatComparisonCurve(history.value, 'actual', metric.value))
  const actualValue = computed(() => current.value?.actual[metric.value])
  const actualStatus = computed(() =>
    current.value ? reasonLabels[current.value.actual.reason] : '等待实际输出采样',
  )
  const actualMode = computed(() =>
    props.snapshot?.actualMode ? modeLabels[props.snapshot.actualMode] : '尚未获取',
  )
  const actualSource = computed(() => {
    switch (current.value?.actual.timing?.timelineSource) {
      case 'basic':
        return '基础分析'
      case 'provisional':
        return '临时基础高亮'
      case 'model':
        return '模型分析'
      case 'none':
        return '当前位置无可用结果'
      default:
        return '尚未获取'
    }
  })
  const chartHasData = computed(
    () =>
      (actualVisible.value && actualCurve.value) ||
      routes.value.some((route) => route.visible && route.curve),
  )
  const hasHiddenData = computed(
    () =>
      (!actualVisible.value && actualCurve.value) ||
      routes.value.some((route) => !route.visible && route.curve),
  )
  const summary = computed(() => {
    switch (props.snapshot?.phase) {
      case 'running':
        return '实时对比已开启'
      case 'cancelled':
        return '候选构建已停止'
      case 'error':
        return '部分候选暂不可用'
      default:
        return '实际输出持续采样'
    }
  })
  onMounted(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      motionPaused.value = true
      frozenHistory.value = props.snapshot?.history.slice() ?? []
    }
  })
  watch(
    () => props.snapshot?.epoch,
    () => {
      // Source/mode/rate changes and seeks must not leave an old song frozen on screen.
      if (frozenHistory.value !== null) frozenHistory.value = []
    },
  )
  function toggleFrozen(): void {
    frozenHistory.value =
      frozenHistory.value === null ? (props.snapshot?.history.slice() ?? []) : null
    motionPaused.value = false
  }
  function toggleRoute(series: BeatComparisonSeries): void {
    hidden.value = hidden.value.includes(series)
      ? hidden.value.filter((entry) => entry !== series)
      : [...hidden.value, series]
  }
  function fixed(value: number | undefined, digits = 3): string {
    return value !== undefined && Number.isFinite(value) ? value.toFixed(digits) : '—'
  }
  function progress(value: number): number {
    return Number.isFinite(value) ? Math.round(Math.max(0, Math.min(1, value)) * 100) : 0
  }
  function safeError(value: string): string {
    return value
      .replace(/https?:\/\/\S+|(?:\/[^\s?]*)?\?[^\s]+/gi, '[地址已隐藏]')
      .replace(/\b(?:token|key|secret|signature|authorization)\s*[:=]\s*\S+/gi, '[凭据已隐藏]')
  }
</script>

<template>
  <section class="beat-comparison" aria-label="实时节拍四路曲线对比" aria-live="off">
    <div class="comparison-heading">
      <h3>实时曲线对比</h3>
      <span>{{ summary }}</span>
    </div>
    <p class="comparison-note">三路候选与实际背景输出一起滚动，显示最近 20 秒。</p>
    <div class="comparison-actions">
      <button
        type="button"
        class="comparison-button"
        :disabled="!canStart || running"
        @click="emit('start')"
      >
        <Play :size="13" aria-hidden="true" />开启实时对比
      </button>
      <button v-if="running" type="button" class="comparison-button" @click="emit('stop')">
        <Square :size="12" aria-hidden="true" />停止构建
      </button>
      <button
        type="button"
        class="comparison-button"
        :aria-pressed="frozenHistory !== null"
        @click="toggleFrozen"
      >
        <Play v-if="frozenHistory !== null" :size="13" aria-hidden="true" />
        <Pause v-else :size="13" aria-hidden="true" />
        {{ frozenHistory === null ? '冻结图表' : '恢复滚动' }}
      </button>
    </div>
    <p v-if="!canStart && !running && !current" class="comparison-note">
      请先选择一首可播放的歌曲。
    </p>
    <p v-if="motionPaused" class="comparison-note">
      已按系统减少动态效果设置冻结图表，可手动恢复。
    </p>
    <p v-else-if="frozenHistory !== null" class="comparison-note">
      图表已冻结，当前数值和构建状态继续更新。
    </p>
    <div class="comparison-export">
      <button
        type="button"
        class="comparison-button comparison-export-button"
        :disabled="exportCount === 0 || exporting"
        :aria-busy="exporting"
        @click="emit('export')"
      >
        <Download :size="14" aria-hidden="true" />{{ exporting ? '正在导出…' : '导出 JSON' }}
      </button>
      <span data-testid="comparison-export-count">已记录 {{ exportCount }} 条</span>
    </div>
    <p class="comparison-note">
      图表仅显示最近 20 秒；导出包含本曲会话已记录的四路数据，不受显隐、冻结或强度切换影响。
    </p>
    <p v-if="exportTruncated" class="comparison-note">记录已达到上限，导出保留最近的记录。</p>
    <div aria-live="polite" aria-atomic="true">
      <p v-if="exportError" class="comparison-note comparison-export-error">
        {{ safeError(exportError) }}
      </p>
    </div>
    <div class="comparison-metrics" role="group" aria-label="对比数据类型">
      <button
        type="button"
        class="comparison-button"
        :aria-pressed="metric === 'level'"
        @click="metric = 'level'"
      >
        高亮强度
      </button>
      <button
        type="button"
        class="comparison-button"
        :aria-pressed="metric === 'sustain'"
        @click="metric = 'sustain'"
      >
        持续能量
      </button>
      <span>频率 ×{{ selectedFlashRate }} · 播放 {{ fixed(playbackSeconds, 2) }} s</span>
    </div>
    <div class="comparison-chart">
      <svg
        :viewBox="`0 0 ${BEAT_COMPARISON_CHART.width} ${BEAT_COMPARISON_CHART.height}`"
        role="img"
        :aria-label="`最近二十秒的三路候选与实际背景${metric === 'level' ? '高亮强度' : '持续能量'}，纵轴零到一`"
      >
        <g class="comparison-grid" aria-hidden="true">
          <line
            v-for="fraction in [0, 0.5, 1]"
            :key="fraction"
            :x1="BEAT_COMPARISON_CHART.left"
            :x2="BEAT_COMPARISON_CHART.right"
            :y1="BEAT_COMPARISON_CHART.bottom - fraction * 126"
            :y2="BEAT_COMPARISON_CHART.bottom - fraction * 126"
          />
        </g>
        <g class="comparison-ticks" aria-hidden="true">
          <text x="20" y="18" text-anchor="end">1</text>
          <text x="20" y="81" text-anchor="end">0.5</text>
          <text x="20" y="144" text-anchor="end">0</text>
          <text
            v-for="(label, index) in [
              '−20 s',
              '−15 s',
              '−10 s',
              '−5 s',
              frozenHistory === null ? '现在' : '冻结时',
            ]"
            :key="index"
            :x="BEAT_COMPARISON_CHART.left + index * 109.5"
            y="162"
            :text-anchor="index === 0 ? 'start' : index === 4 ? 'end' : 'middle'"
          >
            {{ label }}
          </text>
        </g>
        <template v-for="route in routes" :key="route.mode">
          <path
            v-if="route.visible && route.curve"
            :d="route.curve"
            class="comparison-curve"
            :class="`comparison-${route.mode}`"
            :stroke-dasharray="route.dash"
            :data-testid="`comparison-curve-${route.mode}`"
          />
        </template>
        <path
          v-if="actualVisible && actualCurve"
          :d="actualCurve"
          class="comparison-curve comparison-actual"
          data-testid="comparison-curve-actual"
        />
      </svg>
      <p v-if="!chartHasData" class="comparison-empty">
        {{ hasHiddenData ? '曲线已隐藏，可点击下方图例显示' : '等待实际采样记录' }}
      </p>
    </div>
    <p class="comparison-note comparison-chart-caption">
      横轴：经过时间 · 空白：该时刻没有候选结果 · 纵轴：0–1
    </p>

    <ul class="comparison-routes" aria-label="四路曲线图例与当前数值">
      <li class="comparison-actual-row" data-testid="comparison-route-actual">
        <div class="comparison-route-heading">
          <button
            type="button"
            class="comparison-button comparison-legend"
            aria-label="显示实际背景输出曲线"
            :aria-pressed="actualVisible"
            @click="toggleRoute('actual')"
          >
            <i class="comparison-actual" aria-hidden="true" />实际背景输出
          </button>
          <strong class="comparison-value" data-testid="comparison-value-actual">{{
            fixed(actualValue)
          }}</strong>
          <span>{{ actualStatus }}</span>
        </div>
        <p class="comparison-source" data-testid="comparison-actual-source">
          当前设置 {{ actualMode }} · 实际来源 {{ actualSource }}
        </p>
      </li>
      <li v-for="route in routes" :key="route.mode" :data-testid="`comparison-route-${route.mode}`">
        <div class="comparison-route-heading">
          <button
            type="button"
            class="comparison-button comparison-legend"
            :aria-label="`显示${route.label}曲线`"
            :aria-pressed="route.visible"
            @click="toggleRoute(route.mode)"
          >
            <i
              :class="[`comparison-${route.mode}`, `comparison-line-${route.style}`]"
              aria-hidden="true"
            />{{ route.label }}
          </button>
          <strong class="comparison-value" :data-testid="`comparison-value-${route.mode}`">{{
            fixed(route.value)
          }}</strong>
          <span>{{ route.status }}</span>
        </div>
        <div
          v-if="route.route?.status === 'running'"
          class="comparison-progress"
          role="progressbar"
          :aria-label="`${route.label}缓冲构建进度`"
          :aria-valuenow="progress(route.route.progress)"
          aria-valuemin="0"
          aria-valuemax="100"
        >
          <i :style="{ inlineSize: `${progress(route.route.progress)}%` }" />
        </div>
        <p v-if="route.route?.status === 'unavailable'" class="comparison-note">
          请在设置中手动下载此模型，再开启实时对比。
        </p>
        <p v-if="route.route?.error" class="comparison-note">{{ safeError(route.route.error) }}</p>
        <p
          v-if="route.route?.metrics"
          class="comparison-source"
          :data-testid="`comparison-timing-${route.mode}`"
        >
          {{
            route.mode === 'basic'
              ? '基础分析'
              : route.route.metrics.sessionReused
                ? '复用会话'
                : '首次初始化'
          }}
          <template v-if="route.route.metrics.backend">
            · {{ route.route.metrics.backend }}</template
          >
          · 本段 {{ fixed(route.route.metrics.totalMs / 1000, 2) }} s
          <template v-if="route.route.metrics.cacheOnly"> · 缓存直接恢复</template>
          <template v-if="route.route.metrics.decodeMs !== undefined">
            · 解码 {{ fixed(route.route.metrics.decodeMs / 1000, 2) }} s
          </template>
          <template v-if="route.mode !== 'basic'">
            · 初始化 {{ fixed(route.route.metrics.initializationMs / 1000, 2) }} s · 模型推理
            {{ fixed(route.route.metrics.inferenceMs / 1000, 2) }} s
            <template v-if="route.route.metrics.featureFrames !== undefined">
              · 特征复用 {{ route.route.metrics.reusedFeatureFrames ?? 0 }} /
              {{ route.route.metrics.featureFrames }} 帧
            </template>
            <template v-if="route.route.metrics.featurePeakResidentBytes !== undefined">
              · 本曲频谱驻留峰值
              {{ fixed(route.route.metrics.featurePeakResidentBytes / 1048576, 2) }} MiB
            </template>
          </template>
        </p>
      </li>
    </ul>
    <p class="comparison-note">
      白色粗线来自播放器实际写入的高亮值采样，包含播放状态与平滑处理，尚未叠加 CSS
      亮度缩放。采样不保证捕捉每一帧的峰顶。
    </p>
    <p class="comparison-note">
      三路候选在同一采样位置读取各自的分析包络；模型未算到的位置留空，之后不会回填这段历史。模型曲线不代表原始概率。
    </p>
    <p class="comparison-note">
      开启后按播放位置持续补充候选缓冲，切出此页会暂停对比。冻结图表仅暂停曲线滚动。
    </p>
    <p class="comparison-note">
      导出可用于比较响应差异；缺少音频或人工拍点标注时，无法据此判断节拍准确率。
    </p>
  </section>
</template>

<style scoped lang="scss">
  .beat-comparison {
    --comparison-basic: rgb(117, 209, 240);
    --comparison-small: rgb(245, 197, 114);
    --comparison-standard: rgb(211, 164, 240);
    min-inline-size: 0;
    margin-inline: 20px;
    padding-block: 16px;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .comparison-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px 10px;
    flex-wrap: wrap;
  }
  .comparison-heading h3 {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 550;
  }
  .comparison-heading > span,
  .comparison-route-heading > span {
    color: var(--text-subtle);
    font-size: 0.62rem;
  }
  .comparison-note,
  .comparison-source {
    margin: 6px 0 0;
    color: var(--text-subtle);
    font-size: 0.64rem;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }
  .comparison-source {
    color: var(--text-muted);
    font-size: 0.6rem;
  }
  .comparison-actions,
  .comparison-metrics,
  .comparison-export {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 7px;
    margin-top: 12px;
  }
  .comparison-export > span {
    color: var(--text-subtle);
    font-size: 0.64rem;
  }
  .comparison-button.comparison-export-button {
    border-color: rgba(255, 255, 255, 0.2);
    background: rgba(255, 255, 255, 0.09);
    color: var(--text);
  }
  .comparison-export-error {
    color: var(--text-muted);
  }
  .comparison-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-block-size: 30px;
    padding: 5px 8px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    color: var(--text-muted);
    font: inherit;
    font-size: 0.64rem;
    cursor: pointer;
    transition:
      background 180ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 180ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .comparison-button:not(:disabled):hover,
  .comparison-metrics button[aria-pressed='true'] {
    background: rgba(255, 255, 255, 0.12);
    color: var(--text);
  }
  .comparison-button:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 3px;
  }
  .comparison-button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .comparison-metrics > span {
    color: var(--text-subtle);
    font-size: 0.6rem;
  }
  .comparison-chart {
    position: relative;
    margin-top: 12px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 10px;
    background: rgba(0, 0, 0, 0.14);
  }
  .comparison-chart svg {
    display: block;
    inline-size: 100%;
    aspect-ratio: 480 / 176;
    overflow: visible;
  }
  .comparison-grid line {
    stroke: rgba(255, 255, 255, 0.1);
    stroke-width: 1;
  }
  .comparison-ticks text {
    fill: var(--text-subtle);
    font-size: 11px;
  }
  .comparison-curve {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }
  .comparison-basic {
    color: var(--comparison-basic);
  }
  .comparison-beat-this-small {
    color: var(--comparison-small);
  }
  .comparison-beat-this-standard {
    color: var(--comparison-standard);
  }
  .comparison-actual {
    color: var(--text);
  }
  .comparison-curve.comparison-actual {
    stroke-width: 2.7;
  }
  .comparison-empty {
    position: absolute;
    inset: 0;
    display: grid;
    align-items: center;
    margin: 0;
    padding-inline: 36px;
    color: var(--text-muted);
    font-size: 0.64rem;
    text-align: center;
    pointer-events: none;
  }
  .comparison-chart-caption {
    font-size: 0.59rem;
  }
  .comparison-routes {
    list-style: none;
    margin: 12px 0;
    padding: 0;
  }
  .comparison-routes li {
    padding-block: 9px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.065);
  }
  .comparison-routes .comparison-actual-row {
    margin-inline: -6px;
    padding: 9px 6px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.055);
  }
  .comparison-route-heading {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, auto);
    gap: 8px;
    align-items: center;
  }
  .comparison-route-heading > span {
    text-align: end;
  }
  .comparison-value {
    min-inline-size: 5ch;
    font-size: 0.7rem;
    font-weight: 500;
    text-align: end;
  }
  .comparison-legend {
    justify-content: flex-start;
    padding-inline: 4px;
    border-color: transparent;
    background: transparent;
  }
  .comparison-legend[aria-pressed='false'] {
    opacity: 0.45;
    text-decoration: line-through;
  }
  .comparison-legend i {
    flex: 0 0 20px;
    inline-size: 20px;
    block-size: 0;
    border-top: 2px solid currentColor;
  }
  .comparison-legend i.comparison-actual {
    border-top-width: 3px;
  }
  .comparison-legend .comparison-line-dashed {
    border-top-style: dashed;
  }
  .comparison-legend .comparison-line-dotted {
    border-top-style: dotted;
  }
  .comparison-progress {
    block-size: 3px;
    margin-top: 7px;
    overflow: hidden;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.08);
  }
  .comparison-progress i {
    display: block;
    block-size: 100%;
    background: var(--text-muted);
  }
  @media (max-width: 420px) {
    .beat-comparison {
      margin-inline: 14px;
    }
    .comparison-route-heading {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 2px 8px;
    }
    .comparison-route-heading > span {
      grid-column: 1 / -1;
      padding-inline-start: 30px;
      text-align: start;
    }
  }
  @media (pointer: coarse) {
    .comparison-button {
      min-block-size: 40px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .comparison-button {
      transition: none;
    }
  }
  @media (prefers-contrast: more) {
    .comparison-note,
    .comparison-source,
    .comparison-heading > span,
    .comparison-route-heading > span,
    .comparison-metrics > span,
    .comparison-export > span {
      color: var(--text);
    }
    .comparison-chart,
    .comparison-button {
      border-color: var(--text);
    }
    .comparison-ticks text {
      fill: var(--text);
    }
    .comparison-curve {
      stroke-width: 2.5;
    }
    .comparison-curve.comparison-actual {
      stroke-width: 3.5;
    }
  }
</style>
