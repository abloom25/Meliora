<script setup lang="ts">
  withDefaults(
    defineProps<{
      loading?: boolean
      valueKey?: string
      loadingLabel?: string
    }>(),
    { loading: false, valueKey: '', loadingLabel: '正在加载歌曲信息' },
  )

  function showValue(element: Element) {
    element.removeAttribute('aria-hidden')
  }

  function hideValue(element: Element) {
    element.setAttribute('aria-hidden', 'true')
  }
</script>

<template>
  <span class="song-info-value" :aria-busy="loading">
    <Transition
      name="song-info-change"
      @before-enter="showValue"
      @before-leave="hideValue"
      @leave-cancelled="showValue"
    >
      <span v-if="loading" key="loading" class="song-info-value-state">
        <span class="song-info-placeholder" aria-hidden="true" />
        <span class="sr-only">{{ loadingLabel }}</span>
      </span>
      <span v-else :key="`value:${valueKey}`" class="song-info-value-state">
        <slot />
      </span>
    </Transition>
  </span>
</template>

<style scoped lang="scss">
  .song-info-value {
    display: grid;
    align-items: center;
    inline-size: 100%;
    block-size: 100%;
    min-inline-size: 0;
  }
  .song-info-value-state {
    display: block;
    grid-area: 1 / 1;
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .song-info-placeholder {
    display: inline-block;
    inline-size: var(--song-info-placeholder-width, 6em);
    max-inline-size: 100%;
    block-size: var(--song-info-placeholder-height, 0.8em);
    border-radius: 5px;
    background: rgba(255, 255, 255, 0.13);
    vertical-align: middle;
    animation: song-info-pulse 1.4s ease-in-out infinite;
  }
  .song-info-change-enter-active {
    transition: opacity 300ms ease-out;
  }
  .song-info-change-leave-active {
    transition: opacity 180ms ease-in;
    pointer-events: none;
  }
  .song-info-change-enter-from,
  .song-info-change-leave-to {
    opacity: 0;
  }
  @keyframes song-info-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 0.85;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .song-info-placeholder {
      animation: none;
    }
    .song-info-change-enter-active,
    .song-info-change-leave-active {
      transition: none;
    }
  }
</style>
