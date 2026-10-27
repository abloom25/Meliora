<script setup lang="ts">
  import {
    computed,
    defineAsyncComponent,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    shallowRef,
    watch,
  } from 'vue'
  import { storeToRefs } from 'pinia'
  import {
    ArrowRight,
    Bug,
    ListMusic,
    MessageSquareText,
    Music,
    Repeat1,
    Repeat2,
    Settings,
    Share2,
    Shuffle,
    X,
  } from '@lucide/vue'
  import { hasTrackLyricsSource } from '../services/lyrics'
  import { usePlayerStore } from '../stores/player'
  import { useLibraryStore } from '../stores/library'
  import { selectLibraryTracks, type LibraryView } from '../core/library/personal-library'
  import { filterTracks } from '../core/library/tracks'
  import { usePlayerLibrary } from '../composables/usePlayerLibrary'
  import { usePlayerArtwork } from '../composables/usePlayerArtwork'
  import { usePlayerPanels } from '../composables/usePlayerPanels'
  import { useAudioPlayer } from '../composables/useAudioPlayer'
  import { useLyricsWindow } from '../platform/web/useLyricsWindow'
  import { useRuntimeDebug } from '../platform/web/useRuntimeDebug'
  import { readBeatAudioCacheUsage } from '../platform/web/beat-preanalysis'
  import { usePwaInstall } from '../platform/web/usePwaInstall'
  import { useSleepTimer } from '../composables/useSleepTimer'
  import { useFullscreen } from '../platform/web/useFullscreen'
  import { useTrackShare } from '../composables/useTrackShare'
  import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts'
  import { useHaptic } from '../platform/web/useHaptic'
  import { useDeviceDetection } from '../platform/web/useDeviceDetection'
  import { usePlayerLayoutMotion } from '../platform/web/usePlayerLayoutMotion'
  import ArtworkBackground from '../components/ArtworkBackground.vue'
  import LyricsPanel from '../components/LyricsPanel.vue'
  import Dropdown from '../components/Dropdown.vue'
  import PlayerControls from '../components/PlayerControls.vue'
  import MinimalPlayerControls from '../components/MinimalPlayerControls.vue'
  import SettingsPanel from '../components/SettingsPanel.vue'
  import TrackList from '../components/TrackList.vue'
  import Toast from '../components/Toast.vue'
  import type { LyricAvailability, LyricStatus, LyricsSnapshot, Track } from '../core/types'
  import type { LyricsDebugSnapshot } from '../core/diagnostics/lyrics-debug'
  import { MAX_SHARED_LYRIC_LINES, type LyricShareSelection } from '../core/lyrics/share'

  const LyricShareToolbar = defineAsyncComponent(
    () => import('../components/LyricShareToolbar.vue'),
  )

  const PlayerDebugPanel = import.meta.env.DEV
    ? defineAsyncComponent(() => import('../components/PlayerDebugPanel.vue'))
    : null

  const PLAY_MODE_META = {
    sequence: { text: '顺序播放', icon: ArrowRight },
    loop: { text: '列表循环', icon: Repeat2 },
    single: { text: '单曲循环', icon: Repeat1 },
    shuffle: { text: '随机播放', icon: Shuffle },
  } as const

  const { triggerHaptic, withHaptic } = useHaptic()

  const {
    compactViewport,
    portableDevice,
    phoneDevice,
    lyricsWindowSupported,
    viewportMode,
    isMobileSheet,
    isCompactLandscape,
    isShortLandscape,
    isMinimalPlayer,
    minimalArtworkVisible,
    minimalMetadataVisible,
    minimalMetadataPlacement,
    minimalArtworkWidth,
    minimalCoverSize,
    viewportWidth,
    viewportHeight,
    viewportLeft,
    viewportTop,
    landscapeStageHeight,
    landscapeCoverSize,
  } = useDeviceDetection()

  const store = usePlayerStore()
  const playerRoot = ref<HTMLElement | null>(null)
  const { currentTrack, currentTrackId, currentTime, duration, isPlaying, settings, tracks } =
    storeToRefs(store)
  // --beat-level 高频写入的目标节点：封面层(其 ::after 亮层只改 opacity)与叠加层(::before 光晕),
  // 节拍渲染适配器会在 RAF 中直接 setProperty 到这些节点，跳过根 :style 的样式重算。
  // Canvas 只在封面/设置/尺寸变化时预绘制,每帧节拍只调整亮层透明度。
  const artworkBackgroundRef = ref<HTMLElement | null>(null)
  const backgroundOverlayRef = ref<HTMLElement | null>(null)
  // 队列小频谱 meter 由 TrackList 暴露,--spectrum-level-N 同样走 RAF 直写
  const trackListRef = ref<InstanceType<typeof TrackList> | null>(null)

  const settingsAvailable = computed(() => tracks.value.length > 0)
  const debugAvailable = computed(
    () => import.meta.env.DEV && settingsAvailable.value && settings.value.debugPanelEnabled,
  )
  const {
    listOpen,
    settingsOpen,
    debugOpen,
    panelsSoftened,
    chromeHidden,
    libraryDrawerStyle,
    settingsDrawerStyle,
    libraryDragging,
    settingsDragging,
    anyDrawerHalf,
    onTopbarClick,
    closePanelsAnimated,
    toggleLibrary,
    toggleSettings,
    toggleDebug,
    closeDebugPanel,
  } = usePlayerPanels({
    compactViewport,
    phoneDevice,
    isCompactLandscape,
    isMobileSheet,
    settingsAvailable,
    debugAvailable,
    autoHideChrome: () => settings.value.autoHideChrome,
    triggerHaptic,
  })
  const debugEnabled = computed(() => debugAvailable.value && debugOpen.value)
  const beatComparisonVisible = ref(false)
  const lyricsDebug = shallowRef<LyricsDebugSnapshot | null>(null)
  const { snapshot: runtimeDebug } = useRuntimeDebug(debugEnabled, {
    readAudioCacheUsage: readBeatAudioCacheUsage,
  })
  watch(debugEnabled, (enabled) => {
    if (!enabled) lyricsDebug.value = null
  })

  const {
    preloadMessage,
    spectrumAvailable,
    toggle,
    pause,
    seek,
    next,
    previous,
    selectAndPlay,
    selectQueuedAndPlay,
    beatBuildStatus,
    retryBeatBuild,
    beatDebug,
    beatSchedulerDebug,
    beatComparison,
    canCompareBeats,
    startBeatComparison,
    stopBeatComparison,
    beatComparisonRecording,
    exportBeatComparison,
    beatComparisonExporting,
    beatComparisonExportError,
    audioPreloadDebug,
    listeningStats,
    clearListeningHistory,
    getPlaybackSeconds,
    getLyricsPlaybackState,
    subscribeLyricsPlayback,
  } = useAudioPlayer({
    debugEnabled,
    beatComparisonEnabled: beatComparisonVisible,
    getBeatTargets: () => [artworkBackgroundRef.value, backgroundOverlayRef.value],
    getSpectrumTargets: () => [trackListRef.value?.spectrumMeter],
  })

  const toggleWithHaptic = withHaptic(toggle)
  const previousWithHaptic = withHaptic(previous, 'selection')
  const nextWithHaptic = withHaptic(next, 'selection')
  const cyclePlayModeWithHaptic = withHaptic(store.cyclePlayMode, 'heavy')

  const {
    isOpen: lyricsWindowOpen,
    setSnapshot: setLyricsWindowSnapshot,
    toggleLyricsWindow,
    debugSnapshot: lyricsWindowDebug,
  } = useLyricsWindow({
    getPlaybackSeconds,
    getLyricsPlaybackState,
    subscribeLyricsPlayback,
    currentTrack,
    isPlaying,
    currentTime,
    debugEnabled,
    lyricAnimation: computed(() => settings.value.lyricAnimation),
    lyricScale: computed(() => settings.value.lyricScale),
    lyricWindowScale: computed(() => settings.value.lyricWindowScale),
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

  const mobileView = ref<'cover' | 'lyrics'>('cover')
  const lyricsEnabled = ref(true)
  const lyricAvailability = ref<LyricAvailability>('unavailable')
  const lyricsSnapshot = shallowRef<LyricsSnapshot | null>(null)
  const lyricShareSelection = shallowRef<LyricShareSelection | null>(null)
  const lyricShareOpen = ref(false)
  const lyricSharePreviewOpen = ref(false)
  const lyricShareIndices = ref<number[]>([])
  const lyricsPanelRef = ref<InstanceType<typeof LyricsPanel> | null>(null)
  const getCalibrationLyrics = () => lyricsPanelRef.value?.getCalibrationLyrics() ?? null
  const notice = ref('')
  const { runtimeConfig, query, loading, loadFailed, sourceWarning, loadTracks } = usePlayerLibrary(
    {
      showNotice,
      clearNotice,
      onOpenSharedTrack: (track, seconds) => {
        pause()
        store.selectTrack(track, store.tracks)
        seek(seconds ?? 0)
      },
    },
  )
  const library = useLibraryStore()
  const libraryView = ref<LibraryView>('all')
  const libraryTracks = computed(() =>
    selectLibraryTracks(
      tracks.value,
      store.queue,
      listeningStats.value.trackedTracks,
      library.favorites,
      libraryView.value,
    ),
  )
  const filteredTracks = computed(() => filterTracks(libraryTracks.value, query.value))
  const favoriteIds = computed(() =>
    tracks.value.filter(library.isFavorite).map((track) => track.id),
  )
  const {
    accent,
    accentSoft,
    accentRgb,
    cssTransitionSupported,
    loadedCovers,
    failedCovers,
    markCoverLoaded,
    markCoverFailed,
    mainCoverReadyTrackId,
    backgroundImage,
    mainCoverItems,
    setMainCoverImage,
    handleMainCoverLoaded,
    handleMainCoverError,
  } = usePlayerArtwork(currentTrack, settings)
  const currentDisplayTitle = computed(() => {
    const track = currentTrack.value
    if (!track) return null
    return {
      title: track.title,
      versions: track.titleVersions ?? [],
    }
  })
  const lyricsAvailable = computed(() => lyricAvailability.value !== 'unavailable')
  const lyricsLayoutVisible = computed(
    () => isMinimalPlayer.value || (lyricsEnabled.value && lyricsAvailable.value),
  )
  const lyricsVisible = computed(
    () => isMinimalPlayer.value || (lyricsLayoutVisible.value && lyricsAvailable.value),
  )
  const lyricsPanelActive = computed(() =>
    isMobileSheet.value
      ? lyricsVisible.value && mobileView.value === 'lyrics'
      : lyricsVisible.value,
  )
  watch(lyricsPanelActive, (active) => {
    if (!active) lyricShareOpen.value = false
  })
  watch(lyricShareOpen, (open) => {
    if (!open) lyricSharePreviewOpen.value = false
  })
  usePlayerLayoutMotion({
    layoutKey: () =>
      `${viewportMode.value}:${minimalArtworkVisible.value}:${minimalMetadataPlacement.value}:${lyricsLayoutVisible.value}:${mobileView.value}`,
    getTargets: () => [
      {
        key: 'cover',
        element: playerRoot.value?.querySelector<HTMLElement>('.artwork-frame') ?? null,
        scale: true,
        reveal: true,
      },
      {
        key: 'metadata',
        element: playerRoot.value?.querySelector<HTMLElement>('.primary-meta') ?? null,
        reveal: true,
      },
      {
        key: 'lyrics',
        element: playerRoot.value?.querySelector<HTMLElement>('.lyrics-column') ?? null,
      },
      {
        key: 'dock',
        element: playerRoot.value?.querySelector<HTMLElement>('.player-dock') ?? null,
      },
      {
        key: 'mobile-controls',
        element: playerRoot.value?.querySelector<HTMLElement>('.mobile-shared-controls') ?? null,
      },
    ],
  })
  usePlayerLayoutMotion({
    layoutKey: () =>
      `${viewportMode.value}:${isShortLandscape.value}:${listOpen.value}:${settingsOpen.value}:${debugOpen.value}`,
    getTargets: () =>
      ['library', 'settings', 'debug'].map((key) => ({
        key,
        element: playerRoot.value?.querySelector<HTMLElement>(`.${key}-drawer`) ?? null,
        resize: true,
      })),
  })
  const playModeText = computed(() => PLAY_MODE_META[settings.value.playMode].text)

  // 设置面板的入参按语义收成两组:定时关闭的状态、以及由各 composable 决定的能力开关。
  // 面板本身只读它们,不关心这些能力从哪来
  const settingsSleepTimer = computed(() => ({
    minutes: sleepTimerMinutes.value,
    remaining: sleepTimerRemaining.value,
    displayMinutes: sleepTimerDisplayMinutes.value,
    progress: sleepTimerProgress.value,
    options: sleepTimerOptions,
    formatRemaining: formatSleepTimerRemaining,
  }))
  const settingsCapabilities = computed(() => ({
    portableDevice: portableDevice.value,
    fullscreenActive: fullscreenActive.value,
    fullscreenSupported: fullscreenSupported.value,
    lyricsWindowSupported: lyricsWindowSupported.value,
    lyricsWindowOpen: lyricsWindowOpen.value,
    hasCurrentTrack: Boolean(currentTrack.value),
    canInstall: canInstall.value,
    isInstalled: isInstalled.value,
    iosInstallAvailable: iosInstallAvailable.value,
  }))
  // 只将歌词的语义信息送入设置,活跃行变化不触发整块歌曲信息刷新。
  const songLyricStatus = computed<LyricStatus>(
    () =>
      lyricsSnapshot.value?.status ?? (lyricAvailability.value === 'loading' ? 'loading' : 'idle'),
  )
  const songLyricSource = computed(() => lyricsSnapshot.value?.source ?? null)
  const minimalLyricMessage = computed(() => {
    if (!currentTrack.value) return tracks.value.length ? '点击播放开始听歌' : '暂无歌曲'
    if (songLyricStatus.value === 'error') return '歌词加载失败'
    if (lyricAvailability.value === 'unavailable' || songLyricStatus.value === 'empty')
      return '这首歌暂无歌词'
    if (lyricAvailability.value === 'loading') return '正在加载歌词'
    return ''
  })
  const songHasWordTiming = computed(
    () => lyricsSnapshot.value?.lines.some((line) => Boolean(line.words?.length)) ?? false,
  )
  const settingsSongInfo = computed(() => ({
    track: currentTrack.value,
    duration: duration.value,
    lyricStatus: songLyricStatus.value,
    lyricSource: songLyricSource.value,
    hasWordTiming: songHasWordTiming.value,
    loading: loading.value,
    durationUnavailable: Boolean(store.errorMessage),
  }))
  const playModeIcon = computed(() => PLAY_MODE_META[settings.value.playMode].icon)
  const beatStyle = computed(() => ({
    '--player-viewport-width': viewportWidth.value ? `${viewportWidth.value}px` : '100vw',
    '--player-viewport-height': viewportHeight.value ? `${viewportHeight.value}px` : '100dvh',
    '--player-viewport-left': `${viewportLeft.value}px`,
    '--player-viewport-top': `${viewportTop.value}px`,
    '--landscape-stage-height': `${landscapeStageHeight.value}px`,
    '--landscape-cover-size': `${landscapeCoverSize.value}px`,
    '--minimal-artwork-width': `${minimalArtworkWidth.value}px`,
    '--minimal-cover-size': `${minimalCoverSize.value}px`,
    // --beat-level 已移出本 computed：高频写入由节拍渲染适配器直接 setProperty 到目标节点，
    // 避免根元素 :style 改变触发整棵子树（233 个节点）样式重算。
    '--accent': accent.value,
    '--accent-soft': accentSoft.value,
    '--accent-rgb': accentRgb.value,
    '--background-blur': `${settings.value.backgroundBlur}px`,
    '--background-saturation': settings.value.backgroundSaturation.toFixed(2),
    '--beat-brightness': settings.value.beatBrightness.toFixed(2),
  }))
  let noticeTimer = 0

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

  function setLyricAvailability(availability: LyricAvailability) {
    lyricAvailability.value = availability
  }

  function showOfflineNotice() {
    showNotice('已进入离线模式,正在使用缓存内容')
  }

  function showOnlineNotice() {
    showNotice('网络已恢复')
  }

  function selectTrack(track: Track) {
    triggerHaptic('selection')
    if (libraryView.value === 'queue') void selectQueuedAndPlay(track)
    else void selectAndPlay(track, filteredTracks.value)
  }

  function enqueueTrack(track: Track, next: boolean) {
    const alreadyQueued = store.queue.some((item) => item.id === track.id)
    store.enqueueTrack(track, next)
    showNotice(
      next
        ? `下一首播放：${track.title}`
        : alreadyQueued
          ? '歌曲已在播放队列中'
          : `已加入队列：${track.title}`,
    )
  }

  function toggleFavorite(track: Track) {
    showNotice(library.toggleFavorite(track) ? '已收藏歌曲' : '已取消收藏')
  }

  function removeQueuedTrack(id: string) {
    if (store.removeQueuedTrack(id)) showNotice('已移出播放队列')
  }

  function toggleLyrics() {
    // 极简布局只显示歌词，不修改用户在完整布局中的显示偏好。
    if (isMinimalPlayer.value) return
    if (!lyricsLayoutVisible.value && !lyricsAvailable.value) return
    triggerHaptic('selection')

    if (isMobileSheet.value) {
      if (!lyricsAvailable.value) {
        lyricsEnabled.value = false
        mobileView.value = 'cover'
        return
      }
      if (!lyricsEnabled.value) lyricsEnabled.value = true
      mobileView.value = mobileView.value === 'lyrics' ? 'cover' : 'lyrics'
      return
    }

    lyricsEnabled.value = !lyricsEnabled.value
  }

  function showMobileLyrics() {
    if (!lyricsAvailable.value) return
    triggerHaptic('selection')
    lyricsEnabled.value = true
    mobileView.value = 'lyrics'
  }

  function handleLyricAvailability(availability: LyricAvailability) {
    setLyricAvailability(availability)
    if (availability === 'unavailable') mobileView.value = 'cover'
    if (availability === 'unavailable') {
      lyricsSnapshot.value = null
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

  function openLyricShare(selection: LyricShareSelection) {
    lyricSharePreviewOpen.value = false
    mobileView.value = 'lyrics'
    lyricShareSelection.value = {
      track: { ...selection.track },
      lines: selection.lines.map(({ time, text, translation }) => ({ time, text, translation })),
      index: selection.index,
    }
    lyricShareOpen.value = true
    lyricShareIndices.value = [selection.index]
    triggerHaptic('light')
  }

  async function beginLyricShare(closeMenu: () => void) {
    closeMenu()
    closePanelsAnimated()
    lyricsEnabled.value = true
    mobileView.value = 'lyrics'
    await nextTick()
    lyricsPanelRef.value?.startShare()
  }

  function shareSongFromMenu(closeMenu: () => void) {
    closeMenu()
    void shareCurrentTrack()
  }

  function toggleShareLine(index: number) {
    if (!lyricShareOpen.value || !lyricShareSelection.value?.lines[index]?.text.trim()) return
    if (lyricShareIndices.value.includes(index))
      lyricShareIndices.value = lyricShareIndices.value.filter((value) => value !== index)
    else if (lyricShareIndices.value.length < MAX_SHARED_LYRIC_LINES)
      lyricShareIndices.value = [...lyricShareIndices.value, index]
    else showNotice(`最多选择 ${MAX_SHARED_LYRIC_LINES} 句歌词`)
  }

  function releaseLyricShare() {
    if (!lyricShareOpen.value) lyricShareSelection.value = null
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
    window.removeEventListener('offline', showOfflineNotice)
    window.removeEventListener('online', showOnlineNotice)
  })

  watch(
    currentTrackId,
    () => {
      lyricShareOpen.value = false
      const nextTrackHasLyrics = hasTrackLyricsSource(currentTrack.value)
      setLyricAvailability(nextTrackHasLyrics ? 'loading' : 'unavailable')
      lyricsSnapshot.value = null
      lyricsDebug.value = null
      if (!nextTrackHasLyrics && isMobileSheet.value) {
        mobileView.value = 'cover'
      }
    },
    { flush: 'sync' },
  )
  watch(preloadMessage, (message) => {
    if (message) showNotice(message)
  })
  watch(
    () => store.errorMessage,
    (message) => {
      if (message) showNotice(message)
    },
  )
</script>

<template>
  <main
    ref="playerRoot"
    class="app-shell"
    :class="{
      'background-disabled': !settings.dynamicBackground,
      'beat-disabled': !settings.beatFlash,
      'chrome-hidden': chromeHidden && !lyricShareOpen,
      'drawer-open': listOpen || settingsOpen || debugOpen,
      'mobile-sheet': isMobileSheet,
      'compact-landscape': isCompactLandscape,
      'short-landscape': isShortLandscape,
      'minimal-player': isMinimalPlayer,
      'minimal-artwork-visible': minimalArtworkVisible,
      'minimal-metadata-visible': minimalMetadataVisible,
      'minimal-metadata-beside': minimalMetadataPlacement === 'beside',
      'beat-active': isPlaying,
      'css-theme-transition': cssTransitionSupported,
    }"
    :style="beatStyle"
  >
    <Transition name="artwork-bg-swap">
      <div
        v-if="backgroundImage !== 'none'"
        :key="currentTrack?.id || 'empty-bg'"
        ref="artworkBackgroundRef"
        class="artwork-background"
        :style="{ '--cover-image': backgroundImage, '--beat-level': '0' }"
      >
        <ArtworkBackground
          :cover="currentTrack?.cover || ''"
          :blur="settings.backgroundBlur"
          :saturation="settings.backgroundSaturation"
        />
      </div>
    </Transition>
    <div
      ref="backgroundOverlayRef"
      class="background-overlay"
      :style="{ '--beat-level': '0', '--beat-sustain': '0' }"
    />

    <header class="topbar" @click="onTopbarClick">
      <div class="brand">
        <span>{{ runtimeConfig.siteName }}</span>
      </div>
      <div class="top-actions">
        <span v-if="sourceWarning" class="source-warning">{{ sourceWarning }}</span>
        <button
          v-if="debugAvailable"
          class="nav-button debug-button"
          :class="{ active: debugOpen }"
          :aria-label="debugOpen ? '关闭调试面板' : '打开调试面板'"
          :aria-expanded="debugOpen"
          aria-controls="player-debug-panel"
          title="调试"
          @click="toggleDebug"
        >
          <Bug :size="19" />
        </button>
        <Dropdown class="share-menu" teleport label="分享">
          <template #trigger="{ toggle: toggleShareMenu }">
            <button
              class="nav-button share-button"
              aria-label="分享"
              title="分享"
              :disabled="!currentTrack"
              @click="toggleShareMenu"
            >
              <Share2 :size="19" />
            </button>
          </template>
          <template #default="{ close }">
            <button class="share-menu-option" @click="shareSongFromMenu(close)">
              <Share2 :size="16" />分享歌曲
            </button>
            <button
              class="share-menu-option"
              :disabled="lyricAvailability !== 'available'"
              @click="beginLyricShare(close)"
            >
              <MessageSquareText :size="16" />分享歌词
            </button>
          </template>
        </Dropdown>
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
        'lyrics-hidden': !lyricsLayoutVisible,
        'cover-centered': isMobileSheet || (!lyricsLayoutVisible && !isShortLandscape),
        loading: loading && !store.tracks.length,
        softened: panelsSoftened,
      }"
    >
      <div v-if="lyricsAvailable" class="mobile-view-tabs">
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
          <template v-for="cover in mainCoverItems" :key="cover.key">
            <img
              class="artwork-glow"
              :src="cover.cover"
              alt=""
              aria-hidden="true"
              decoding="async"
              loading="eager"
              draggable="false"
            />
            <img
              :ref="setMainCoverImage"
              :src="cover.cover"
              :crossorigin="cover.corsRetried ? undefined : 'anonymous'"
              :alt="`${cover.title} 封面`"
              decoding="async"
              loading="eager"
              draggable="false"
              @load="handleMainCoverLoaded(cover.id, $event)"
              @error="handleMainCoverError(cover.id, cover.corsKey, $event)"
            />
          </template>
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
          ref="lyricsPanelRef"
          class="lyrics-column"
          :class="{ 'mobile-hidden': mobileView !== 'lyrics', 'lyrics-disabled': !lyricsVisible }"
          :active="lyricsPanelActive"
          :sharing="lyricShareOpen"
          :share-preview="lyricShareOpen && lyricSharePreviewOpen"
          :selected-indices="lyricShareIndices"
          :debug-enabled="debugEnabled"
          :get-lyrics-playback-state="getLyricsPlaybackState"
          :subscribe-lyrics-playback="subscribeLyricsPlayback"
          @seek="seek"
          @availability="handleLyricAvailability"
          @snapshot="handleLyricsSnapshot"
          @share="openLyricShare"
          @share-toggle="toggleShareLine"
          @share-cancel="lyricShareOpen = false"
          @debug="lyricsDebug = $event"
        >
          <template #share-tools>
            <Transition
              name="lyric-share-tools"
              @after-leave="releaseLyricShare"
              @before-leave="(element) => element.setAttribute('inert', '')"
            >
              <LyricShareToolbar
                v-if="lyricShareSelection"
                v-show="lyricShareOpen"
                :visible="lyricShareOpen"
                :selection="lyricShareSelection"
                :indices="lyricShareIndices"
                @preview="lyricSharePreviewOpen = $event"
                @close="lyricShareOpen = false"
              />
            </Transition>
          </template>
        </LyricsPanel>
      </Transition>

      <p v-if="isMinimalPlayer && minimalLyricMessage" class="minimal-lyric-message" role="status">
        {{ minimalLyricMessage }}
      </p>
      <div class="mobile-shared-controls" :class="{ 'lyrics-mode': mobileView === 'lyrics' }">
        <PlayerControls
          variant="page"
          :on-toggle="toggleWithHaptic"
          :on-previous="previousWithHaptic"
          :on-next="nextWithHaptic"
          :on-seek="seek"
          :lyric-preview="lyricsSnapshot"
          :preview-enabled="false"
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

    <div class="minimal-controls-overlay">
      <Transition name="minimal-controls">
        <MinimalPlayerControls
          v-if="isMinimalPlayer"
          :is-playing="isPlaying"
          :current-time="currentTime"
          :duration="duration"
          :disabled="!tracks.length"
          :on-toggle="toggleWithHaptic"
          :on-next="nextWithHaptic"
        />
      </Transition>
    </div>

    <footer class="player-dock">
      <div class="transport-float">
        <PlayerControls
          variant="bar"
          :on-toggle="toggleWithHaptic"
          :on-previous="previousWithHaptic"
          :on-next="nextWithHaptic"
          :on-seek="seek"
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
          :lyric-preview="lyricsSnapshot"
          :preview-enabled="!chromeHidden"
        />
      </div>
      <div class="dock-actions">
        <button
          class="dock-play-mode"
          :aria-label="playModeText"
          :title="playModeText"
          @click="cyclePlayModeWithHaptic"
        >
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
          :class="{ active: lyricsLayoutVisible }"
          :aria-label="lyricsLayoutVisible ? '隐藏歌词' : '显示歌词'"
          :title="
            lyricsLayoutVisible
              ? '隐藏歌词'
              : lyricAvailability === 'unavailable'
                ? '暂无歌词'
                : '显示歌词'
          "
          :disabled="lyricAvailability === 'unavailable' && !lyricsLayoutVisible"
          @click="toggleLyrics"
        >
          <MessageSquareText :size="19" />
        </button>
      </div>
    </footer>

    <Transition name="backdrop">
      <div
        v-if="listOpen || settingsOpen || debugOpen"
        class="drawer-backdrop"
        :class="{ 'is-half': anyDrawerHalf && !debugOpen, 'debug-backdrop': debugOpen }"
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
          ref="trackListRef"
          :tracks="filteredTracks"
          :total="libraryTracks.length"
          :view="libraryView"
          :favorite-ids="favoriteIds"
          :current-track-id="currentTrackId"
          :is-playing="isPlaying"
          :loading="loading"
          :load-failed="loadFailed"
          :query="query"
          :spectrum-available="spectrumAvailable"
          @update:query="query = $event"
          @update:view="libraryView = $event"
          @select="selectTrack"
          @enqueue="enqueueTrack"
          @favorite="toggleFavorite"
          @remove="removeQueuedTrack"
          @move="store.moveQueuedTrack"
          @reload="loadTracks"
        >
          <template v-if="isCompactLandscape" #header-actions>
            <button
              class="nav-button drawer-close"
              aria-label="关闭曲库"
              @click="closePanelsAnimated"
            >
              <X :size="20" />
            </button>
          </template>
        </TrackList>
        <div v-if="currentTrack" class="drawer-mini-player">
          <span
            class="mini-artwork"
            :class="{ loaded: loadedCovers.has(currentTrack.cover ?? currentTrack.id) }"
          >
            <span class="small-cover-placeholder"><Music :size="18" fill="currentColor" /></span>
            <img
              v-if="currentTrack.cover && !failedCovers.has(currentTrack.cover ?? currentTrack.id)"
              :src="currentTrack.cover"
              alt=""
              loading="lazy"
              decoding="async"
              @load="markCoverLoaded(currentTrack.id, currentTrack.cover)"
              @error="markCoverFailed(currentTrack.id, currentTrack.cover)"
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
          <button
            v-if="isCompactLandscape"
            class="nav-button drawer-close"
            aria-label="关闭设置"
            @click="closePanelsAnimated"
          >
            <X :size="20" />
          </button>
        </header>
        <SettingsPanel
          :play-mode-text="playModeText"
          :sleep-timer="settingsSleepTimer"
          :capabilities="settingsCapabilities"
          :song-info="settingsSongInfo"
          :get-calibration-lyrics="getCalibrationLyrics"
          :get-playback-state="getLyricsPlaybackState"
          :beat-build="beatBuildStatus"
          :listening-stats="listeningStats"
          :clear-listening-history="clearListeningHistory"
          @beat-build-retry="retryBeatBuild"
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
    <Transition name="debug-drawer">
      <aside
        v-if="debugEnabled"
        id="player-debug-panel"
        ref="debugDrawerRef"
        class="side-drawer debug-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="播放调试"
        tabindex="-1"
      >
        <PlayerDebugPanel
          :beat="beatDebug"
          :scheduler="beatSchedulerDebug"
          :comparison="beatComparison"
          :can-compare="canCompareBeats"
          :comparison-export-sample-count="beatComparisonRecording?.sampleCount ?? 0"
          :comparison-export-truncated="beatComparisonRecording?.truncated ?? false"
          :comparison-exporting="beatComparisonExporting ?? false"
          :comparison-export-error="beatComparisonExportError ?? null"
          :flash-rate="settings.beatFlashRate"
          :build="beatBuildStatus"
          :preload="audioPreloadDebug"
          :queue="store.queue"
          :current-track-id="currentTrackId"
          :playback-seconds="currentTime"
          :duration-seconds="duration"
          :playing="isPlaying"
          :brightness="settings.beatBrightness"
          :play-mode-text="playModeText"
          :lyrics="lyricsDebug"
          :lyrics-window="lyricsWindowDebug"
          :lyrics-window-supported="lyricsWindowSupported"
          :has-current-track="Boolean(currentTrack)"
          :runtime="runtimeDebug"
          @close="closeDebugPanel"
          @comparison-visible="beatComparisonVisible = $event"
          @compare-start="startBeatComparison"
          @compare-stop="stopBeatComparison"
          @compare-export="exportBeatComparison"
          @toggle-lyrics-window="openLyricsWindow"
        />
      </aside>
    </Transition>
  </main>
</template>

<style scoped lang="scss" src="../styles/player-view.scss"></style>
