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
    FileJson,
    PanelLeftClose,
    PanelLeftOpen,
  } from '@lucide/vue'

  const SIDEBAR_COLLAPSED_KEY = 'meliora:admin-sidebar-collapsed'

  const props = defineProps<{
    active: string
    config: MusicConfig | null
    saving: boolean
    saveDisabled?: boolean
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
    { id: 'transfer', label: '迁移', icon: FileJson },
    { id: 'about', label: '关于', icon: Info },
  ]

  const menuOpen = ref(false)
  const pendingMobileAction = ref<'save' | 'logout' | 'back' | null>(null)
  const desktopCollapsed = ref(loadDesktopCollapsed())
  const mobileNavPanelRef = ref<HTMLElement | null>(null)
  const mobileNavHandleRef = ref<HTMLElement | null>(null)

  function loadDesktopCollapsed(): boolean {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
    } catch {
      return false
    }
  }

  function persistDesktopCollapsed(value: boolean) {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value))
    } catch {
      // localStorage can be unavailable in privacy modes; the UI still works for this session.
    }
  }

  function getSheetHeight(el: HTMLElement | null): number {
    if (!el) return window.innerHeight
    const height = el.getBoundingClientRect().height
    return height > 0 ? height : window.innerHeight
  }

  function getSheetHalfOffset(el: HTMLElement | null): number {
    if (!el) return window.innerHeight * 0.5
    const rect = el.getBoundingClientRect()
    const visibleHeight = window.innerHeight - rect.top
    return (visibleHeight > 0 ? visibleHeight : window.innerHeight) * 0.5
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
      const action = pendingMobileAction.value
      pendingMobileAction.value = null
      if (action) emitAction(action)
    },
    sheetHeight: () => getSheetHeight(mobileNavPanelRef.value),
    halfOffset: () => getSheetHalfOffset(mobileNavPanelRef.value),
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
  const saveLabel = computed(() => {
    if (props.saving) return '保存中...'
    if (props.saveDisabled) return '暂存文件中...'
    return '保存全部'
  })

  function selectTab(tabId: string) {
    emit('update:active', tabId)
    closeMobileNavAnimated()
  }

  function emitAction(action: 'save' | 'logout' | 'back') {
    if (action === 'save') emit('save')
    else if (action === 'logout') emit('logout')
    else if (action === 'back') emit('back')
  }

  function emitAndClose(action: 'save' | 'logout' | 'back') {
    if (menuOpen.value && isMobileViewport()) {
      pendingMobileAction.value = action
      dismissMobileNavAnimated()
      return
    }
    emitAction(action)
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

  function toggleDesktopCollapse() {
    desktopCollapsed.value = !desktopCollapsed.value
    persistDesktopCollapsed(desktopCollapsed.value)
  }

  function onSidebarClick(event: MouseEvent) {
    if (!menuOpen.value || !isMobileViewport()) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, [role="button"], input, label')) return
    closeMobileNavAnimated()
  }
</script>

<template>
  <aside class="admin-sidebar" :class="{ collapsed: desktopCollapsed }" @click="onSidebarClick">
    <div class="sidebar-header">
      <div class="sidebar-brand">
        <h1>Meliora</h1>
        <span class="header-sub">管理后台</span>
      </div>
      <button
        type="button"
        class="sidebar-collapse-toggle"
        :aria-label="desktopCollapsed ? '展开管理导航' : '折叠管理导航'"
        :title="desktopCollapsed ? '展开导航' : '折叠导航'"
        @click="toggleDesktopCollapse"
      >
        <PanelLeftOpen v-if="desktopCollapsed" :size="17" />
        <PanelLeftClose v-else :size="17" />
      </button>
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
        :title="desktopCollapsed ? tab.label : undefined"
        @click="selectTab(tab.id)"
      >
        <component :is="tab.icon" :size="18" />
        <span class="sidebar-label">{{ tab.label }}</span>
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
              <span class="sidebar-label">{{ tab.label }}</span>
            </button>
          </nav>

          <div class="sidebar-footer">
            <button
              type="button"
              class="sidebar-save"
              :disabled="saving || saveDisabled"
              @click="emitAndClose('save')"
            >
              <Save :size="16" />
              <span class="sidebar-label">{{ saveLabel }}</span>
            </button>
            <button type="button" class="sidebar-action logout" @click="emitAndClose('logout')">
              <LogOut :size="15" />
              <span class="sidebar-label">退出登录</span>
            </button>
            <button type="button" class="sidebar-action" @click="emitAndClose('back')">
              <ArrowLeft :size="15" />
              <span class="sidebar-label">返回播放器</span>
            </button>
          </div>
        </aside>
      </Transition>
    </Teleport>

    <div class="sidebar-footer desktop-footer">
      <button
        type="button"
        class="sidebar-save"
        :disabled="saving || saveDisabled"
        :title="desktopCollapsed ? saveLabel : undefined"
        @click="emitAndClose('save')"
      >
        <Save :size="16" />
        <span class="sidebar-label">{{ saveLabel }}</span>
      </button>
      <button
        type="button"
        class="sidebar-action logout"
        :title="desktopCollapsed ? '退出登录' : undefined"
        @click="emitAndClose('logout')"
      >
        <LogOut :size="15" />
        <span class="sidebar-label">退出登录</span>
      </button>
      <button
        type="button"
        class="sidebar-action"
        :title="desktopCollapsed ? '返回播放器' : undefined"
        @click="emitAndClose('back')"
      >
        <ArrowLeft :size="15" />
        <span class="sidebar-label">返回播放器</span>
      </button>
    </div>
  </aside>
</template>

<style scoped lang="scss">
  .admin-sidebar {
    --sidebar-icon-track: 44px;
    --sidebar-collapse-size: 32px;

    flex-shrink: 0;
    width: 200px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    padding: 20px 12px 18px;
    gap: 16px;
    transition:
      width 0.22s cubic-bezier(0.16, 1, 0.3, 1),
      padding 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .sidebar-header {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--sidebar-icon-track);
    align-items: start;
    gap: 8px;
    padding: 0 0 4px 14px;
  }

  .sidebar-brand {
    min-width: 0;
    overflow: hidden;
    transition:
      opacity 0.12s ease,
      width 0.12s ease;

    h1 {
      margin: 0;
      color: #fff;
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      white-space: nowrap;
    }
  }

  .header-sub {
    display: block;
    color: var(--text-subtle);
    font-size: 0.7rem;
    font-weight: 540;
    white-space: nowrap;
  }

  .sidebar-collapse-toggle {
    display: inline-flex;
    width: var(--sidebar-collapse-size);
    height: var(--sidebar-collapse-size);
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    justify-self: center;
    margin-top: 1px;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.055);
    color: rgba(255, 255, 255, 0.62);
    cursor: pointer;
    transition:
      background 0.18s cubic-bezier(0.16, 1, 0.3, 1),
      border-color 0.18s cubic-bezier(0.16, 1, 0.3, 1),
      color 0.18s cubic-bezier(0.16, 1, 0.3, 1);

    &:hover {
      border-color: rgba(255, 255, 255, 0.18);
      background: rgba(255, 255, 255, 0.09);
      color: rgba(255, 255, 255, 0.86);
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
    min-width: 0;
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

  .sidebar-tab > svg,
  .sidebar-save > svg,
  .sidebar-action > svg {
    flex: 0 0 auto;
  }

  .sidebar-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: clip;
    white-space: nowrap;
    transition:
      opacity 0.12s ease,
      width 0.12s ease;
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
    min-width: 0;
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
    min-width: 0;
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

  .admin-sidebar.collapsed {
    width: 72px;
    padding-right: 14px;
    padding-left: 14px;

    .sidebar-header {
      padding: 0 0 4px;
      grid-template-columns: var(--sidebar-icon-track);
    }

    .sidebar-brand,
    .sidebar-label {
      width: 0;
      opacity: 0;
      overflow: hidden;
      pointer-events: none;
      white-space: nowrap;
      transition-duration: 0ms;
    }

    .sidebar-brand {
      display: none;
    }

    .sidebar-tab,
    .sidebar-save,
    .sidebar-action {
      justify-content: center;
      gap: 0;
      width: 100%;
      padding-right: 0;
      padding-left: 0;
    }
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

    .admin-sidebar.collapsed {
      width: 100%;
      padding: max(9px, env(safe-area-inset-top)) 12px 9px;

      .sidebar-header {
        justify-content: flex-start;
      }

      .sidebar-brand,
      .sidebar-label {
        display: block;
        width: auto;
        opacity: 1;
        overflow: visible;
        pointer-events: auto;
      }
    }

    .sidebar-header {
      min-width: 0;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: flex-start;

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

    .sidebar-collapse-toggle {
      display: none;
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
      z-index: 88;
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
      --admin-mobile-nav-extension: calc(240px + env(safe-area-inset-bottom));
      position: fixed;
      top: calc(var(--admin-mobile-nav-top, calc(58px + env(safe-area-inset-top))) + 8px);
      right: 0;
      bottom: calc(-1 * var(--admin-mobile-nav-extension));
      left: 0;
      z-index: 90;
      display: flex;
      box-sizing: border-box;
      width: 100vw;
      height: auto;
      max-height: none;
      flex-direction: column;
      gap: 12px;
      overflow: visible;
      padding: 27px 30px
        calc(max(15px, env(safe-area-inset-bottom)) + var(--admin-mobile-nav-extension));
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
      flex: 1 1 auto;
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
      display: flex;
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
      display: flex;
      width: 100%;
      min-height: 42px;
      justify-content: center;
      gap: 8px;
      padding: 0 12px;
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
      padding: 27px 24px
        calc(max(12px, env(safe-area-inset-bottom)) + var(--admin-mobile-nav-extension));
    }

    .mobile-nav-panel .sidebar-tab {
      min-height: 46px;
      padding: 11px 12px;
      font-size: 0.82rem;
    }
  }
</style>
