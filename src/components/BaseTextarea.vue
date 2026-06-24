<script setup lang="ts">
  defineOptions({ inheritAttrs: false })

  defineProps<{ modelValue?: string }>()
  defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <textarea
    class="base-textarea"
    :value="modelValue"
    v-bind="$attrs"
    @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  />
</template>

<style scoped lang="scss">
  .base-textarea {
    width: 100%;
    min-height: 180px;
    resize: vertical;
    padding: 12px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 12px;
    background: rgba(0, 0, 0, 0.25);
    color: #fff;
    font-size: 0.82rem;
    font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, Courier, monospace;
    line-height: 1.55;
    outline: none;
    transition: border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:focus {
      border-color: var(--accent);
    }
  }
</style>
