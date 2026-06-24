<script setup lang="ts">
  defineOptions({ inheritAttrs: false })

  defineProps<{ modelValue?: string | number }>()
  defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <input
    class="base-input"
    :value="modelValue"
    v-bind="$attrs"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped lang="scss">
  .base-input {
    flex: 1;
    min-width: 0;
    max-width: 320px;
    padding: 9px 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.25);
    color: #fff;
    font-size: 0.82rem;
    outline: none;
    transition: border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:focus {
      border-color: var(--accent);
    }

    &:disabled {
      opacity: 0.5;
    }
  }
</style>
