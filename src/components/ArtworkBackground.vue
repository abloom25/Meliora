<script setup lang="ts">
  import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { loadBackgroundImage, renderBackground } from '../platform/web/artwork-background'

  const props = defineProps<{ cover: string; blur: number; saturation: number }>()
  const host = ref<HTMLElement | null>(null)
  const base = ref<HTMLCanvasElement | null>(null)
  const bright = ref<HTMLCanvasElement | null>(null)
  const ready = ref(false)
  let image: HTMLImageElement | null = null
  let load: AbortController | null = null
  let draw: AbortController | null = null
  let observer: ResizeObserver | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function schedule() {
    draw?.abort()
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (disposed || !image || !host.value || !base.value || !bright.value) return
      const controller = new AbortController()
      draw = controller
      void renderBackground(
        image,
        [base.value, bright.value],
        {
          width: host.value.clientWidth,
          height: host.value.clientHeight,
          blur: props.blur,
          saturation: props.saturation,
        },
        controller.signal,
      )
        .then((rendered) => {
          if (!controller.signal.aborted) ready.value = rendered
        })
        .catch(() => {
          if (!controller.signal.aborted) ready.value = false
        })
    }, 150)
  }

  async function updateCover() {
    load?.abort()
    draw?.abort()
    image = null
    ready.value = false
    const controller = new AbortController()
    load = controller
    const next = await loadBackgroundImage(props.cover, controller.signal)
    if (controller.signal.aborted || disposed) return
    image = next
    schedule()
  }

  watch(() => props.cover, updateCover)
  watch(() => [props.blur, props.saturation], schedule)
  onMounted(() => {
    void updateCover()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(schedule)
      if (host.value) observer.observe(host.value)
    } else window.addEventListener('resize', schedule)
  })
  onBeforeUnmount(() => {
    disposed = true
    load?.abort()
    draw?.abort()
    observer?.disconnect()
    window.removeEventListener('resize', schedule)
    clearTimeout(timer)
    image = null
  })
</script>

<template>
  <div ref="host" class="artwork-canvas" :class="{ 'canvas-ready': ready }" aria-hidden="true">
    <canvas ref="base" class="artwork-base" />
    <canvas ref="bright" class="artwork-bright" />
  </div>
</template>

<style scoped lang="scss">
  .artwork-canvas {
    position: absolute;
    inset: 0;
  }
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    visibility: hidden;
  }
  .canvas-ready canvas {
    visibility: visible;
  }
  .artwork-base {
    opacity: var(--artwork-base-opacity, 0.72);
  }
  .artwork-bright {
    opacity: calc(var(--beat-level, 0) * var(--beat-brightness, 0));
    display: var(--artwork-bright-display, block);
    will-change: var(--artwork-will-change, auto);
  }
</style>
