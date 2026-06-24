<script setup lang="ts">
  import ErrorBoundary from './components/ErrorBoundary.vue'
</script>

<template>
  <ErrorBoundary>
    <router-view v-slot="{ Component }">
      <Transition name="route-fade" mode="out-in">
        <component :is="Component" />
      </Transition>
    </router-view>
  </ErrorBoundary>
</template>

<style>
  .route-fade-enter-active,
  .route-fade-leave-active {
    transition: opacity 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .route-fade-enter-from,
  .route-fade-leave-to {
    opacity: 0;
  }
</style>
