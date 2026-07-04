<script setup lang="ts">
  import SettingRange from './SettingRange.vue'

  interface Props {
    minutes: number
    remaining: number
    displayMinutes: number
    progress: number
    options: readonly number[]
    formatRemaining: (value: number) => string
  }
  defineProps<Props>()
  const emit = defineEmits<{
    input: [value: number]
    change: [value: number]
  }>()
</script>

<template>
  <div class="setting-group sleep-setting">
    <label>
      <span><strong>定时关闭</strong></span>
      <strong>{{ minutes ? formatRemaining(remaining) : '关闭' }}</strong>
    </label>
    <SettingRange
      class="sleep-range"
      :model-value="displayMinutes"
      :min="0"
      :max="90"
      :step="1"
      aria-label="定时关闭"
      :aria-value-text="displayMinutes ? `${Math.round(displayMinutes)} 分钟` : '关闭'"
      @update:model-value="emit('input', $event)"
      @change="emit('change', $event)"
    />
    <datalist id="sleep-timer-marks">
      <option v-for="mark in options" :key="mark" :value="mark" />
    </datalist>
    <div class="sleep-ticks" aria-hidden="true">
      <span
        v-for="mark in options"
        :key="mark"
        :class="{ active: minutes === mark }"
        :style="{ '--tick-position': `${(mark / 90) * 100}%` }"
      >
        {{ mark || '关' }}
      </span>
    </div>
  </div>
</template>

<style scoped lang="scss">
  .setting-group {
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }
  .setting-group label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }
  .setting-group label > span {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 7px;
  }
  .setting-group strong {
    color: #fff;
    font-size: 0.8rem;
    font-weight: 560;
  }
  .sleep-setting label {
    margin-bottom: 13px;
  }
  .sleep-range {
    margin-top: 0;
  }
  .sleep-ticks {
    position: relative;
    height: 15px;
    margin-top: 10px;
    color: rgba(255, 255, 255, 0.38);
    font-size: 0.62rem;
    font-weight: 560;
    font-variant-numeric: tabular-nums;
  }
  .sleep-ticks span {
    position: absolute;
    left: var(--tick-position);
    min-width: 24px;
    text-align: center;
    transform: translateX(-50%);
    transition: color 0.18s ease;
  }
  .sleep-ticks span:first-child {
    min-width: auto;
    text-align: left;
    transform: none;
  }
  .sleep-ticks span:last-child {
    min-width: auto;
    text-align: right;
    transform: translateX(-100%);
  }
  .sleep-ticks span.active {
    color: rgba(255, 255, 255, 0.9);
  }
</style>
