<script setup lang="ts">
  import { computed, ref } from 'vue'
  import type { MusicConfig } from '../../types/music'
  import { useDrawerSheet } from '../../composables/useDrawerSheet'
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
    Menu,
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

  const menuOpen = ref(false)
  const mobileNavPanelRef = ref<HTMLElement | null>(null)
  const mobileNavHandleRef = ref<HTMLElement | null>(null)

  function getSheetHeight(el: HTMLElement | null): number {
    if (!el) return window.innerHeight
    const height = el.getBoundingClientRect().height
    return height > 0 ? height : window.innerHeight
  }

  function isMobileViewport() {
    return window.matchMedia('(max-width: 760px)').matches
  }

  const {
    detent: mobileNavDetent,
    dragging: mobileNavDragging,
    translateY: mobileNavTranslateY,
    dismissAnimated: dismissMobileNavAnimated,
  } = useDrawerSheet({
    containerRef: mobileNavPanelRef,
    handleRef: mobileNavHandleRef,
    active: menuOpen,
    onDismiss: () => {
      menuOpen.value = false
    },
    sheetHeight: () => getSheetHeight(mobileNavPanelRef.value),
    enabled: isMobileViewport,
  })

  const mobileNavStyle = computed(() => {
    if (!isMobileViewport()) return {}
    return {
      transform: `translateY(${mobileNavTranslateY.value}px)`,
      transition: mobileNavDragging.value ? 'none' : undefined,
    }
  })

  const mobileNavIsHalf = computed(() => mobileNavDetent.value === 'half')

  function selectTab(tabId: string) {
    emit('update:active', tabId)
    closeMobileNavAnimated()
  }

  function emitAndClose(action: 'save' | 'logout' | 'back') {
    if (action === 'save') emit('save')
    else if (action === 'logout') emit('logout')
    else if (action === 'back') emit('back')
    closeMobileNavAnimated()
  }

  function closeMobileNavAnimated() {
    if (isMobileViewport()) {
      dismissMobileNavAnimated()
      return
    }
    menuOpen.value = false
  }

  function toggleMobileNav() {
    if (menuOpen.value) {
      closeMobileNavAnimated()
      return
    }
    menuOpen.value = true
  }

  function onSidebarClick(event: MouseEvent) {
    if (!menuOpen.value || !isMobileViewport()) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, [role="button"], input, label')) return
    closeMobileNavAnimated()
  }
</script>

<template>
  <aside class="admin-sidebar" @click="onSidebarClick">
    <div class="sidebar-header">
      <h1>Meliora</h1>
      <span class="header-sub">管理后台</span>
    </div>

    <button
      type="button"
      class="sidebar-menu-toggle"
      :aria-expanded="menuOpen"
      :aria-label="menuOpen ? '关闭管理导航' : '打开管理导航'"
      @click="toggleMobileNav"
    >
      <Menu :size="20" />
    </button>

    <nav class="sidebar-nav desktop-nav">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="sidebar-tab"
        :class="{ active: active === tab.id }"
        @click="selectTab(tab.id)"
      >
        <component :is="tab.icon" :size="18" />
        <span>{{ tab.label }}</span>
      </button>
    </nav>

    <Teleport to="body">
      <Transition name="mobile-nav-backdrop">
        <div
          v-if="menuOpen"
          class="mobile-nav-backdrop"
          :class="{ 'is-half': mobileNavIsHalf }"
          @click="closeMobileNavAnimated"
        />
      </Transition>

      <Transition name="mobile-nav-sheet">
        <aside
          v-if="menuOpen"
          ref="mobileNavPanelRef"
          class="mobile-nav-panel"
          :class="{ 'is-dragging': mobileNavDragging }"
          :style="mobileNavStyle"
          role="dialog"
          aria-modal="true"
          aria-label="管理导航"
        >
          <span
            ref="mobileNavHandleRef"
            class="drawer-grab-handle"
            aria-hidden="true"
            role="presentation"
          />

          <div class="mobile-nav-head">
            <span>管理导航</span>
          </div>

          <nav class="sidebar-nav">
            <button
              v-for="tab in tabs"
              :key="tab.id"
              type="button"
              class="sidebar-tab"
              :class="{ active: active === tab.id }"
              @click="selectTab(tab.id)"
            >
              <component :is="tab.icon" :size="18" />
              <span>{{ tab.label }}</span>
            </button>
          </nav>

          <div class="sidebar-footer">
            <button
              type="button"
              class="sidebar-save"
              :disabled="saving"
              @click="emitAndClose('save')"
            >
              <Save :size="16" />
              <span>{{ saving ? '保存中...' : '保存全部' }}</span>
            </button>
            <button type="button" class="sidebar-action logout" @click="emitAndClose('logout')">
              <LogOut :size="15" />
              <span>退出登录</span>
            </button>
            <button type="button" class="sidebar-action" @click="emitAndClose('back')">
              <ArrowLeft :size="15" />
              <span>返回播放器</span>
            </button>
          </div>
        </aside>
      </Transition>
    </Teleport>

    <div class="sidebar-footer desktop-footer">
      <button type="button" class="sidebar-save" :disabled="saving" @click="emitAndClose('save')">
        <Save :size="16" />
        <span>{{ saving ? '保存中...' : '保存全部' }}</span>
      </button>
      <button type="button" class="sidebar-action logout" @click="emitAndClose('logout')">
        <LogOut :size="15" />
        <span>退出登录</span>
      </button>
      <button type="button" class="sidebar-action" @click="emitAndClose('back')">
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

  .sidebar-menu-toggle,
  .mobile-nav-backdrop,
  .mobile-nav-panel {
    display: none;
  }

  @media (max-width: 760px) {
    .admin-sidebar {
      --admin-mobile-nav-top: calc(58px + env(safe-area-inset-top));

      position: sticky;
      top: 0;
      z-index: 80;
      width: 100%;
      max-width: 100vw;
      flex: 0 0 auto;
      display: flex;
      min-height: var(--admin-mobile-nav-top);
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: max(9px, env(safe-area-inset-top)) 12px 9px;
      border-right: 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(14, 13, 18, 0.92);
      backdrop-filter: blur(24px) saturate(160%);
    }

    .sidebar-header {
      min-width: 0;
      padding: 0;

      h1 {
        overflow: hidden;
        font-size: 1rem;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .header-sub {
        font-size: 0.64rem;
      }
    }

    .desktop-nav,
    .desktop-footer {
      display: none;
    }

    .sidebar-menu-toggle {
      display: inline-flex;
      width: 40px;
      height: 40px;
      flex: 0 0 auto;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 13px;
      background: rgba(255, 255, 255, 0.07);
      color: rgba(255, 255, 255, 0.86);
      cursor: pointer;
      transition:
        background 0.18s cubic-bezier(0.16, 1, 0.3, 1),
        border-color 0.18s cubic-bezier(0.16, 1, 0.3, 1);

      &:hover {
        background: rgba(255, 255, 255, 0.12);
        border-color: rgba(255, 255, 255, 0.2);
      }
    }

    .mobile-nav-backdrop {
      position: fixed;
      inset: var(--admin-mobile-nav-top, calc(58px + env(safe-area-inset-top))) 0 0;
      z-index: 70;
      display: block;
      background: rgba(0, 0, 0, 0.08);
      transition:
        inset 280ms cubic-bezier(0.16, 1, 0.3, 1),
        background 280ms ease;
      backdrop-filter: blur(22px) saturate(155%);
      -webkit-backdrop-filter: blur(22px) saturate(155%);
    }

    .mobile-nav-backdrop.is-half {
      inset: 0;
      background: rgba(0, 0, 0, 0.32);
    }

    .mobile-nav-panel {
      position: fixed;
      top: calc(var(--admin-mobile-nav-top, calc(58px + env(safe-area-inset-top))) + 8px);
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 72;
      display: flex;
      width: 100vw;
      height: auto;
      max-height: none;
      flex-direction: column;
      gap: 12px;
      overflow: hidden;
      padding: 27px 15px max(15px, env(safe-area-inset-bottom));
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-bottom: 0;
      border-radius: clamp(26px, 7.5vw, 34px) clamp(26px, 7.5vw, 34px) 0 0;
      background: linear-gradient(145deg, rgba(58, 57, 64, 0.7), rgba(22, 22, 26, 0.6));
      box-shadow: 0 -18px 64px rgba(0, 0, 0, 0.34);
      backdrop-filter: blur(52px) saturate(180%);
      -webkit-backdrop-filter: blur(52px) saturate(180%);
      transition:
        transform 320ms cubic-bezier(0.16, 1, 0.3, 1),
        opacity 320ms cubic-bezier(0.16, 1, 0.3, 1);
    }

    .mobile-nav-panel.is-dragging {
      transition: none !important;
    }

    .drawer-grab-handle {
      position: absolute;
      top: 7px;
      right: 0;
      left: 0;
      z-index: 4;
      display: block;
      height: 18px;
      padding: 7px 0;
      background: transparent;
      cursor: grab;
      touch-action: none;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }

    .drawer-grab-handle::before {
      content: '';
      display: block;
      width: 38px;
      height: 4px;
      margin: 0 auto;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.32);
      transition:
        background 160ms ease,
        width 160ms ease;
    }

    .drawer-grab-handle:active {
      cursor: grabbing;
    }

    .drawer-grab-handle:active::before {
      width: 44px;
      background: rgba(255, 255, 255, 0.6);
    }

    .mobile-nav-head {
      display: flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 0 2px;
      color: rgba(255, 255, 255, 0.88);
      font-size: 0.92rem;
      font-weight: 680;
    }

    .mobile-nav-panel .sidebar-nav {
      display: grid;
      min-height: 0;
      flex: 1;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-content: start;
      gap: 8px;
      overflow-y: auto;
      padding: 2px 1px;
      scrollbar-width: none;

      &::-webkit-scrollbar {
        display: none;
      }
    }

    .mobile-nav-panel .sidebar-tab {
      flex: 0 0 auto;
      width: 100%;
      gap: 10px;
      min-height: 48px;
      padding: 12px 13px;
      border-radius: 16px;
      font-size: 0.85rem;
    }

    .mobile-nav-panel .sidebar-footer {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }

    .mobile-nav-panel .sidebar-save {
      grid-column: 1 / -1;
    }

    .mobile-nav-panel .sidebar-save,
    .mobile-nav-panel .sidebar-action {
      width: 100%;
      min-height: 42px;
      justify-content: center;
    }

    .mobile-nav-backdrop-enter-active,
    .mobile-nav-backdrop-leave-active {
      transition: opacity 0.22s ease;
    }

    .mobile-nav-backdrop-enter-from,
    .mobile-nav-backdrop-leave-to {
      opacity: 0;
    }

    .mobile-nav-sheet-enter-active,
    .mobile-nav-sheet-leave-active {
      transition:
        opacity 0.24s ease,
        transform 0.3s cubic-bezier(0.2, 0.82, 0.22, 1);
    }

    .mobile-nav-sheet-enter-from,
    .mobile-nav-sheet-leave-to {
      opacity: 0;
      transform: translateY(36px) scale(0.98);
    }
  }

  @media (max-width: 420px) {
    .mobile-nav-backdrop {
      inset: var(--admin-mobile-nav-top, calc(58px + env(safe-area-inset-top))) 0 0;
    }

    .mobile-nav-panel {
      padding: 27px 12px max(12px, env(safe-area-inset-bottom));
    }

    .mobile-nav-panel .sidebar-tab {
      min-height: 46px;
      padding: 11px 12px;
      font-size: 0.82rem;
    }
  }
</style>
