<script setup lang="ts">
  const props = defineProps<{ expanded: boolean }>()
  const emit = defineEmits<{ 'update:expanded': [value: boolean] }>()

  function toggle() {
    emit('update:expanded', !props.expanded)
  }
</script>

<template>
  <div class="collapse">
    <slot name="trigger" :toggle="toggle" :expanded="expanded" />
    <div class="collapse-wrapper" :class="{ expanded }">
      <div class="collapse-body">
        <slot />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
  .collapse-wrapper {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows 0.3s cubic-bezier(0.16, 1, 0.3, 1);

    &.expanded {
      grid-template-rows: 1fr;
    }
  }

  .collapse-body {
    min-height: 0;
    overflow: hidden;
    opacity: 0;
    transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1) 0.05s;

    .collapse-wrapper.expanded & {
      opacity: 1;
    }
  }
</style>
