<script setup lang="ts">
  import { onMounted, ref, watch } from 'vue'
  import { resolveLyricWaitingMotion, type LyricWaitingInterval } from '../core/lyrics'

  const props = defineProps<{
    interval: LyricWaitingInterval
    animated: boolean
    paused?: boolean
    secondary?: boolean
    getTime: () => number
  }>()

  const container = ref<HTMLElement>()
  const dots = ref<HTMLElement[]>([])
  let lastOpacity = ''
  let lastScale = ''
  const lastDotOpacities = ['', '', '']

  // 跟随面板已有的播放帧，不创建自己的 RAF；暂停时重复写入同一媒体时间也没有 DOM 开销。
  function write(timeSeconds: number): void {
    const element = container.value
    if (!element?.isConnected) return
    // 尚未开始播放的零时刻也保留可见等待标记；播放后仍从媒体时间开始演出。
    const animated = props.animated && !(props.paused && timeSeconds <= props.interval.start)
    const motion = resolveLyricWaitingMotion(timeSeconds, props.interval, animated)
    const opacity = motion.opacity.toFixed(3)
    const scale = motion.scale.toFixed(4)
    if (opacity !== lastOpacity) {
      element.style.opacity = opacity
      lastOpacity = opacity
    }
    if (scale !== lastScale) {
      element.style.scale = scale
      lastScale = scale
    }
    for (const [index, dot] of dots.value.entries()) {
      if (!dot.isConnected) continue
      const opacity = motion.dotOpacities[index]!.toFixed(3)
      if (opacity !== lastDotOpacities[index]) {
        dot.style.opacity = opacity
        lastDotOpacities[index] = opacity
      }
    }
  }

  onMounted(() => write(props.getTime()))
  watch(
    () => [props.interval, props.animated, props.paused] as const,
    () => write(props.getTime()),
    { flush: 'post' },
  )

  defineExpose({ write })
</script>

<template>
  <span ref="container" class="lyrics-waiting-indicator" :class="{ secondary }" aria-hidden="true">
    <span v-for="dot in 3" :key="dot" ref="dots" class="waiting-dot" />
  </span>
</template>

<style scoped lang="scss">
  .lyrics-waiting-indicator {
    display: inline-flex;
    align-items: center;
    gap: 0.18em;
    height: 0.5em;
    color: inherit;
    line-height: 1;
    opacity: 0;
    transform-origin: left center;
    pointer-events: none;
    user-select: none;

    &.secondary {
      transform-origin: right center;
    }
  }

  .waiting-dot {
    flex: none;
    width: 0.3em;
    height: 0.3em;
    border-radius: 50%;
    background: currentcolor;
    opacity: 0;
  }
</style>
