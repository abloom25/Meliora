<script setup lang="ts">
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
    input: [event: Event]
    change: [event: Event]
  }>()

  function onInput(event: Event) {
    emit('input', event)
  }
  function onChange(event: Event) {
    emit('change', event)
  }
</script>

<template>
  <div class="setting-group sleep-setting">
    <label>
      <span><strong>定时关闭</strong></span>
      <strong>{{ minutes ? formatRemaining(remaining) : '关闭' }}</strong>
    </label>
    <input
      class="setting-range sleep-range"
      type="range"
      min="0"
      max="90"
      step="1"
      list="sleep-timer-marks"
      :value="displayMinutes"
      :style="{ '--setting-progress': `${progress}%` }"
      aria-label="定时关闭"
      @input="onInput"
      @change="onChange"
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
  .setting-range {
    display: block;
    width: 100%;
    height: 28px;
    margin-top: 12px;
    padding: 0;
    appearance: none;
    border-radius: 99px;
    background: transparent;
    cursor: pointer;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
  }
  .setting-range::-webkit-slider-runnable-track {
    height: 7px;
    border-radius: 99px;
    background: linear-gradient(
      to right,
      rgba(255, 255, 255, 0.88) 0 var(--setting-progress),
      rgba(255, 255, 255, 0.18) var(--setting-progress) 100%
    );
  }
  .setting-range::-moz-range-track {
    height: 7px;
    border-radius: 99px;
    background: linear-gradient(
      to right,
      rgba(255, 255, 255, 0.88) 0 var(--setting-progress),
      rgba(255, 255, 255, 0.18) var(--setting-progress) 100%
    );
  }
  .setting-range::-webkit-slider-thumb {
    width: 24px;
    height: 24px;
    appearance: none;
    border: 0;
    border-radius: 50%;
    background: transparent;
    margin-top: -8.5px;
    cursor: pointer;
  }
  .setting-range::-moz-range-thumb {
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
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
