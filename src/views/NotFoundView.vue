<script setup lang="ts">
  import { computed } from 'vue'
  import { RouterLink, useRoute } from 'vue-router'
  import { Home } from '@lucide/vue'

  const route = useRoute()
  const missingPath = computed(() => route.fullPath || '/')
</script>

<template>
  <main class="not-found-page" aria-labelledby="not-found-title">
    <section class="not-found-content">
      <p class="status-code">404</p>
      <h1 id="not-found-title">页面不存在</h1>
      <p class="not-found-copy">{{ missingPath }} 没有找到对应内容。</p>
      <RouterLink class="home-action" to="/">
        <Home :size="18" />
        <span>返回播放器</span>
      </RouterLink>
    </section>
  </main>
</template>

<style scoped lang="scss">
  .not-found-page {
    display: grid;
    min-height: 100svh;
    place-items: center;
    padding: 84px 24px 48px;
    background: #0e0d12;
    color: var(--text);
  }

  .not-found-content {
    width: min(440px, 100%);
    text-align: center;
  }

  .status-code {
    margin: 0 0 14px;
    color: var(--accent-soft);
    font-family: var(--display-font);
    font-size: clamp(4rem, 18vw, 7rem);
    font-weight: 760;
    line-height: 0.9;
  }

  .not-found-content h1 {
    margin: 0;
    color: #fff;
    font-family: var(--display-font);
    font-size: clamp(1.7rem, 5vw, 2.8rem);
    font-weight: 740;
    line-height: 1.12;
  }

  .not-found-copy {
    margin: 16px 0 28px;
    color: var(--text-muted);
    font-size: 0.95rem;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }

  .home-action {
    display: inline-flex;
    min-height: 44px;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: 1px solid rgba(255, 255, 255, 0.7);
    border-radius: 999px;
    padding: 0 18px;
    background: rgba(255, 255, 255, 0.9);
    color: rgba(15, 16, 18, 0.94);
    font-size: 0.92rem;
    font-weight: 680;
    text-decoration: none;

    &:hover {
      background: #fff;
    }

    &:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 4px;
    }
  }

  @media (max-width: 720px) {
    .home-action {
      width: 100%;
    }
  }
</style>
