<script setup lang="ts">
  import { onErrorCaptured, ref } from 'vue'

  const hasError = ref(false)
  const errorMessage = ref('')

  onErrorCaptured((error) => {
    hasError.value = true
    errorMessage.value = error instanceof Error ? error.message : String(error)
    console.error('[ErrorBoundary] 捕获到渲染错误:', error)
    return false
  })

  function retry() {
    hasError.value = false
    errorMessage.value = ''
  }
</script>

<template>
  <slot v-if="!hasError" />
  <div v-else class="error-boundary">
    <div class="error-card">
      <svg
        class="error-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
      >
        <path
          d="M12 9v3.75m0 3.75h.007M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <h2 class="error-title">播放器遇到问题</h2>
      <p class="error-desc">{{ errorMessage || '发生了未知错误' }}</p>
      <button class="error-retry" @click="retry">重试</button>
    </div>
  </div>
</template>

<style scoped lang="scss">
  .error-boundary {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-base, #151318);
    padding: 1.5rem;
  }

  .error-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    max-width: 24rem;
    text-align: center;
  }

  .error-icon {
    width: 3rem;
    height: 3rem;
    color: var(--accent, #81d8d0);
    opacity: 0.8;
  }

  .error-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary, #fff);
  }

  .error-desc {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.5;
    color: var(--text-secondary, rgba(255, 255, 255, 0.6));
    word-break: break-word;
  }

  .error-retry {
    margin-top: 0.5rem;
    padding: 0.5rem 1.5rem;
    border: 1px solid var(--accent, #81d8d0);
    border-radius: 0.5rem;
    background: transparent;
    color: var(--accent, #81d8d0);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition:
      background 0.2s,
      opacity 0.2s;

    &:hover {
      background: color-mix(in srgb, var(--accent, #81d8d0) 12%, transparent);
    }

    &:active {
      opacity: 0.7;
    }
  }
</style>
