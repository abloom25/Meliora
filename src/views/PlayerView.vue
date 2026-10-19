<script setup lang="ts">
  import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
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
  import { hasTrackLyricsSource } from '../services/lyrics'
  import { usePlayerStore } from '../stores/player'
  import { usePlayerLibrary } from '../composables/usePlayerLibrary'
  import { usePlayerArtwork } from '../composables/usePlayerArtwork'
  import { usePlayerPanels } from '../composables/usePlayerPanels'
  import { useAudioPlayer } from '../composables/useAudioPlayer'
  import { useLyricsWindow } from '../platform/web/useLyricsWindow'
  import { usePwaInstall } from '../platform/web/usePwaInstall'
  import { useSleepTimer } from '../composables/useSleepTimer'
  import { useFullscreen } from '../platform/web/useFullscreen'
  import { useTrackShare } from '../composables/useTrackShare'
  import { useKeyboardShortcuts } from '../composables/useKeyboardShortcuts'
  import { useHaptic } from '../platform/web/useHaptic'
  import { useDeviceDetection } from '../platform/web/useDeviceDetection'
  import ArtworkBackground from '../components/ArtworkBackground.vue'
  import LyricsPanel from '../components/LyricsPanel.vue'
  import PlayerControls from '../components/PlayerControls.vue'
  import SettingsPanel from '../components/SettingsPanel.vue'
  import TrackList from '../components/TrackList.vue'
  import Toast from '../components/Toast.vue'
  import type { LyricAvailability, LyricStatus, LyricsSnapshot, Track } from '../core/types'

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
    isMobileSheet,
    isPhoneLandscape,
    viewportHeight,
    viewportTop,
  } = useDeviceDetection()

  const store = usePlayerStore()
  const { currentTrack, currentTrackId, currentTime, duration, isPlaying, settings, tracks } =
    storeToRefs(store)
  // --beat-level 高频写入的目标节点：封面层(其 ::after 亮层只改 opacity)与叠加层(::before 光晕),
  // 节拍渲染适配器会在 RAF 中直接 setProperty 到这些节点，跳过根 :style 的样式重算。
  // Canvas 只在封面/设置/尺寸变化时预绘制,每帧节拍只调整亮层透明度。
  const artworkBackgroundRef = ref<HTMLElement | null>(null)
  const backgroundOverlayRef = ref<HTMLElement | null>(null)
  // 队列小频谱 meter 由 TrackList 暴露,--spectrum-level-N 同样走 RAF 直写
  const trackListRef = ref<InstanceType<typeof TrackList> | null>(null)

  const { preloadMessage, spectrumAvailable, toggle, pause, seek, next, previous, selectAndPlay } =
    useAudioPlayer({
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
  } = useLyricsWindow({
    currentTrack,
    isPlaying,
    currentTime,
    lyricAnimation: computed(() => settings.value.lyricAnimation),
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
  const notice = ref('')
  const { runtimeConfig, query, loading, loadFailed, sourceWarning, filteredTracks, loadTracks } =
    usePlayerLibrary({ showNotice, clearNotice })
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
    handleMainCoverLoaded,
    handleMainCoverError,
  } = usePlayerArtwork(currentTrack, settings)
  const settingsAvailable = computed(() => tracks.value.length > 0)
  const {
    listOpen,
    settingsOpen,
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
  } = usePlayerPanels({
    compactViewport,
    phoneDevice,
    isPhoneLandscape,
    isMobileSheet,
    settingsAvailable,
    autoHideChrome: () => settings.value.autoHideChrome,
    triggerHaptic,
  })

  const currentDisplayTitle = computed(() => {
    const track = currentTrack.value
    if (!track) return null
    return {
      title: track.title,
      versions: track.titleVersions ?? [],
    }
  })
  const lyricsAvailable = computed(() => lyricAvailability.value !== 'unavailable')
  const lyricsLayoutVisible = computed(() => lyricsEnabled.value && lyricsAvailable.value)
  const lyricsVisible = computed(() => lyricsLayoutVisible.value && lyricsAvailable.value)
  const lyricsPanelActive = computed(() =>
    isMobileSheet.value
      ? lyricsVisible.value && mobileView.value === 'lyrics'
      : lyricsVisible.value,
  )
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
    '--player-viewport-height': viewportHeight.value ? `${viewportHeight.value}px` : '100dvh',
    '--player-viewport-top': `${viewportTop.value}px`,
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
    void selectAndPlay(track, filteredTracks.value)
  }

  function toggleLyrics() {
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
      const nextTrackHasLyrics = hasTrackLyricsSource(currentTrack.value)
      setLyricAvailability(nextTrackHasLyrics ? 'loading' : 'unavailable')
      lyricsSnapshot.value = null
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
    class="app-shell"
    :class="{
      'background-disabled': !settings.dynamicBackground,
      'beat-disabled': !settings.beatFlash,
      'chrome-hidden': chromeHidden,
      'drawer-open': listOpen || settingsOpen,
      'mobile-sheet': isMobileSheet,
      'phone-landscape': isPhoneLandscape,
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
        'lyrics-hidden': !lyricsLayoutVisible,
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
              :src="cover.cover"
              :crossorigin="cover.corsRetried ? undefined : 'anonymous'"
              :alt="`${cover.title} 封面`"
              decoding="async"
              loading="eager"
              draggable="false"
              @load="handleMainCoverLoaded(cover.id, $event)"
              @error="handleMainCoverError(cover.id, cover.corsKey)"
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
          class="lyrics-column"
          :class="{ 'mobile-hidden': mobileView !== 'lyrics', 'lyrics-disabled': !lyricsVisible }"
          :active="lyricsPanelActive"
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
          ref="trackListRef"
          :tracks="filteredTracks"
          :total="store.tracks.length"
          :current-track-id="currentTrackId"
          :is-playing="isPlaying"
          :loading="loading"
          :load-failed="loadFailed"
          :query="query"
          :spectrum-available="spectrumAvailable"
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
          :sleep-timer="settingsSleepTimer"
          :capabilities="settingsCapabilities"
          :song-info="settingsSongInfo"
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

<style scoped lang="scss" src="../styles/player-view.scss"></style>
