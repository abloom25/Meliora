<script setup lang="ts">
  import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
  import { storeToRefs } from 'pinia'
  import {
    ArrowRight,
    ListMusic,
    MessageSquareText,
    Music,
    Repeat1,
    Repeat2,
    Settings,
    Share2,
    Shuffle,
  } from '@lucide/vue'
  import { musicConfig } from '../config/music'
  import { hasTrackLyricsSource } from '../services/lyrics'
  import { loadConfiguredTracks, loadMusicConfig } from '../services/music'
  import { usePlayerStore } from '../stores/player'
  import { filterTracks, trackMatchesShareId } from '../utils/tracks'
  import { applySiteIntegrations } from '../utils/site-integrations'
  import { extractThemeColor, type ThemeColor } from '../utils/theme'
  import { isInteractiveElement } from '../utils/dom'
  import { useAudioPlayer } from '../composables/useAudioPlayer'
  import { useLyricsWindow } from '../composables/useLyricsWindow'
  import { usePwaInstall } from '../composables/usePwaInstall'
  import { useSleepTimer } from '../composables/useSleepTimer'
  import { useThemeAccent } from '../composables/useThemeAccent'
  import { useFullscreen } from '../composables/useFullscreen'
  import { useChromeAutoHide } from '../composables/useChromeAutoHide'
  import { useTrackShare } from '../composables/useTrackShare'
  import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts'
  import { useCoverCache } from '../composables/useCoverCache'
  import { useFocusTrap } from '../composables/useFocusTrap'
  import { useDrawerSheet } from '../composables/useDrawerSheet'
  import { useHaptic } from '../composables/useHaptic'
  import { useDeviceDetection } from '../composables/useDeviceDetection'
  import LyricsPanel from '../components/LyricsPanel.vue'
  import PlayerControls from '../components/PlayerControls.vue'
  import SettingsPanel from '../components/SettingsPanel.vue'
  import TrackList from '../components/TrackList.vue'
  import Toast from '../components/Toast.vue'
  import type { LyricAvailability, LyricsSnapshot, PublicMusicConfig, Track } from '../types/music'

  const PLAY_MODE_META = {
    sequence: { text: '顺序播放', icon: ArrowRight },
    loop: { text: '列表循环', icon: Repeat2 },
    single: { text: '单曲循环', icon: Repeat1 },
    shuffle: { text: '随机播放', icon: Shuffle },
  } as const

  const runtimeConfig = ref<PublicMusicConfig>(musicConfig)

  const { triggerHaptic, withHaptic } = useHaptic()

  const { compactViewport, portableDevice, phoneDevice, lyricsWindowSupported, isMobileSheet } =
    useDeviceDetection()

  const store = usePlayerStore()
  const { currentTrack, currentTrackId, currentTime, duration, isPlaying, settings, tracks } =
    storeToRefs(store)
  // --beat-level 高频写入的目标节点：通过 ref 收集真正消费该变量的容器，
  // useBeatAnalyser 会在 RAF 中直接 setProperty 到这些节点，跳过根 :style 的样式重算。
  const artworkBackgroundRef = ref<HTMLElement | null>(null)
  const backgroundOverlayRef = ref<HTMLElement | null>(null)

  const { spectrumLevels, preloadMessage, toggle, pause, seek, next, previous, selectAndPlay } =
    useAudioPlayer({
      getBeatTargets: () => [artworkBackgroundRef.value, backgroundOverlayRef.value],
    })

  const toggleWithHaptic = withHaptic(toggle)
  const previousWithHaptic = withHaptic(previous, 'selection')
  const nextWithHaptic = withHaptic(next, 'selection')
  const cyclePlayModeWithHaptic = withHaptic(store.cyclePlayMode, 'heavy')

  const {
    isOpen: lyricsWindowOpen,
    setSnapshot: setLyricsWindowSnapshot,
    toggleLyricsWindow,
  } = useLyricsWindow({
    currentTrack,
    isPlaying,
  })
  const { canInstall, isInstalled, install, iosInstallAvailable } = usePwaInstall()

  // Sleep Timer composable
  const {
    sleepTimerMinutes,
    sleepTimerRemaining,
    sleepTimerOptions,
    sleepTimerDisplayMinutes,
    sleepTimerProgress,
    formatSleepTimerRemaining,
    handleSleepTimerInput,
    handleSleepTimerChange,
  } = useSleepTimer({
    onPause: pause,
    onShowNotice: showNotice,
  })

  // Theme accent composable
  const { accent, accentSoft, accentRgb, applyTheme, resetTheme, cssTransitionSupported } =
    useThemeAccent()

  // Fullscreen composable
  const { fullscreenActive, fullscreenSupported, toggleFullscreenMode } = useFullscreen({
    onShowNotice: showNotice,
  })

  // Track share composable
  const { shareCurrentTrack } = useTrackShare({
    currentTrack,
    onTriggerHaptic: triggerHaptic,
    onShowNotice: showNotice,
  })

  // Cover cache composable (singleton)
  const {
    loadedCovers,
    failedCovers,
    mainCoverReadyTrackId,
    markCoverLoaded,
    markCoverFailed,
    markMainCoverReady,
    resetMainCover,
  } = useCoverCache()

  // Keyboard shortcuts composable
  useKeyboardShortcuts({
    currentTime,
    duration,
    onToggle: toggleWithHaptic,
    onSeek: seek,
    onNext: nextWithHaptic,
    onPrevious: previousWithHaptic,
    onToggleLyrics: toggleLyrics,
  })

  const query = ref('')
  const loading = ref(true)
  const loadFailed = ref(false)
  const failedSources = ref(0)
  const settingsOpen = ref(false)
  const listOpen = ref(false)
  const panelsSoftened = ref(false)
  const mobileView = ref<'cover' | 'lyrics'>('cover')
  const lyricsEnabled = ref(true)
  const lyricAvailability = ref<LyricAvailability>('unavailable')
  const lyricsSnapshot = ref<LyricsSnapshot | null>(null)
  const lyricSeekPreviewTime = ref<number | null>(null)
  const lyricSeekPreviewActive = ref(false)
  const notice = ref('')
  const sourceWarning = ref('')
  // 封面 CORS 回退:crossorigin="anonymous" 首次加载失败(CDN 不返回 CORS 头)时,
  // 移除 crossorigin 重新加载,保证封面显示(取色降级为默认色)。
  // 用 Set 记录已回退的 trackId,通过 :key 变化触发 <img> 重建。
  const coverCorsRetry = ref(new Set<string>())
  const { chromeHidden, scheduleChromeHide, revealChrome, clearChromeTimer } = useChromeAutoHide({
    listOpen,
    settingsOpen,
    autoHideChrome: () => settings.value.autoHideChrome,
  })

  // Focus trap refs
  const libraryDrawerRef = ref<HTMLElement | null>(null)
  const settingsDrawerRef = ref<HTMLElement | null>(null)
  const libraryHandleRef = ref<HTMLElement | null>(null)
  const settingsHandleRef = ref<HTMLElement | null>(null)

  // Focus trap for drawers
  useFocusTrap(libraryDrawerRef, listOpen, closePanelsAnimated, {
    autoFocus: () => !isMobileSheet.value,
  })
  useFocusTrap(settingsDrawerRef, settingsOpen, closePanelsAnimated)

  // Pull-to-dismiss gesture (mobile sheet only)
  const usesSheetDrawer = () => isMobileSheet.value
  function getSheetHeight(el: HTMLElement | null): number {
    if (!el) return window.innerHeight
    const h = el.getBoundingClientRect().height
    return h > 0 ? h : window.innerHeight
  }
  const {
    detent: libraryDetent,
    dragging: libraryDragging,
    translateY: libraryTranslateY,
    resetPosition: resetLibraryDrawerPosition,
    dismissAnimated: libraryDismissAnimated,
  } = useDrawerSheet({
    containerRef: libraryDrawerRef,
    handleRef: libraryHandleRef,
    active: listOpen,
    onDismiss: closePanels,
    sheetHeight: () => getSheetHeight(libraryDrawerRef.value),
    enabled: usesSheetDrawer,
  })
  const {
    detent: settingsDetent,
    dragging: settingsDragging,
    translateY: settingsTranslateY,
    resetPosition: resetSettingsDrawerPosition,
    dismissAnimated: settingsDismissAnimated,
  } = useDrawerSheet({
    containerRef: settingsDrawerRef,
    handleRef: settingsHandleRef,
    active: settingsOpen,
    onDismiss: closePanels,
    sheetHeight: () => getSheetHeight(settingsDrawerRef.value),
    enabled: usesSheetDrawer,
  })
  const libraryDrawerStyle = computed(() => {
    if (!usesSheetDrawer()) return {}
    return {
      transform: `translateY(${libraryTranslateY.value}px)`,
      transition: libraryDragging.value ? 'none' : undefined,
    }
  })
  const settingsDrawerStyle = computed(() => {
    if (!usesSheetDrawer()) return {}
    return {
      transform: `translateY(${settingsTranslateY.value}px)`,
      transition: settingsDragging.value ? 'none' : undefined,
    }
  })
  const anyDrawerHalf = computed(
    () => libraryDetent.value === 'half' || settingsDetent.value === 'half',
  )

  function resetDrawerPositions() {
    resetLibraryDrawerPosition(listOpen.value ? 'full' : 'closed')
    resetSettingsDrawerPosition(settingsOpen.value ? 'full' : 'closed')
  }

  function onTopbarClick(e: MouseEvent) {
    if (!listOpen.value && !settingsOpen.value) return
    if (isInteractiveElement(e.target)) return
    closePanelsAnimated()
  }

  const filteredTracks = computed(() => filterTracks(store.tracks, query.value))
  const currentDisplayTitle = computed(() => {
    const track = currentTrack.value
    if (!track) return null
    return {
      title: track.title,
      versions: track.titleVersions ?? [],
    }
  })
  const lyricsVisible = computed(
    () => lyricsEnabled.value && lyricAvailability.value !== 'unavailable',
  )
  const settingsAvailable = computed(() => tracks.value.length > 0)
  const lyricsPanelActive = computed(() =>
    isMobileSheet.value
      ? lyricsVisible.value && mobileView.value === 'lyrics'
      : lyricsVisible.value,
  )
  const backgroundImage = computed(() =>
    settings.value.dynamicBackground &&
    currentTrack.value?.cover &&
    !failedCovers.value.has(currentTrack.value.id)
      ? `url("${currentTrack.value.cover.replaceAll('"', '\\"')}")`
      : 'none',
  )
  const playModeText = computed(() => PLAY_MODE_META[settings.value.playMode].text)
  const playModeIcon = computed(() => PLAY_MODE_META[settings.value.playMode].icon)
  const beatStyle = computed(() => ({
    // --beat-level 已移出本 computed：高频写入由 useBeatAnalyser 直接 setProperty 到目标节点，
    // 避免根元素 :style 改变触发整棵子树（233 个节点）样式重算。
    '--accent': accent.value,
    '--accent-soft': accentSoft.value,
    '--accent-rgb': accentRgb.value,
    '--background-blur': `${settings.value.backgroundBlur}px`,
    '--background-saturation': settings.value.backgroundSaturation.toFixed(2),
    '--beat-brightness': settings.value.beatBrightness.toFixed(2),
  }))
  let noticeTimer = 0
  let panelsSoftenedTimer = 0

  function showNotice(message: string) {
    notice.value = message
    window.clearTimeout(noticeTimer)
    noticeTimer = window.setTimeout(() => {
      if (notice.value === message) notice.value = ''
    }, 2600)
  }

  function clearNotice() {
    notice.value = ''
    window.clearTimeout(noticeTimer)
  }

  function showOfflineNotice() {
    showNotice('已进入离线模式,正在使用缓存内容')
  }

  function showOnlineNotice() {
    showNotice('网络已恢复')
  }

  function resolveSiteIcon(icon: string | undefined): string {
    if (!icon) return `${import.meta.env.BASE_URL}favicon.svg`
    if (/^(https?:|data:|blob:)/i.test(icon)) return icon
    const base = new URL(import.meta.env.BASE_URL, window.location.origin)
    return new URL(icon, base).href
  }

  function applySiteBrand(config: PublicMusicConfig) {
    document.title = `${config.siteName} · Music Player`
    const iconHref = resolveSiteIcon(config.siteIcon)
    let link = document.querySelector<HTMLLinkElement>("link[rel='icon']")
    if (!link) {
      link = document.createElement('link')
      link.rel = 'icon'
      document.head.appendChild(link)
    }
    link.href = iconHref
  }

  async function loadTracks() {
    loading.value = true
    sourceWarning.value = ''
    loadFailed.value = false
    clearNotice()
    try {
      const config = loadMusicConfig()
      runtimeConfig.value = config
      applySiteBrand(config)
      applySiteIntegrations(config)
      const result = await loadConfiguredTracks(config)
      store.setTracks(result.tracks)
      const url = new URL(window.location.href)
      const sharedTrackId = url.searchParams.get('share')
      const sharedTrack = sharedTrackId
        ? store.tracks.find((track) => trackMatchesShareId(track, sharedTrackId))
        : null
      if (sharedTrack) store.selectTrack(sharedTrack, store.tracks)
      if (sharedTrackId) {
        url.searchParams.delete('share')
        window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
      }
      failedSources.value = result.failedSources
      if (result.failedSources) {
        sourceWarning.value = `${result.failedSources} 个音乐源暂时无法载入`
        showNotice(sourceWarning.value)
      }
      if (!result.tracks.length) {
        showNotice('暂无可播放歌曲,请在管理后台添加音乐')
      }
    } catch {
      loadFailed.value = true
      showNotice('音乐列表载入失败,请稍后重试')
    } finally {
      loading.value = false
    }
  }

  function selectTrack(track: Track) {
    triggerHaptic('selection')
    void selectAndPlay(track, filteredTracks.value)
  }

  function closePanels() {
    triggerHaptic('light')
    listOpen.value = false
    settingsOpen.value = false
  }

  function closePanelsAnimated() {
    if (!usesSheetDrawer()) {
      closePanels()
      return
    }
    triggerHaptic('light')
    if (listOpen.value) {
      libraryDismissAnimated()
    }
    if (settingsOpen.value) {
      settingsDismissAnimated()
    }
  }

  function toggleLibrary() {
    triggerHaptic('light')
    if (listOpen.value) {
      // Closing the currently-open library
      if (usesSheetDrawer()) {
        libraryDismissAnimated()
      } else {
        listOpen.value = false
      }
      return
    }
    listOpen.value = true
    if (settingsOpen.value) {
      if (usesSheetDrawer()) {
        settingsDismissAnimated()
      } else {
        settingsOpen.value = false
      }
    }
  }

  function toggleSettings() {
    if (!settingsAvailable.value) return
    triggerHaptic('light')
    if (settingsOpen.value) {
      if (usesSheetDrawer()) {
        settingsDismissAnimated()
      } else {
        settingsOpen.value = false
      }
      return
    }
    settingsOpen.value = true
    if (listOpen.value) {
      if (usesSheetDrawer()) {
        libraryDismissAnimated()
      } else {
        listOpen.value = false
      }
    }
  }

  watch([listOpen, settingsOpen], ([libraryVisible, settingsVisible]) => {
    window.clearTimeout(panelsSoftenedTimer)
    chromeHidden.value = false
    scheduleChromeHide()
    if (libraryVisible || settingsVisible) {
      panelsSoftened.value = true
      return
    }

    panelsSoftenedTimer = window.setTimeout(() => {
      panelsSoftened.value = false
    }, 320)
  })
  watch(settingsAvailable, (available) => {
    if (!available && settingsOpen.value) {
      settingsOpen.value = false
    }
  })

  watch(compactViewport, () => {
    resetDrawerPositions()
  })
  watch(phoneDevice, () => {
    resetDrawerPositions()
  })

  function toggleLyrics() {
    if (lyricAvailability.value === 'unavailable') return
    triggerHaptic('selection')

    if (isMobileSheet.value) {
      if (!lyricsEnabled.value) lyricsEnabled.value = true
      mobileView.value = mobileView.value === 'lyrics' ? 'cover' : 'lyrics'
      return
    }

    lyricsEnabled.value = !lyricsEnabled.value
  }

  function showMobileLyrics() {
    if (lyricAvailability.value === 'unavailable') return
    triggerHaptic('selection')
    lyricsEnabled.value = true
    mobileView.value = 'lyrics'
  }

  function handleLyricAvailability(availability: LyricAvailability) {
    lyricAvailability.value = availability
    if (availability === 'unavailable') mobileView.value = 'cover'
    if (availability === 'unavailable') {
      lyricsSnapshot.value = null
      lyricSeekPreviewTime.value = null
      lyricSeekPreviewActive.value = false
    }
  }

  async function openLyricsWindow() {
    if (!lyricsWindowSupported.value) {
      showNotice('手机和平板暂不支持歌词小窗')
      return
    }

    try {
      await toggleLyricsWindow()
    } catch {
      showNotice('浏览器阻止了歌词小窗，请允许弹出窗口')
    }
  }

  async function installPwa() {
    const installed = await install()
    showNotice(installed ? 'Meliora 已安装' : '已取消安装')
  }

  function showIosInstallGuide() {
    triggerHaptic('selection')
    showNotice('请点击 Safari 分享按钮,选择「添加到主屏幕」')
  }

  function handleLyricsSnapshot(snapshot: LyricsSnapshot) {
    lyricsSnapshot.value = snapshot
    setLyricsWindowSnapshot(snapshot)
  }

  function handleSeekPreview(time: number | null, active: boolean) {
    lyricSeekPreviewTime.value = time
    lyricSeekPreviewActive.value = active
  }

  watch(currentTrackId, () => {
    lyricSeekPreviewTime.value = null
    lyricSeekPreviewActive.value = false
  })

  async function handleMainCoverLoaded(trackId: string, event: Event) {
    const image = event.currentTarget as HTMLImageElement
    // 等图片完整解码完成后再标记 loaded：
    // 避免浏览器渲染半解码的图像（视觉上"从上往下"逐行加载的效果），
    // 让 fade-in transition 真正发生在一张完整图像上。
    try {
      await image.decode?.()
    } catch {
      // 部分浏览器对跨域 / data URL 图片会拒绝 decode()，
      // 图片可能未完整解码，此时提取的主题色不可靠，直接回退到默认色。
      if (currentTrack.value?.id === trackId) {
        markCoverLoaded(trackId)
        markMainCoverReady(trackId)
        resetTheme()
      }
      return
    }
    if (currentTrack.value?.id !== trackId) return
    markCoverLoaded(trackId)
    markMainCoverReady(trackId)
    // extractThemeColor 现在是 async（Worker 化）；直接 await 即可。
    // 如果 Worker 路径成功就返回新主题色；失败时内部已自动 fallback 到主线程 + null 兜底。
    let immediateTheme: ThemeColor | null
    try {
      immediateTheme = await extractThemeColor(image)
    } catch {
      immediateTheme = null
    }
    if (currentTrack.value?.id !== trackId) return
    if (!immediateTheme) {
      resetTheme()
      return
    }
    applyTheme(immediateTheme)
  }

  function handleMainCoverError(trackId: string) {
    // crossorigin="anonymous" 模式下,CDN 不返回 Access-Control-Allow-Origin 会触发 onerror。
    // 首次失败时回退:标记该 trackId 并通过 :key 变化重建 <img>(移除 crossorigin),
    // 保证封面显示;此时取色因 canvas 污染降级为默认色。
    // 已回退过仍失败说明资源本身不可用,走正常的 failedCovers 标记流程。
    if (!coverCorsRetry.value.has(trackId)) {
      const next = new Set(coverCorsRetry.value)
      next.add(trackId)
      coverCorsRetry.value = next
      return
    }
    markCoverFailed(trackId)
  }

  onMounted(() => {
    window.addEventListener('offline', showOfflineNotice)
    window.addEventListener('online', showOnlineNotice)
    void loadTracks().finally(() => {
      if (!navigator.onLine) showOfflineNotice()
    })
  })
  onBeforeUnmount(() => {
    window.clearTimeout(noticeTimer)
    window.clearTimeout(panelsSoftenedTimer)
    window.removeEventListener('offline', showOfflineNotice)
    window.removeEventListener('online', showOnlineNotice)
  })

  watch(currentTrackId, () => {
    // 切歌时立即重置主封面"已就绪"状态，让新封面重新走 fade-in transition；
    // 列表里的小封面缓存（loadedCovers）保留，避免抽屉滚动时小图重复闪现。
    resetMainCover()
    // 清空 CORS 回退标记:新封面需要重新尝试 crossorigin 加载以支持取色。
    coverCorsRetry.value = new Set()
    lyricAvailability.value = 'unavailable'
    if (!hasTrackLyricsSource(currentTrack.value)) mobileView.value = 'cover'
    if (!currentTrack.value?.cover) {
      resetTheme()
    }
  })
  watch(preloadMessage, (message) => {
    if (message) showNotice(message)
  })
  watch(
    () => store.errorMessage,
    (message) => {
      if (message) showNotice(message)
    },
  )
  watch(
    () => settings.value.autoHideChrome,
    (enabled) => {
      chromeHidden.value = false
      if (enabled) scheduleChromeHide()
      else clearChromeTimer()
    },
  )
</script>

<template>
  <main
    class="app-shell"
    :class="{
      'background-disabled': !settings.dynamicBackground,
      'chrome-hidden': chromeHidden,
      'drawer-open': listOpen || settingsOpen,
      'mobile-sheet': isMobileSheet,
      'beat-active': isPlaying,
      'css-theme-transition': cssTransitionSupported,
    }"
    :style="beatStyle"
    @mousemove="revealChrome"
  >
    <Transition name="artwork-bg-swap">
      <div
        v-if="backgroundImage !== 'none'"
        :key="currentTrack?.id || 'empty-bg'"
        ref="artworkBackgroundRef"
        class="artwork-background"
        :style="{ '--cover-image': backgroundImage, '--beat-level': '0' }"
      />
    </Transition>
    <div ref="backgroundOverlayRef" class="background-overlay" :style="{ '--beat-level': '0' }" />

    <header class="topbar" @click="onTopbarClick">
      <div class="brand">
        <span>{{ runtimeConfig.siteName }}</span>
      </div>
      <div class="top-actions">
        <span v-if="sourceWarning" class="source-warning">{{ sourceWarning }}</span>
        <button
          class="nav-button share-button"
          aria-label="分享当前歌曲"
          title="分享歌曲"
          :disabled="!currentTrack"
          @click="shareCurrentTrack"
        >
          <Share2 :size="19" />
        </button>
        <button
          class="nav-button settings-button"
          :class="{ active: settingsOpen && settingsAvailable }"
          :aria-label="
            settingsAvailable ? (settingsOpen ? '关闭设置' : '打开设置') : '暂无歌曲,设置不可用'
          "
          :title="settingsAvailable ? '设置' : '暂无歌曲,设置不可用'"
          :disabled="!settingsAvailable"
          @click="toggleSettings"
        >
          <Settings :size="19" />
        </button>
      </div>
    </header>

    <Toast :message="notice" @dismiss="clearNotice" />

    <section
      class="now-playing-layout"
      :class="{
        'lyrics-hidden': !lyricsVisible,
        loading: loading && !store.tracks.length,
        softened: panelsSoftened,
      }"
    >
      <div v-if="lyricAvailability !== 'unavailable'" class="mobile-view-tabs">
        <button :class="{ active: mobileView === 'cover' }" @click="mobileView = 'cover'">
          正在播放
        </button>
        <button
          :class="{ active: mobileView === 'lyrics' && lyricsEnabled }"
          @click="showMobileLyrics"
        >
          歌词
        </button>
      </div>

      <article
        class="artwork-column"
        :class="{ 'mobile-hidden': lyricsVisible && mobileView !== 'cover' }"
      >
        <div
          class="artwork-frame"
          :class="{ loaded: currentTrack && mainCoverReadyTrackId === currentTrack.id }"
        >
          <img
            v-if="currentTrack?.cover && !failedCovers.has(currentTrack.id)"
            class="artwork-glow"
            :src="currentTrack.cover"
            alt=""
            aria-hidden="true"
            decoding="async"
            loading="eager"
            draggable="false"
          />
          <img
            v-if="currentTrack?.cover && !failedCovers.has(currentTrack.id)"
            :key="`${currentTrack.id}-${coverCorsRetry.has(currentTrack.id)}`"
            :src="currentTrack.cover"
            :crossorigin="coverCorsRetry.has(currentTrack.id) ? undefined : 'anonymous'"
            :alt="`${currentTrack.title} 封面`"
            decoding="async"
            loading="eager"
            draggable="false"
            @load="handleMainCoverLoaded(currentTrack.id, $event)"
            @error="handleMainCoverError(currentTrack.id)"
          />
        </div>
        <Transition name="meta-swap" mode="out-in">
          <div :key="currentTrackId || 'empty-meta'" class="primary-meta">
            <template v-if="currentTrack && currentDisplayTitle">
              <h1 class="display-title">
                <span class="title-main">{{ currentDisplayTitle.title }}</span>
                <span
                  v-for="version in currentDisplayTitle.versions"
                  :key="version"
                  class="title-version"
                >
                  {{ version }}
                </span>
              </h1>
            </template>
            <h1 v-else>{{ loading && !store.tracks.length ? '正在载入音乐' : '选择一首音乐' }}</h1>
            <p>
              {{
                currentTrack?.artist ||
                (loading && !store.tracks.length ? '整理歌单与本地曲库' : '从曲库开始播放')
              }}
            </p>
          </div>
        </Transition>
      </article>

      <Transition name="lyrics-panel-swap" mode="out-in">
        <LyricsPanel
          :key="currentTrackId || 'empty-lyrics'"
          class="lyrics-column"
          :class="{ 'mobile-hidden': mobileView !== 'lyrics', 'lyrics-disabled': !lyricsVisible }"
          :active="lyricsPanelActive"
          :preview-time="lyricSeekPreviewTime"
          :preview-active="lyricSeekPreviewActive"
          @seek="seek"
          @availability="handleLyricAvailability"
          @snapshot="handleLyricsSnapshot"
        />
      </Transition>

      <div class="mobile-shared-controls" :class="{ 'lyrics-mode': mobileView === 'lyrics' }">
        <PlayerControls
          variant="page"
          :on-toggle="toggleWithHaptic"
          :on-previous="previousWithHaptic"
          :on-next="nextWithHaptic"
          :on-seek="seek"
          :on-seek-preview="handleSeekPreview"
          :lyric-preview="lyricsSnapshot"
          :preview-enabled="!chromeHidden"
        />
        <div class="mobile-control-actions">
          <button :aria-label="playModeText" :title="playModeText" @click="cyclePlayModeWithHaptic">
            <component :is="playModeIcon" :size="20" />
          </button>
          <button
            :class="{ active: listOpen }"
            :aria-label="listOpen ? '关闭曲库' : '打开曲库'"
            title="曲库"
            @click="toggleLibrary"
          >
            <ListMusic :size="21" />
          </button>
          <button
            :class="{ active: mobileView === 'lyrics' }"
            :aria-label="mobileView === 'lyrics' ? '显示封面' : '显示歌词'"
            :disabled="lyricAvailability === 'unavailable'"
            @click="toggleLyrics"
          >
            <MessageSquareText :size="20" />
          </button>
        </div>
      </div>
    </section>

    <footer class="player-dock">
      <div class="transport-float">
        <PlayerControls
          variant="bar"
          :on-toggle="toggleWithHaptic"
          :on-previous="previousWithHaptic"
          :on-next="nextWithHaptic"
          :on-seek="seek"
          :on-seek-preview="handleSeekPreview"
          :lyric-preview="lyricsSnapshot"
          :preview-enabled="!chromeHidden"
        />
      </div>
      <div class="bottom-progress">
        <PlayerControls
          variant="progress"
          :on-toggle="toggleWithHaptic"
          :on-previous="previousWithHaptic"
          :on-next="nextWithHaptic"
          :on-seek="seek"
          :on-seek-preview="handleSeekPreview"
          :lyric-preview="lyricsSnapshot"
          :preview-enabled="!chromeHidden"
        />
      </div>
      <div class="dock-actions">
        <button :aria-label="playModeText" :title="playModeText" @click="cyclePlayModeWithHaptic">
          <component :is="playModeIcon" :size="19" />
        </button>
        <button
          :class="{ active: listOpen }"
          :aria-label="listOpen ? '关闭曲库' : '打开曲库'"
          title="曲库"
          @click="toggleLibrary"
        >
          <ListMusic :size="20" />
        </button>
        <button
          :class="{ active: lyricsVisible }"
          :aria-label="lyricsVisible ? '隐藏歌词' : '显示歌词'"
          :title="
            lyricAvailability === 'unavailable'
              ? '暂无歌词'
              : lyricsVisible
                ? '隐藏歌词'
                : '显示歌词'
          "
          :disabled="lyricAvailability === 'unavailable'"
          @click="toggleLyrics"
        >
          <MessageSquareText :size="19" />
        </button>
      </div>
    </footer>

    <Transition name="backdrop">
      <div
        v-if="listOpen || settingsOpen"
        class="drawer-backdrop"
        :class="{ 'is-half': anyDrawerHalf }"
        @click="closePanelsAnimated"
      />
    </Transition>

    <Transition name="library-sheet">
      <aside
        v-if="listOpen"
        ref="libraryDrawerRef"
        class="side-drawer library-drawer"
        :class="{ 'is-dragging': libraryDragging }"
        :style="libraryDrawerStyle"
        role="dialog"
        aria-modal="true"
        aria-label="曲库"
      >
        <span
          ref="libraryHandleRef"
          class="drawer-grab-handle"
          aria-hidden="true"
          role="presentation"
        />
        <TrackList
          :tracks="filteredTracks"
          :total="store.tracks.length"
          :current-track-id="currentTrackId"
          :is-playing="isPlaying"
          :loading="loading"
          :load-failed="loadFailed"
          :query="query"
          :spectrum-levels="spectrumLevels"
          @update:query="query = $event"
          @select="selectTrack"
          @reload="loadTracks"
        />
        <div v-if="currentTrack" class="drawer-mini-player">
          <span class="mini-artwork" :class="{ loaded: loadedCovers.has(currentTrack.id) }">
            <span class="small-cover-placeholder"><Music :size="18" fill="currentColor" /></span>
            <img
              v-if="currentTrack.cover && !failedCovers.has(currentTrack.id)"
              :src="currentTrack.cover"
              alt=""
              loading="lazy"
              decoding="async"
              @load="markCoverLoaded(currentTrack.id)"
              @error="markCoverFailed(currentTrack.id)"
            />
          </span>
          <div>
            <strong class="mini-title">
              <span>{{ currentDisplayTitle?.title }}</span>
              <span
                v-for="version in currentDisplayTitle?.versions"
                :key="version"
                class="title-version mini"
              >
                {{ version }}
              </span>
            </strong>
            <small>{{ currentTrack.artist }}</small>
          </div>
          <PlayerControls
            variant="mini"
            :on-toggle="toggleWithHaptic"
            :on-previous="previousWithHaptic"
            :on-next="nextWithHaptic"
            :on-seek="seek"
          />
        </div>
      </aside>
    </Transition>

    <Transition name="settings-drop">
      <aside
        v-if="settingsOpen"
        ref="settingsDrawerRef"
        class="side-drawer settings-drawer"
        :class="{ 'is-dragging': settingsDragging }"
        :style="settingsDrawerStyle"
        role="dialog"
        aria-modal="true"
        aria-label="播放器设置"
      >
        <span
          ref="settingsHandleRef"
          class="drawer-grab-handle"
          aria-hidden="true"
          role="presentation"
        />
        <header>
          <div>
            <h2>播放设置</h2>
            <p>调整播放、歌词与显示</p>
          </div>
        </header>
        <SettingsPanel
          :play-mode-text="playModeText"
          :sleep-timer-minutes="sleepTimerMinutes"
          :sleep-timer-remaining="sleepTimerRemaining"
          :sleep-timer-display-minutes="sleepTimerDisplayMinutes"
          :sleep-timer-progress="sleepTimerProgress"
          :sleep-timer-options="sleepTimerOptions"
          :format-sleep-timer-remaining="formatSleepTimerRemaining"
          :portable-device="portableDevice"
          :fullscreen-active="fullscreenActive"
          :fullscreen-supported="fullscreenSupported"
          :lyrics-window-supported="lyricsWindowSupported"
          :lyrics-window-open="lyricsWindowOpen"
          :has-current-track="Boolean(currentTrack)"
          :can-install="canInstall"
          :is-installed="isInstalled"
          :ios-install-available="iosInstallAvailable"
          @cycle-play-mode="cyclePlayModeWithHaptic"
          @sleep-timer-input="handleSleepTimerInput"
          @sleep-timer-change="handleSleepTimerChange"
          @toggle-fullscreen-mode="toggleFullscreenMode"
          @open-lyrics-window="openLyricsWindow"
          @install-pwa="installPwa"
          @show-ios-install-guide="showIosInstallGuide"
        />
      </aside>
    </Transition>
  </main>
</template>

<style scoped lang="scss">
  .app-shell {
    position: relative;
    min-height: 100svh;
    overflow: hidden;
    isolation: isolate;
  }
  // 支持 @property 时,:root 的 transition 会被 .app-shell 的 inline style(--accent)覆盖失效。
  // 在 .app-shell 自身声明同名 transition,让 inline style 的 --accent/--accent-soft 变化也走 CSS 原生过渡。
  // 仅在支持 @property 时挂载该 class;不支持时 useThemeAccent 走 JS 逐帧动画,加 transition 会拖尾。
  .app-shell.css-theme-transition {
    transition:
      --accent 0.72s cubic-bezier(0.16, 1, 0.3, 1),
      --accent-soft 0.72s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .artwork-background,
  .background-overlay {
    position: fixed;
    inset: -9%;
    z-index: -2;
    pointer-events: none;
  }
  .artwork-background {
    background-image: var(--cover-image);
    background-position: center;
    background-size: cover;
    filter: blur(calc(var(--background-blur) - var(--beat-level) * 8px))
      saturate(calc(var(--background-saturation) + var(--beat-level) * 0.24))
      brightness(calc(1 + var(--beat-level) * var(--beat-brightness)));
    opacity: calc(0.72 + var(--beat-level) * 0.16);
    transform: scale(calc(1.18 + var(--beat-level) * 0.018));
    transition:
      opacity 0.12s linear,
      filter 0.12s linear,
      transform 0.18s ease;
  }
  .beat-active .artwork-background {
    will-change: opacity, filter, transform;
  }
  .artwork-bg-swap-enter-active,
  .artwork-bg-swap-leave-active {
    transition:
      opacity 720ms cubic-bezier(0.22, 1, 0.36, 1),
      filter 720ms ease,
      transform 920ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .artwork-bg-swap-enter-active {
    z-index: -2;
  }
  .artwork-bg-swap-leave-active {
    z-index: -3;
  }
  .artwork-bg-swap-enter-from {
    opacity: 0;
    filter: blur(calc(var(--background-blur) + 32px)) saturate(var(--background-saturation));
    transform: scale(1.28);
  }
  .artwork-bg-swap-leave-to {
    opacity: 0;
    filter: blur(calc(var(--background-blur) + 24px)) saturate(var(--background-saturation));
    transform: scale(1.12);
  }
  .background-overlay {
    z-index: -1;
    background:
      linear-gradient(
        180deg,
        rgba(12, 12, 14, calc(0.5 - var(--beat-level) * 0.1)),
        rgba(12, 12, 14, 0.7) 42%,
        rgba(10, 10, 12, 0.9)
      ),
      radial-gradient(
        circle at 20% 18%,
        rgba(var(--accent-rgb), calc(0.07 + var(--beat-level) * 0.07)),
        transparent 42%
      );
    transition: background 0.46s ease;
  }
  .background-overlay::after {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0;
    background:
      radial-gradient(circle at 22% 18%, rgba(var(--accent-rgb), 0.22), transparent 42%),
      radial-gradient(circle at 80% 78%, rgba(var(--accent-rgb), 0.1), transparent 46%),
      linear-gradient(145deg, color-mix(in srgb, var(--accent) 10%, #242428), #101012 72%);
    transition:
      opacity 0.52s ease,
      background 0.52s ease;
  }
  .background-disabled .artwork-background {
    opacity: 0;
  }
  .background-disabled .background-overlay {
    background: linear-gradient(180deg, rgba(12, 12, 14, 0.58), rgba(10, 10, 12, 0.92));
  }
  .background-disabled .background-overlay::after {
    opacity: 1;
  }
  .topbar {
    position: fixed;
    inset: 0 0 auto;
    z-index: 20;
    display: flex;
    height: 64px;
    align-items: center;
    justify-content: space-between;
    padding: 0 28px;
    background: linear-gradient(rgba(18, 18, 20, 0.42), transparent);
    transition:
      opacity 0.48s cubic-bezier(0.22, 1, 0.36, 1),
      transform 0.48s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    color: #fff;
    font-size: 0.96rem;
    font-weight: 650;
    letter-spacing: -0.02em;
    text-decoration: none;
  }
  .top-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .nav-button,
  .bar-actions button {
    display: grid;
    width: 38px;
    height: 38px;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: rgba(255, 255, 255, 0.82);
    cursor: pointer;
    transition:
      color 0.32s ease,
      background 0.32s ease;
  }
  .nav-button:hover,
  .bar-actions button:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }
  .nav-button.active {
    color: rgba(255, 255, 255, 0.94);
    background: rgba(var(--accent-rgb), 0.14);
  }
  .nav-button:disabled {
    color: rgba(255, 255, 255, 0.24);
    cursor: default;
  }
  .nav-button:disabled:hover {
    background: transparent;
  }
  .source-warning {
    margin-right: 8px;
    color: rgba(255, 255, 255, 0.58);
    font-size: 0.68rem;
  }
  .now-playing-layout {
    --layout-gap: clamp(48px, 7vw, 120px);
    position: relative;
    height: calc(100svh - 126px);
    padding: 78px clamp(48px, 8vw, 150px) 24px;
  }
  .now-playing-layout.softened .artwork-column,
  .now-playing-layout.softened .lyrics-column {
    opacity: 0.34;
    transform: translateY(-4px) scale(0.992);
    pointer-events: none;
  }
  .artwork-column {
    position: absolute;
    top: 78px;
    bottom: 24px;
    left: clamp(48px, 8vw, 150px);
    display: flex;
    width: calc((100% - clamp(96px, 16vw, 300px) - var(--layout-gap)) * 0.44);
    min-width: 0;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    transition:
      width 720ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 280ms ease,
      transform 320ms ease;
  }
  .lyrics-hidden .artwork-column {
    width: calc(100% - clamp(96px, 16vw, 300px));
  }
  .artwork-frame {
    --artwork-radius: 64px;
    position: relative;
    width: min(100%, 52vh, 520px);
    aspect-ratio: 1;
    overflow: visible;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .now-playing-layout.loading .artwork-frame {
    box-shadow: none;
  }
  .artwork-frame img:not(.artwork-glow) {
    position: relative;
    z-index: 2;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: var(--artwork-radius);
    opacity: 0;
    filter: blur(18px);
    transform: scale(0.985);
    transition:
      opacity 0.36s cubic-bezier(0.22, 1, 0.36, 1),
      filter 0.42s ease,
      transform 0.42s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .artwork-frame.loaded img:not(.artwork-glow) {
    opacity: 1;
    filter: blur(0);
    transform: scale(1);
  }
  .artwork-frame .artwork-glow {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
    border-radius: var(--artwork-radius);
    object-fit: cover;
    opacity: 0.58;
    filter: blur(44px) saturate(165%) brightness(1.04);
    transform: scale(1.1);
    transform-origin: center;
    pointer-events: none;
  }
  .primary-meta {
    position: relative;
    width: min(100%, 52vh, 520px);
    padding: 28px 2px 0;
  }
  .primary-meta h1 {
    overflow: visible;
    margin: 0;
    color: #fff;
    font-size: clamp(1.44rem, 2.2vw, 2rem);
    font-weight: 730;
    letter-spacing: -0.045em;
    line-height: 1.16;
    text-overflow: clip;
    white-space: normal;
  }
  .primary-meta p {
    overflow: hidden;
    margin: 12px 0 0;
    color: rgba(255, 255, 255, 0.58);
    font-size: 0.92rem;
    font-weight: 520;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
    transition: color 0.42s ease;
  }
  .display-title {
    display: flex;
    max-width: 100%;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: 0.34em;
    row-gap: 0.08em;
    text-align: left;
    white-space: normal;
  }
  .title-main {
    min-width: 0;
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
  }
  .title-version {
    display: inline-block;
    max-width: 100%;
    margin-left: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.68);
    font-size: 0.48em;
    font-weight: 650;
    letter-spacing: -0.02em;
    line-height: 1.24;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    vertical-align: middle;
    transform: translateY(-0.02em);
  }
  .title-version.mini {
    max-width: 92px;
    margin-left: 5px;
    padding: 0.18em 0.46em 0.22em;
    font-size: 0.78em;
    vertical-align: 0.08em;
  }
  .mini-title .title-version.mini + .title-version.mini {
    margin-left: 3px;
  }
  .lyrics-hidden .primary-meta {
    text-align: center;
  }
  .lyrics-hidden .display-title {
    justify-content: center;
    text-align: center;
  }
  .lyrics-hidden .primary-meta p {
    text-align: center;
  }
  .meta-swap-enter-active,
  .meta-swap-leave-active {
    transition:
      opacity 300ms cubic-bezier(0.22, 1, 0.36, 1),
      filter 300ms ease,
      transform 380ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .meta-swap-enter-from,
  .meta-swap-leave-to {
    opacity: 0;
    filter: blur(12px);
    transform: translateY(10px);
  }
  .meta-swap-enter-to,
  .meta-swap-leave-from {
    opacity: 1;
    filter: blur(0);
    transform: translateY(0);
  }
  .lyrics-column {
    position: absolute;
    top: 78px;
    right: clamp(48px, 8vw, 150px);
    bottom: 24px;
    width: calc((100% - clamp(96px, 16vw, 300px) - var(--layout-gap)) * 0.56);
    min-width: 0;
    opacity: 1;
    transform: translateX(0) scale(1);
    transform-origin: left center;
    transition:
      opacity 440ms ease 160ms,
      filter 0.42s ease,
      transform 720ms cubic-bezier(0.16, 1, 0.3, 1),
      visibility 0s linear;
  }
  .lyrics-disabled {
    visibility: hidden;
    opacity: 0;
    transform: translateX(32px) scale(0.985);
    pointer-events: none;
    transition:
      opacity 260ms ease,
      transform 600ms cubic-bezier(0.4, 0, 0.2, 1),
      visibility 0s linear 600ms;
  }
  .lyrics-panel-swap-enter-active,
  .lyrics-panel-swap-leave-active {
    transition:
      opacity 320ms cubic-bezier(0.22, 1, 0.36, 1),
      filter 320ms ease,
      transform 420ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .lyrics-panel-swap-enter-from,
  .lyrics-panel-swap-leave-to {
    opacity: 0;
    filter: blur(14px);
    transform: translateY(14px) scale(0.992);
  }
  .lyrics-panel-swap-enter-to,
  .lyrics-panel-swap-leave-from {
    opacity: 1;
    filter: blur(0);
    transform: translateY(0) scale(1);
  }
  .mobile-shared-controls,
  .mobile-view-tabs {
    display: none;
  }
  .player-dock {
    position: fixed;
    right: 26px;
    bottom: 12px;
    left: 26px;
    z-index: 45;
    display: grid;
    grid-template-columns: 156px minmax(0, 1fr) 132px;
    align-items: stretch;
    gap: 12px;
    height: 56px;
    pointer-events: none;
    transition:
      opacity 0.5s cubic-bezier(0.22, 1, 0.36, 1),
      transform 0.5s cubic-bezier(0.22, 1, 0.36, 1);
  }
  .chrome-hidden .topbar {
    opacity: 0;
    transform: translateY(-14px);
    pointer-events: none;
  }
  .drawer-open .topbar {
    z-index: 42;
    background: transparent;
  }
  .chrome-hidden .player-dock {
    opacity: 0;
    transform: translateY(24px);
    pointer-events: none;
  }
  .transport-float,
  .bottom-progress,
  .dock-actions {
    display: flex;
    min-width: 0;
    height: 56px;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.13);
    border-radius: 28px;
    background: rgba(42, 41, 45, 0.62);
    box-shadow:
      0 12px 38px rgba(0, 0, 0, 0.28),
      inset 0 1px rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(34px) saturate(150%);
    pointer-events: auto;
  }
  .transport-float {
    padding: 0 14px;
  }
  .bottom-progress {
    padding: 0 8px;
  }
  .bottom-progress :deep(.range) {
    --track-height: 11px;
  }
  .bottom-progress:hover :deep(.range),
  .bottom-progress :deep(.range:focus-visible),
  .bottom-progress :deep(.range:active) {
    --track-height: 14px;
  }
  .bottom-progress :deep(.is-progress) {
    width: 100%;
  }
  .dock-actions {
    gap: 2px;
    padding: 0 9px;
  }
  .dock-actions button,
  .mobile-control-actions button {
    display: grid;
    width: 36px;
    height: 36px;
    place-items: center;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: rgba(255, 255, 255, 0.72);
    cursor: pointer;
    transition:
      color 0.18s ease,
      background 0.18s ease,
      transform 0.18s ease;
  }
  .dock-actions button:hover,
  .mobile-control-actions button:hover {
    color: #fff;
    background: rgba(255, 255, 255, 0.09);
  }
  .dock-actions button:active,
  .mobile-control-actions button:active {
    transform: scale(0.92);
  }
  .dock-actions button.active,
  .mobile-control-actions button.active {
    color: rgba(255, 255, 255, 0.94);
    background: rgba(var(--accent-rgb), 0.12);
  }
  .dock-actions button:disabled,
  .mobile-control-actions button:disabled {
    color: rgba(255, 255, 255, 0.22);
    cursor: default;
  }
  .bar-track {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 11px;
  }
  .bar-artwork {
    position: relative;
    display: grid;
    width: 42px;
    height: 42px;
    flex: 0 0 auto;
    place-items: center;
    overflow: hidden;
    border-radius: 11px;
    corner-shape: squircle;
    background: #2c2c2e;
    color: var(--text-subtle);
  }
  .bar-artwork img,
  .mini-artwork img {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity 0.22s ease;
  }
  .bar-artwork.loaded img,
  .mini-artwork.loaded img {
    opacity: 1;
  }
  .small-cover-placeholder {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    color: rgba(255, 255, 255, 0.26);
    background:
      radial-gradient(circle at 32% 22%, rgba(255, 255, 255, 0.07), transparent 42%), #2c2c2e;
  }
  .bar-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }
  .bar-copy strong,
  .bar-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bar-copy strong {
    color: #fff;
    font-size: 0.7rem;
    font-weight: 590;
  }
  .bar-copy small {
    color: var(--text-subtle);
    font-size: 0.61rem;
  }
  .bar-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 2px;
  }
  .bar-actions button.active {
    color: rgba(255, 255, 255, 0.94);
    background: rgba(var(--accent-rgb), 0.12);
  }
  .drawer-backdrop {
    position: fixed;
    inset: 72px 420px 84px 0;
    z-index: 38;
    background: transparent;
  }
  .side-drawer {
    position: fixed;
    top: 72px;
    right: 14px;
    bottom: 84px;
    z-index: 40;
    width: min(390px, calc(100vw - 28px));
    overflow: hidden;
    border: 0;
    border-radius: 34px;
    corner-shape: squircle;
    background: linear-gradient(145deg, rgba(72, 70, 78, 0.42), rgba(28, 27, 32, 0.3));
    box-shadow: 0 26px 90px rgba(0, 0, 0, 0.24);
    backdrop-filter: blur(56px) saturate(185%) brightness(1.05);
  }
  .drawer-grab-handle {
    display: none;
  }
  .side-drawer {
    transition:
      transform 320ms cubic-bezier(0.16, 1, 0.3, 1),
      opacity 320ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  .side-drawer.is-dragging {
    transition: none !important;
  }
  .library-drawer {
    top: 72px;
    right: 14px;
    bottom: 84px;
    left: auto;
    z-index: 40;
    width: min(390px, calc(100vw - 28px));
    height: auto;
    border-radius: 34px;
    transform-origin: bottom center;
    padding-bottom: 0;
  }
  .library-drawer :deep(.track-header) {
    padding-right: 0;
  }
  .drawer-mini-player {
    position: absolute;
    right: 12px;
    bottom: 12px;
    left: 12px;
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) auto;
    align-items: center;
    gap: 9px;
    padding: 8px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 18px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.09);
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.16);
    backdrop-filter: blur(30px) saturate(160%);
  }
  .drawer-mini-player > .mini-artwork {
    position: relative;
    display: grid;
    width: 42px;
    height: 42px;
    place-items: center;
    overflow: hidden;
    border-radius: 11px;
    corner-shape: squircle;
    background: #2c2c2e;
  }
  .drawer-mini-player > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .drawer-mini-player strong,
  .drawer-mini-player small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .drawer-mini-player strong {
    font-size: 0.7rem;
  }
  .mini-title {
    display: block;
    min-width: 0;
  }
  .drawer-mini-player small {
    color: var(--text-subtle);
    font-size: 0.61rem;
  }
  .settings-drawer {
    top: 72px;
    bottom: 84px;
    display: flex;
    width: min(390px, calc(100vw - 28px));
    max-height: none;
    flex-direction: column;
    padding: 22px;
    overflow: hidden;
  }
  .settings-drawer header {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: flex-start;
    margin-bottom: 18px;
  }
  .settings-drawer h2 {
    margin: 0;
    color: #fff;
    font-size: 1.35rem;
    letter-spacing: -0.035em;
  }
  .settings-drawer header p {
    margin: 4px 0 0;
    color: var(--text-subtle);
    font-size: 0.7rem;
  }
  .drawer-enter-active,
  .drawer-leave-active {
    transition: transform 0.28s cubic-bezier(0.2, 0.75, 0.25, 1);
  }
  .drawer-enter-from,
  .drawer-leave-to {
    transform: translateX(100%);
  }
  .library-sheet-enter-active,
  .library-sheet-leave-active {
    transition:
      opacity 0.28s ease,
      transform 0.34s cubic-bezier(0.2, 0.82, 0.22, 1);
  }
  .library-sheet-enter-from,
  .library-sheet-leave-to {
    opacity: 0;
    transform: translate(34px, calc(100% + 22px)) scale(0.985);
  }
  .settings-drop-enter-active,
  .settings-drop-leave-active {
    transition:
      opacity 0.24s ease,
      transform 0.3s cubic-bezier(0.2, 0.82, 0.22, 1);
  }
  .settings-drop-enter-from,
  .settings-drop-leave-to {
    opacity: 0;
    transform: translateY(calc(-100% - 18px)) scale(0.985);
  }
  .backdrop-enter-active,
  .backdrop-leave-active {
    transition: opacity 0.22s ease;
  }
  .backdrop-enter-from,
  .backdrop-leave-to {
    opacity: 0;
  }
  @media (max-width: 980px) {
    .now-playing-layout {
      --layout-gap: 44px;
      padding-right: 42px;
      padding-left: 42px;
    }
    .artwork-column {
      left: 42px;
      width: calc((100% - 84px - var(--layout-gap)) * 0.44);
    }
    .lyrics-hidden .artwork-column {
      width: calc(100% - 84px);
    }
    .lyrics-column {
      right: 42px;
      width: calc((100% - 84px - var(--layout-gap)) * 0.56);
    }
    .artwork-frame,
    .primary-meta {
      width: min(100%, 44vw);
    }
    .player-dock {
      right: 18px;
      left: 18px;
      grid-template-columns: 148px minmax(0, 1fr) 124px;
      gap: 10px;
    }
  }

  @media (max-width: 720px) {
    .app-shell {
      min-height: 100svh;
      overflow: hidden;
    }
    .topbar {
      height: 58px;
      padding: max(6px, env(safe-area-inset-top)) 14px 0;
      background: linear-gradient(180deg, rgba(10, 10, 12, 0.44), transparent);
    }
    .brand {
      gap: 7px;
      font-size: 0.88rem;
    }
    .top-actions {
      gap: 0;
    }
    .nav-button {
      width: 35px;
      height: 35px;
    }
    .source-warning {
      display: none;
    }
    .now-playing-layout {
      --mobile-content-width: min(calc(100vw - 40px), 38svh, 390px);
      position: relative;
      display: block;
      height: 100svh;
      padding: calc(58px + max(8px, env(safe-area-inset-top))) max(20px, env(safe-area-inset-right))
        max(18px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
      transition: none;
    }
    .mobile-view-tabs {
      display: none;
    }
    .artwork-column {
      position: absolute;
      inset: calc(58px + max(8px, env(safe-area-inset-top))) max(20px, env(safe-area-inset-right))
        max(18px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
      width: auto;
      height: auto;
      justify-content: flex-start;
      padding: clamp(10px, 2.2svh, 22px) 0 190px;
      transition:
        opacity 360ms cubic-bezier(0.22, 1, 0.36, 1),
        filter 360ms ease,
        transform 420ms cubic-bezier(0.16, 1, 0.3, 1),
        visibility 0s linear;
    }
    .lyrics-hidden .artwork-column {
      width: auto;
    }
    .artwork-frame {
      --artwork-radius: clamp(42px, 13vw, 62px);
      width: var(--mobile-content-width);
      flex: 0 0 auto;
      box-shadow: none;
    }
    .primary-meta {
      width: var(--mobile-content-width);
      padding: clamp(18px, 3.2svh, 26px) 2px 0;
      text-align: left;
    }
    .primary-meta h1 {
      font-size: clamp(1.34rem, 6.3vw, 1.78rem);
      line-height: 1.16;
    }
    .display-title {
      justify-content: flex-start;
      column-gap: 0.34em;
      row-gap: 0.1em;
      text-align: left;
    }
    .title-version {
      font-size: 0.48em;
    }
    .primary-meta p {
      margin-top: 13px;
      font-size: clamp(0.82rem, 3.8vw, 0.98rem);
      line-height: 1.34;
    }
    .lyrics-hidden .primary-meta,
    .lyrics-hidden .display-title,
    .lyrics-hidden .primary-meta p {
      text-align: left;
    }
    .lyrics-hidden .display-title {
      justify-content: flex-start;
    }
    .lyrics-column {
      position: absolute;
      inset: calc(58px + max(8px, env(safe-area-inset-top))) max(20px, env(safe-area-inset-right))
        max(18px, env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left));
      width: auto;
      height: auto;
      padding: 0 0 190px;
      transition:
        opacity 360ms cubic-bezier(0.22, 1, 0.36, 1),
        filter 360ms ease,
        transform 420ms cubic-bezier(0.16, 1, 0.3, 1),
        visibility 0s linear;
    }
    .lyrics-disabled {
      transform: none;
      transition: none;
    }
    .mobile-shared-controls {
      position: fixed;
      right: max(20px, env(safe-area-inset-right));
      bottom: max(14px, env(safe-area-inset-bottom));
      left: max(20px, env(safe-area-inset-left));
      z-index: 18;
      display: block;
      width: auto;
      padding: 16px 12px 4px;
      border-radius: 28px;
      corner-shape: squircle;
      transition:
        opacity 0.5s cubic-bezier(0.22, 1, 0.36, 1),
        transform 0.5s cubic-bezier(0.22, 1, 0.36, 1),
        background 320ms ease,
        backdrop-filter 320ms ease;
    }
    .mobile-shared-controls::before {
      position: absolute;
      inset: 0 calc(-1 * max(20px, env(safe-area-inset-right)))
        calc(-1 * max(14px, env(safe-area-inset-bottom)))
        calc(-1 * max(20px, env(safe-area-inset-left)));
      z-index: -1;
      border-radius: 0;
      background: linear-gradient(
        180deg,
        transparent,
        rgba(12, 12, 14, 0.2) 34%,
        rgba(12, 12, 14, 0.46)
      );
      content: '';
      pointer-events: none;
      transition:
        background 320ms ease,
        box-shadow 320ms ease,
        backdrop-filter 320ms ease;
    }
    .chrome-hidden .mobile-shared-controls {
      opacity: 0;
      transform: translateY(22px);
      pointer-events: none;
    }
    .mobile-control-actions {
      display: flex;
      align-items: center;
      justify-content: space-around;
      margin-top: 8px;
      padding: 5px 12px 2px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .mobile-control-actions button {
      width: 42px;
      height: 38px;
    }
    .mobile-shared-controls.lyrics-mode {
      backdrop-filter: blur(30px) saturate(160%);
    }
    .mobile-shared-controls.lyrics-mode::before {
      background: rgba(28, 28, 32, 0.48);
      box-shadow:
        0 14px 44px rgba(0, 0, 0, 0.24),
        inset 0 1px rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(30px) saturate(160%);
    }
    .artwork-column.mobile-hidden,
    .lyrics-column.mobile-hidden {
      visibility: hidden;
      opacity: 0;
      filter: blur(12px);
      pointer-events: none;
    }
    .artwork-column.mobile-hidden {
      transform: translateY(-10px) scale(0.985);
    }
    .lyrics-column.mobile-hidden {
      transform: translateY(14px) scale(0.985);
    }
    .player-dock {
      display: none;
    }
    .side-drawer {
      top: calc(62px + env(safe-area-inset-top));
      right: 0;
      bottom: 0;
      left: 0;
      width: 100vw;
      border-radius: clamp(26px, 7.5vw, 34px) clamp(26px, 7.5vw, 34px) 0 0;
      background: linear-gradient(145deg, rgba(58, 57, 64, 0.68), rgba(22, 22, 26, 0.58));
      box-shadow: 0 -18px 64px rgba(0, 0, 0, 0.34);
      backdrop-filter: blur(52px) saturate(180%);
      -webkit-backdrop-filter: blur(52px) saturate(180%);
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
      background: rgba(255, 255, 255, 0.6);
      width: 44px;
    }
    .drawer-backdrop {
      display: block;
      inset: calc(62px + env(safe-area-inset-top)) 0 0;
      z-index: 38;
      background: rgba(0, 0, 0, 0.08);
      transition:
        inset 280ms cubic-bezier(0.16, 1, 0.3, 1),
        background 280ms ease;
    }
    .drawer-backdrop.is-half {
      inset: 0;
      background: rgba(0, 0, 0, 0.32);
    }
    .library-drawer {
      top: calc(62px + env(safe-area-inset-top));
      right: 0;
      bottom: 0;
      left: 0;
      width: 100vw;
      height: auto;
      border-radius: clamp(26px, 7.5vw, 34px) clamp(26px, 7.5vw, 34px) 0 0;
      transform-origin: bottom center;
      padding-bottom: 0;
    }
    .library-drawer :deep(.track-header) {
      padding-right: 0;
    }
    .library-sheet-enter-from,
    .library-sheet-leave-to {
      opacity: 0;
      transform: translateY(36px) scale(0.98);
    }
    .drawer-mini-player {
      display: none;
    }
    .settings-drawer {
      top: calc(62px + env(safe-area-inset-top));
      bottom: 0;
      width: 100vw;
      max-height: none;
      padding: 19px 15px max(18px, env(safe-area-inset-bottom));
    }
    .settings-drop-enter-from,
    .settings-drop-leave-to {
      opacity: 0;
      transform: translateY(36px) scale(0.98);
    }
    .settings-drawer header {
      margin-bottom: 12px;
      padding: 0 2px;
    }
    .settings-drawer h2 {
      font-size: 1.22rem;
    }
    .settings-drawer header p {
      margin-top: 3px;
      font-size: 0.66rem;
    }
  }

  @media (max-width: 360px), (max-height: 700px) and (max-width: 720px) {
    .topbar {
      height: 54px;
      padding-right: 10px;
      padding-left: 12px;
    }
    .brand span {
      font-size: 0.8rem;
    }
    .nav-button {
      width: 33px;
      height: 33px;
    }
    .now-playing-layout {
      --mobile-content-width: min(calc(100vw - 32px), 36svh, 330px);
      padding-top: calc(54px + max(6px, env(safe-area-inset-top)));
      padding-right: 16px;
      padding-left: 16px;
    }
    .artwork-column {
      inset: calc(54px + max(6px, env(safe-area-inset-top))) 16px
        max(18px, env(safe-area-inset-bottom)) 16px;
      padding: 2px 0 172px;
    }
    .artwork-frame {
      width: var(--mobile-content-width);
    }
    .primary-meta {
      width: var(--mobile-content-width);
      padding-top: 18px;
    }
    .primary-meta h1 {
      font-size: 1.22rem;
    }
    .title-version {
      font-size: 0.48em;
    }
    .primary-meta p {
      margin-top: 11px;
      font-size: 0.8rem;
    }
    .lyrics-column {
      inset: calc(54px + max(6px, env(safe-area-inset-top))) 16px
        max(18px, env(safe-area-inset-bottom)) 16px;
      padding-bottom: 172px;
    }
    .mobile-shared-controls {
      right: 16px;
      bottom: max(8px, env(safe-area-inset-bottom));
      left: 16px;
      padding-top: 10px;
    }
    .mobile-shared-controls::before {
      inset: 0 -16px calc(-1 * max(8px, env(safe-area-inset-bottom)));
    }
    .side-drawer,
    .library-drawer,
    .settings-drawer {
      top: calc(58px + env(safe-area-inset-top));
    }
    .drawer-backdrop {
      inset: calc(58px + env(safe-area-inset-top)) 0 0;
    }
    .settings-drawer {
      padding: 15px 12px max(14px, env(safe-area-inset-bottom));
    }
    .settings-drawer header {
      margin-bottom: 8px;
    }
    .settings-drawer h2 {
      font-size: 1.08rem;
    }
    .settings-drawer header p {
      font-size: 0.6rem;
    }
  }

  @supports (-webkit-touch-callout: none) {
    @media (max-width: 720px) {
      .artwork-background {
        inset: -18%;
        filter: blur(var(--background-blur)) saturate(var(--background-saturation));
        opacity: 0.62;
        transform: scale(1.18) translateZ(0);
        will-change: auto;
        backface-visibility: hidden;
      }
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .now-playing-layout,
    .artwork-column,
    .lyrics-column,
    .artwork-frame {
      transition-duration: 0ms;
    }
  }

  @media (min-width: 721px) {
    .drawer-mini-player {
      display: none;
    }
  }
</style>
