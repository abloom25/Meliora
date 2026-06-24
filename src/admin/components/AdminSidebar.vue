<script setup lang="ts">
  import type { MusicConfig } from '../../types/music'
  import {
    BarChart3,
    Disc3,
    LibraryBig,
    Music4,
    ShieldCheck,
    SlidersHorizontal,
    ArrowLeft,
    LogOut,
    Save,
    Info,
  } from '@lucide/vue'

  defineProps<{
    active: string
    config: MusicConfig | null
    saving: boolean
  }>()

  const emit = defineEmits<{
    'update:active': [value: string]
    logout: []
    save: []
    back: []
  }>()

  const tabs = [
    { id: 'site', label: '站点', icon: Disc3 },
    { id: 'playlists', label: '歌单', icon: LibraryBig },
    { id: 'local', label: '本地音乐', icon: Music4 },
    { id: 'analytics', label: '统计', icon: BarChart3 },
    { id: 'advanced', label: '高级', icon: SlidersHorizontal },
    { id: 'security', label: '安全', icon: ShieldCheck },
    { id: 'about', label: '关于', icon: Info },
  ]
</script>

<template>
  <aside class="admin-sidebar">
    <div class="sidebar-header">
      <h1>Meliora</h1>
      <span class="header-sub">管理后台</span>
    </div>

    <nav class="sidebar-nav">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="sidebar-tab"
        :class="{ active: active === tab.id }"
        @click="emit('update:active', tab.id)"
      >
        <component :is="tab.icon" :size="18" />
        <span>{{ tab.label }}</span>
      </button>
    </nav>

    <div class="sidebar-footer">
      <button type="button" class="sidebar-save" :disabled="saving" @click="emit('save')">
        <Save :size="16" />
        <span>{{ saving ? '保存中...' : '保存全部' }}</span>
      </button>
      <button type="button" class="sidebar-action logout" @click="emit('logout')">
        <LogOut :size="15" />
        <span>退出登录</span>
      </button>
      <button type="button" class="sidebar-action" @click="emit('back')">
        <ArrowLeft :size="15" />
        <span>返回播放器</span>
      </button>
    </div>
  </aside>
</template>

<style scoped lang="scss">
  .admin-sidebar {
    flex-shrink: 0;
    width: 200px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    padding: 20px 12px 18px;
    gap: 16px;
  }

  .sidebar-header {
    padding: 0 14px 4px;
    h1 {
      margin: 0;
      color: #fff;
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .header-sub {
      color: var(--text-subtle);
      font-size: 0.7rem;
      font-weight: 540;
    }
  }

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
  }

  .sidebar-tab {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 14px;
    border: none;
    border-radius: 14px;
    background: transparent;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.84rem;
    font-weight: 540;
    cursor: pointer;
    transition:
      background 0.2s cubic-bezier(0.16, 1, 0.3, 1),
      color 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 0.85);
    }

    &.active {
      background: color-mix(in srgb, var(--accent), transparent 84%);
      color: var(--accent);
    }
  }

  .sidebar-footer {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .sidebar-save {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 8px;
    padding: 10px 14px;
    border: none;
    border-radius: 14px;
    background: var(--accent);
    color: #0e0d12;
    font-size: 0.82rem;
    font-weight: 680;
    cursor: pointer;
    transition: filter 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover:not(:disabled) {
      filter: brightness(1.1);
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .sidebar-action {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 9px 14px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    background: transparent;
    color: rgba(255, 255, 255, 0.6);
    font-size: 0.78rem;
    font-weight: 540;
    cursor: pointer;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      background: rgba(255, 255, 255, 0.06);
      color: rgba(255, 255, 255, 0.85);
    }

    &.logout {
      border-color: rgba(255, 139, 139, 0.2);
      color: rgba(255, 139, 139, 0.8);

      &:hover {
        background: rgba(255, 139, 139, 0.08);
        color: #ff8b8b;
      }
    }
  }
</style>
