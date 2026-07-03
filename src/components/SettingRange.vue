<script setup lang="ts">
  import { computed } from 'vue'

  const props = withDefaults(
    defineProps<{
      modelValue: number
      min: number
      max: number
      step?: number
      disabled?: boolean
      ariaLabel?: string
    }>(),
    { step: 1, disabled: false, ariaLabel: undefined },
  )

  const emit = defineEmits<{ 'update:modelValue': [value: number] }>()

  const progress = computed(() => {
    const range = props.max - props.min
    if (range <= 0) return 0
    return ((props.modelValue - props.min) / range) * 100
  })

  function onInput(event: Event) {
    emit('update:modelValue', Number((event.target as HTMLInputElement).value))
  }
</script>

<template>
  <input
    class="setting-range"
    type="range"
    :min="min"
    :max="max"
    :step="step"
    :value="modelValue"
    :disabled="disabled"
    :aria-label="ariaLabel"
    :style="{ '--setting-progress': `${progress}%` }"
    @input="onInput"
  />
</template>

<style scoped lang="scss">
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

  .setting-range:disabled {
    opacity: 0.4;
  }
</style>
