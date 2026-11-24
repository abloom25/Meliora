<script setup lang="ts">
  import SegmentedControl from './SegmentedControl.vue'
  import { computed, ref, useId } from 'vue'

  const tabs = [
    { id: 'playback', label: '播放' },
    { id: 'lyrics', label: '歌词' },
    { id: 'appearance', label: '外观' },
    { id: 'more', label: '更多' },
  ] as const
  type TabId = (typeof tabs)[number]['id']
  const active = ref<TabId>('playback')
  const visited = ref(new Set<TabId>([active.value]))
  const activeIndex = computed(() => tabs.findIndex((tab) => tab.id === active.value))
  const id = useId()

  function selectTab(tab: TabId): void {
    visited.value.add(tab)
    active.value = tab
  }

  function navigate(event: KeyboardEvent, index: number): void {
    const positions: Record<string, number> = {
      ArrowRight: (index + 1) % tabs.length,
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1,
    }
    const target = tabs[positions[event.key] ?? -1]
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    selectTab(target.id)
    document.getElementById(`${id}-tab-${target.id}`)?.focus()
  }
</script>

<template>
  <SegmentedControl :value="active" role="tablist" aria-label="设置分类">
    <button
      v-for="(tab, index) in tabs"
      :id="`${id}-tab-${tab.id}`"
      :key="tab.id"
      role="tab"
      type="button"
      :aria-selected="active === tab.id"
      :tabindex="active === tab.id ? 0 : -1"
      :aria-controls="`${id}-panel-${tab.id}`"
      @click="selectTab(tab.id)"
      @keydown="navigate($event, index)"
    >
      {{ tab.label }}
    </button>
  </SegmentedControl>
  <div class="settings-pages">
    <div
      v-for="(tab, index) in tabs"
      :id="`${id}-panel-${tab.id}`"
      :key="tab.id"
      :inert="active !== tab.id"
      :aria-hidden="active !== tab.id"
      role="tabpanel"
      :aria-labelledby="`${id}-tab-${tab.id}`"
      class="settings-scroll"
      :class="{ 'before-active': index < activeIndex }"
      tabindex="0"
    >
      <slot :name="tab.id" :active="active === tab.id" :visited="visited.has(tab.id)" />
    </div>
  </div>
</template>

<style scoped lang="scss">
  .settings-pages {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow: clip;
  }
  .settings-scroll:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .settings-scroll {
    --fade-top: 24px;
    --fade-bottom: 34px;
    position: absolute;
    inset: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 0 2px max(var(--fade-bottom), env(safe-area-inset-bottom));
    mask-image: linear-gradient(
      to bottom,
      transparent,
      #000 var(--fade-top),
      #000 calc(100% - var(--fade-bottom)),
      transparent
    );
    scrollbar-width: none;
  }
  .settings-scroll[aria-hidden='true'] {
    visibility: hidden;
    opacity: 0;
  }
  @media (prefers-reduced-motion: no-preference) {
    .settings-scroll {
      transition:
        transform 280ms cubic-bezier(0.22, 1, 0.36, 1),
        opacity 200ms ease,
        visibility 0s;
    }
    .settings-scroll[aria-hidden='true'] {
      transform: translateX(36px);
      transition-delay: 0s, 0s, 200ms;
    }
    .settings-scroll.before-active {
      transform: translateX(-36px);
    }
  }
  @media (max-width: 720px) {
    .settings-scroll {
      --fade-top: 18px;
      --fade-bottom: 72px;
    }
  }
</style>
