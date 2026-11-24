<script setup lang="ts">
  import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

  const props = defineProps<{ value: string; wrap?: boolean }>()
  const group = ref<HTMLElement | null>(null)
  const indicator = ref<HTMLElement | null>(null)
  const bounds = ref<{ left: string; right: string; top: string; height: string }>()
  const direction = ref<'left' | 'right' | 'across' | undefined>()
  let observer: ResizeObserver | undefined

  function positionIndicator(animate: boolean): void {
    const root = group.value
    const active = root?.querySelector<HTMLElement>(
      ':scope > button:is([aria-selected="true"], [aria-pressed="true"])',
    )
    if (!root || !active?.offsetWidth) {
      bounds.value = undefined
      direction.value = undefined
      return
    }

    const left = active.offsetLeft
    const right = root.clientWidth - left - active.offsetWidth
    const next = {
      left: left + 'px',
      right: right + 'px',
      top: active.offsetTop + 'px',
      height: active.offsetHeight + 'px',
    }
    const previous = bounds.value
    if (
      previous &&
      previous.left === next.left &&
      previous.right === next.right &&
      previous.top === next.top &&
      previous.height === next.height
    )
      return

    direction.value = undefined
    const block = indicator.value
    if (animate && previous && block) {
      // 连续切换时以仍在移动的色块为起点。
      const center = block.offsetLeft + block.offsetWidth / 2
      direction.value =
        previous.top !== next.top
          ? 'across'
          : left + active.offsetWidth / 2 > center
            ? 'right'
            : 'left'
    }
    bounds.value = next
  }

  onMounted(() => {
    positionIndicator(false)
    if (!group.value || typeof ResizeObserver === 'undefined') return
    observer = new ResizeObserver(() => positionIndicator(false))
    observer.observe(group.value)
    for (const button of group.value.querySelectorAll(':scope > button')) observer.observe(button)
  })
  watch(
    () => props.value,
    () => positionIndicator(true),
    { flush: 'post' },
  )
  onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div ref="group" class="segmented-control" :class="{ wrap }" :data-direction="direction">
    <span ref="indicator" class="indicator" :hidden="!bounds" :style="bounds" aria-hidden="true" />
    <slot />
  </div>
</template>

<style scoped lang="scss">
  .segmented-control {
    position: relative;
    isolation: isolate;
    display: flex;
    flex-shrink: 0;
    gap: 2px;
  }
  .wrap {
    flex-wrap: wrap;
  }
  .indicator {
    position: absolute;
    pointer-events: none;
    border-radius: 9px;
    background: rgba(var(--accent-rgb), 0.2);
    box-shadow: inset 0 0 0 1px rgba(var(--accent-rgb), 0.26);
  }
  .segmented-control :slotted(button) {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 1 1 0;
    gap: 5px;
    min-width: 0;
    min-height: 30px;
    padding: 3px 6px;
    border: 0;
    border-radius: 9px;
    color: var(--text-muted);
    background: transparent;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 550;
    white-space: nowrap;
    cursor: pointer;
  }
  .wrap :slotted(button) {
    flex: 0 0 auto;
  }
  :slotted(button:hover),
  :slotted(button[aria-selected='true']),
  :slotted(button[aria-pressed='true']) {
    color: var(--text);
  }
  :slotted(button:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  @media (prefers-reduced-motion: no-preference) {
    .segmented-control :slotted(button) {
      transition: color 180ms ease;
    }
    [data-direction] > .indicator {
      transition-property: left, right, top, height;
      transition-duration: 300ms;
      transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1);
    }
    [data-direction='right'] > .indicator {
      transition-delay: 65ms, 0ms, 0ms, 0ms;
    }
    [data-direction='left'] > .indicator {
      transition-delay: 0ms, 65ms, 0ms, 0ms;
    }
  }
  @media (pointer: coarse) {
    .segmented-control :slotted(button) {
      min-height: 44px;
    }
    .indicator {
      margin-block: 4px;
      max-height: 36px;
    }
  }
  @media (forced-colors: active) {
    .indicator {
      outline: 2px solid Highlight;
      outline-offset: -2px;
    }
  }
</style>
