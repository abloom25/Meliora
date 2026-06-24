<script setup lang="ts">
  import { ref, onMounted, onBeforeUnmount } from 'vue'

  const open = ref(false)
  const rootRef = ref<HTMLElement | null>(null)

  function toggle() {
    open.value = !open.value
  }

  function close() {
    open.value = false
  }

  function handleOutsideClick(e: MouseEvent) {
    if (rootRef.value && !rootRef.value.contains(e.target as Node)) {
      open.value = false
    }
  }

  onMounted(() => document.addEventListener('click', handleOutsideClick))
  onBeforeUnmount(() => document.removeEventListener('click', handleOutsideClick))

  defineExpose({ close })
</script>

<template>
  <div ref="rootRef" class="dropdown">
    <slot name="trigger" :toggle="toggle" :open="open" />
    <Transition name="dropdown">
      <div v-if="open" class="dropdown-menu">
        <slot :close="close" />
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="scss">
  .dropdown {
    position: relative;
    flex-shrink: 0;
  }

  .dropdown-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 50;
    min-width: 120px;
    padding: 5px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    background: rgba(20, 19, 26, 0.96);
    backdrop-filter: blur(22px);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.4);
  }

  .dropdown-enter-active,
  .dropdown-leave-active {
    transition:
      opacity 0.18s cubic-bezier(0.16, 1, 0.3, 1),
      transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .dropdown-enter-from,
  .dropdown-leave-to {
    opacity: 0;
    transform: translateY(-4px);
  }
</style>
