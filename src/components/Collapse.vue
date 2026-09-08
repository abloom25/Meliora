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
      <!-- 折叠后高度为 0 但内容仍在文档流里,不加 inert 的话 Tab 会停进看不见的控件。
           inert 是布尔属性,写成 false 一样会生效,展开时必须整个移除而不是置 false -->
      <div class="collapse-body" :inert="expanded ? undefined : true">
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
