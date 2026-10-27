<script setup lang="ts">
  import { computed, ref, shallowRef, watch } from 'vue'
  import { ChevronDown, ChevronLeft, ChevronRight } from '@lucide/vue'
  import Collapse from './Collapse.vue'
  import {
    calibrationLines,
    calibratedOffset,
    recordCalibrationSample,
    type LyricCalibrationContext,
    type LyricCalibrationSample,
  } from '../core/lyrics/calibration'
  import type { LyricPlaybackState } from '../core/lyrics/render-schedule'

  const props = defineProps<{
    context: LyricCalibrationContext | null
    getPlaybackState?: () => LyricPlaybackState
    playing: boolean
    offsetMs: number
    onApply: (offset: number) => void
  }>()
  const expanded = ref(false)
  const cursor = ref(0)
  const samples = shallowRef<LyricCalibrationSample[]>([])
  const message = ref('')
  const candidates = computed(() => calibrationLines(props.context?.lines ?? []))
  const selected = computed(() => candidates.value[cursor.value])
  const available = computed(() =>
    Boolean(props.context?.source && candidates.value.length && props.getPlaybackState),
  )
  const offset = computed(() => calibratedOffset(samples.value))
  const suggestion = computed(() => {
    const value = offset.value
    if (value === null) return ''
    if (value === 0) return '无需偏移'
    return `${value < 0 ? '提前' : '延后'} ${(Math.abs(value) / 1000).toFixed(1)} 秒`
  })

  function toggle(): void {
    if (!available.value) return
    expanded.value = !expanded.value
    if (!expanded.value) return
    samples.value = []
    message.value = ''
    const now = props.getPlaybackState?.().timeSeconds ?? 0
    const next = candidates.value.findIndex(
      ({ line }) => line.time! + props.offsetMs / 1000 > now + 0.8,
    )
    cursor.value = next >= 0 ? next : Math.max(0, candidates.value.length - 1)
  }
  function move(delta: number): void {
    cursor.value = Math.max(0, Math.min(candidates.value.length - 1, cursor.value + delta))
    message.value = ''
  }
  function capture(): void {
    const target = selected.value
    const state = props.getPlaybackState?.()
    if (!expanded.value || !available.value || !target || !state) return
    if (!state.playing || state.seeking) {
      message.value = '请在歌曲正常播放时点击'
      return
    }
    const next = recordCalibrationSample(
      samples.value,
      target.index,
      target.line.time!,
      state.timeSeconds,
    )
    if (!next) {
      message.value = '这句距离当前进度太远，请重新选句'
      return
    }
    samples.value = next
    message.value = ''
    // Move the selection, never the song. Further taps can sample the next lines.
    cursor.value = Math.min(candidates.value.length - 1, cursor.value + 1)
  }
  function apply(): void {
    if (!expanded.value || !available.value || offset.value === null) return
    props.onApply(offset.value)
    expanded.value = false
    samples.value = []
  }
  watch(
    () => [props.context?.trackId, props.context?.source, props.context?.lines, props.offsetMs],
    () => {
      expanded.value = false
      samples.value = []
      message.value = ''
    },
    { flush: 'sync' },
  )
</script>

<template>
  <div class="timing-calibration">
    <button
      class="calibration-toggle"
      type="button"
      :disabled="!available"
      :aria-expanded="expanded"
      @click="toggle"
    >
      听一句校准 <ChevronDown :size="14" :class="{ collapsed: !expanded }" aria-hidden="true" />
    </button>
    <Collapse :expanded="expanded">
      <div class="calibration-content">
        <p class="calibration-hint">选好一句，听到它开始时点击。可连续记录几句后应用。</p>
        <div class="calibration-line">
          <button
            type="button"
            aria-label="选择上一句校准歌词"
            :disabled="cursor <= 0"
            @click="move(-1)"
          >
            <ChevronLeft :size="17" />
          </button>
          <span :title="selected?.line.text">{{ selected?.line.text }}</span>
          <button
            type="button"
            aria-label="选择下一句校准歌词"
            :disabled="cursor >= candidates.length - 1"
            @click="move(1)"
          >
            <ChevronRight :size="17" />
          </button>
        </div>
        <div class="calibration-actions">
          <button
            class="capture-timing"
            type="button"
            :disabled="!playing || !available"
            @click="capture"
          >
            这句现在开始
          </button>
          <button class="apply-timing" type="button" :disabled="offset === null" @click="apply">
            应用校准
          </button>
        </div>
        <p class="calibration-status" role="status">
          {{
            message ||
            (samples.length
              ? `已记录 ${samples.length} 句 · ${suggestion}`
              : '只调整本曲当前歌词源，不改变播放进度')
          }}
        </p>
      </div>
    </Collapse>
  </div>
</template>

<style scoped lang="scss">
  .timing-calibration {
    min-width: 0;
  }
  button {
    min-height: 44px;
    border: 0;
    border-radius: 12px;
    corner-shape: squircle;
    padding: 8px 12px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    transition:
      color 180ms ease,
      background 180ms ease;
  }
  button:hover:not(:disabled) {
    color: var(--text);
    background: rgba(255, 255, 255, 0.07);
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button:focus-visible {
    outline: 2px solid var(--text-muted);
    outline-offset: -2px;
  }
  .calibration-toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-inline: 0;
  }
  .calibration-toggle svg {
    transition: transform 220ms ease;
  }
  .calibration-toggle svg.collapsed {
    transform: rotate(-90deg);
  }
  .calibration-content {
    display: grid;
    gap: 8px;
    padding: 4px 0 8px;
  }
  .calibration-hint,
  .calibration-status {
    margin: 0;
    color: var(--text-subtle);
    font-size: 0.66rem;
    line-height: 1.6;
  }
  .calibration-status {
    min-height: 3.2em;
  }
  .calibration-line {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) 44px;
    align-items: center;
    gap: 4px;
  }
  .calibration-line button {
    display: grid;
    place-items: center;
    padding: 0;
  }
  .calibration-line span {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
    text-align: center;
    color: var(--text);
    font-size: 0.76rem;
    line-height: 1.5;
    min-height: 3em;
    align-content: center;
  }
  .calibration-actions {
    display: flex;
    gap: 6px;
  }
  .calibration-actions button {
    flex: 1;
    background: rgba(255, 255, 255, 0.045);
  }
  @media (prefers-reduced-motion: reduce) {
    button,
    .calibration-toggle svg {
      transition: none;
    }
  }
</style>
