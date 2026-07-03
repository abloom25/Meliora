<script setup lang="ts">
  defineProps<{
    modelValue: boolean
    ariaLabel?: string
  }>()
  defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <label class="toggle-switch">
    <input
      type="checkbox"
      :checked="modelValue"
      :aria-label="ariaLabel"
      @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <i />
  </label>
</template>

<style scoped lang="scss">
  .toggle-switch {
    position: relative;
    cursor: pointer;
    flex-shrink: 0;
    display: inline-flex;
  }

  .toggle-switch input {
    position: absolute;
    opacity: 0;
  }

  .toggle-switch i {
    position: relative;
    width: 42px;
    height: 24px;
    flex: 0 0 auto;
    border-radius: 20px;
    background: rgba(255, 255, 255, 0.16);
    transition: background 0.18s ease;

    &::after {
      position: absolute;
      top: 3px;
      left: 3px;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #fff;
      content: '';
      transition: transform 0.18s ease;
    }
  }

  .toggle-switch input:checked + i {
    background: color-mix(in srgb, var(--accent) 64%, rgba(255, 255, 255, 0.18));
  }

  .toggle-switch input:checked + i::after {
    transform: translateX(18px);
  }
</style>
