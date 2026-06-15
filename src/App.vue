<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  ArrowRight,
  Download,
  ListMusic,
  MessageSquareText,
  Music,
  PictureInPicture2,
  Repeat1,
  Repeat2,
  Settings,
  Share2,
  Shuffle,
  SlidersHorizontal,
  X,
} from '@lucide/vue'
import { musicConfig } from './config/music'
import { loadConfiguredTracks } from './services/music'
import { usePlayerStore } from './stores/player'
import { filterTracks } from './utils/tracks'
import { loadThemeColor } from './utils/theme'
import { useAudioPlayer } from './composables/useAudioPlayer'
import { useLyricsWindow } from './composables/useLyricsWindow'
import { usePwaInstall } from './composables/usePwaInstall'
import LyricsPanel from './components/LyricsPanel.vue'
import PlayerControls from './components/PlayerControls.vue'
import TrackList from './components/TrackList.vue'
import BrandMark from './components/BrandMark.vue'
import type { LyricAvailability, LyricsSnapshot, Track } from './types/music'

const store = usePlayerStore()
const { currentTrack, currentTrackId, isPlaying, settings } = storeToRefs(store)
const {
  beatLevel,
  preloadMessage,
  toggle,
  seek,
  next,
  previous,
  selectAndPlay,
} = useAudioPlayer()
const {
  isOpen: lyricsWindowOpen,
  setSnapshot: setLyricsWindowSnapshot,
  toggleLyricsWindow,
} = useLyricsWindow({
  currentTrack,
  currentTime: storeToRefs(store).currentTime,
  isPlaying,
})
const { canInstall, isInstalled, install } = usePwaInstall()
const query = ref('')
const loading = ref(false)
const failedSources = ref(0)
const settingsOpen = ref(false)
const listOpen = ref(false)
const mobileView = ref<'cover' | 'lyrics'>('cover')
const lyricsEnabled = ref(true)
const lyricAvailability = ref<LyricAvailability>('unavailable')
const compactViewport = ref(false)
const notice = ref('')
const loadedCovers = ref(new Set<string>())
const failedCovers = ref(new Set<string>())
const accent = ref('#81d8d0')
const accentSoft = ref('#a7e7e2')
const accentRgb = ref('129, 216, 208')
const filteredTracks = computed(() => filterTracks(store.tracks, query.value))
const lyricsVisible = computed(
  () => lyricsEnabled.value && lyricAvailability.value !== 'unavailable',
)
const backgroundImage = computed(() =>
  settings.value.dynamicBackground &&
  currentTrack.value?.cover &&
  !failedCovers.value.has(currentTrack.value.id)
    ? `url("${currentTrack.value.cover.replaceAll('"', '\\"')}")`
    : 'none',
)
const playModeText = computed(
  () => ({ sequence: '顺序播放', loop: '列表循环', single: '单曲循环', shuffle: '随机播放' })[settings.value.playMode],
)
const playModeIcon = computed(
  () => ({
    sequence: ArrowRight,
    loop: Repeat2,
    single: Repeat1,
    shuffle: Shuffle,
  })[settings.value.playMode],
)
const beatStyle = computed(() => ({
  '--beat-level': beatLevel.value.toFixed(3),
  '--accent': accent.value,
  '--accent-soft': accentSoft.value,
  '--accent-rgb': accentRgb.value,
  '--background-blur': `${settings.value.backgroundBlur}px`,
  '--background-saturation': settings.value.backgroundSaturation.toFixed(2),
  '--beat-brightness': settings.value.beatBrightness.toFixed(2),
}))
let compactViewportQuery: MediaQueryList | undefined
let noticeTimer = 0

function showNotice(message: string) {
  notice.value = message
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    if (notice.value === message) notice.value = ''
  }, 2600)
}

async function loadTracks() {
  loading.value = true
  notice.value = ''
  try {
    const result = await loadConfiguredTracks()
    store.setTracks(result.tracks)
    const sharedTrackId = new URL(window.location.href).searchParams.get('track')
    const sharedTrack = result.tracks.find((track) => track.id === sharedTrackId)
    if (sharedTrack) store.selectTrack(sharedTrack, result.tracks)
    failedSources.value = result.failedSources
    if (result.failedSources) notice.value = `${result.failedSources} 个音乐源暂时无法载入`
    if (!result.tracks.length) notice.value = '没有载入到可播放的歌曲'
  } catch {
    notice.value = '音乐列表载入失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

function selectTrack(track: Track) {
  void selectAndPlay(track, filteredTracks.value)
}

function playAll() {
  const first = filteredTracks.value[0]
  if (!first) return
  void selectAndPlay(first, filteredTracks.value)
}

function shuffleAll() {
  if (!filteredTracks.value.length) return
  const track = filteredTracks.value[Math.floor(Math.random() * filteredTracks.value.length)]
  if (!track) return
  store.settings.playMode = 'shuffle'
  void selectAndPlay(track, filteredTracks.value)
}

function closePanels() {
  listOpen.value = false
  settingsOpen.value = false
}

function updateCompactViewport(event: MediaQueryListEvent | MediaQueryList) {
  compactViewport.value = event.matches
}

function toggleLyrics() {
  if (lyricAvailability.value === 'unavailable') return

  if (compactViewport.value) {
    if (!lyricsEnabled.value) lyricsEnabled.value = true
    mobileView.value = mobileView.value === 'lyrics' ? 'cover' : 'lyrics'
    return
  }

  lyricsEnabled.value = !lyricsEnabled.value
}

function showMobileLyrics() {
  if (lyricAvailability.value === 'unavailable') return
  lyricsEnabled.value = true
  mobileView.value = 'lyrics'
}

function handleLyricAvailability(availability: LyricAvailability) {
  lyricAvailability.value = availability
  if (availability === 'unavailable') mobileView.value = 'cover'
}

function copyText(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.append(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
  return Promise.resolve()
}

async function shareCurrentTrack() {
  const track = currentTrack.value
  if (!track) return

  const url = new URL(window.location.href)
  url.searchParams.set('track', track.id)
  const shareData = {
    title: `${track.title} - ${track.artist}`,
    text: `正在 Meliora 收听 ${track.title} - ${track.artist}`,
    url: url.href,
  }

  try {
    if (navigator.share) {
      await navigator.share(shareData)
      return
    }
    await copyText(url.href)
    showNotice('歌曲链接已复制')
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return
    try {
      await copyText(url.href)
      showNotice('歌曲链接已复制')
    } catch {
      showNotice('暂时无法分享这首歌曲')
    }
  }
}

async function openLyricsWindow() {
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

function handleLyricsSnapshot(snapshot: LyricsSnapshot) {
  setLyricsWindowSnapshot(snapshot)
}

function markCoverLoaded(trackId: string) {
  loadedCovers.value = new Set(loadedCovers.value).add(trackId)
}

async function handleMainCoverLoaded(trackId: string, event: Event) {
  markCoverLoaded(trackId)
  const image = event.currentTarget as HTMLImageElement
  const theme = await loadThemeColor(image.currentSrc || image.src)
  if (!theme || currentTrack.value?.id !== trackId) return
  accent.value = theme.accent
  accentSoft.value = theme.accentSoft
  accentRgb.value = theme.rgb
}

function markCoverFailed(trackId: string) {
  failedCovers.value = new Set(failedCovers.value).add(trackId)
}

onMounted(() => {
  compactViewportQuery = window.matchMedia('(max-width: 720px)')
  updateCompactViewport(compactViewportQuery)
  compactViewportQuery.addEventListener('change', updateCompactViewport)
  void loadTracks()
})
onBeforeUnmount(() => {
  window.clearTimeout(noticeTimer)
  compactViewportQuery?.removeEventListener('change', updateCompactViewport)
})
watch(currentTrackId, () => {
  lyricAvailability.value = currentTrack.value?.lyricsUrl ? 'loading' : 'unavailable'
  if (!currentTrack.value?.lyricsUrl) mobileView.value = 'cover'
  accent.value = '#81d8d0'
  accentSoft.value = '#a7e7e2'
  accentRgb.value = '129, 216, 208'
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
</script>

<template>
  <main
    class="app-shell"
    :class="{ 'background-disabled': !settings.dynamicBackground }"
    :style="{ '--cover-image': backgroundImage, ...beatStyle }"
  >
    <div class="artwork-background" />
    <div class="background-overlay" />

    <header class="topbar">
      <div class="brand"><BrandMark :size="22" /><span>{{ musicConfig.siteName }}</span></div>
      <div class="top-actions">
        <span v-if="failedSources" class="source-warning">{{ notice }}</span>
        <button
          class="nav-button"
          aria-label="分享当前歌曲"
          title="分享歌曲"
          :disabled="!currentTrack"
          @click="shareCurrentTrack"
        >
          <Share2 :size="19" />
        </button>
        <button class="nav-button" aria-label="打开设置" title="设置" @click="settingsOpen = true"><Settings :size="19" /></button>
      </div>
    </header>

    <div v-if="notice && !failedSources" class="notice">{{ notice }}</div>

    <section class="now-playing-layout" :class="{ 'lyrics-hidden': !lyricsVisible }">
      <div v-if="lyricAvailability !== 'unavailable'" class="mobile-view-tabs">
        <button :class="{ active: mobileView === 'cover' }" @click="mobileView = 'cover'">正在播放</button>
        <button :class="{ active: mobileView === 'lyrics' && lyricsEnabled }" @click="showMobileLyrics">歌词</button>
      </div>

      <article class="artwork-column" :class="{ 'mobile-hidden': lyricsVisible && mobileView !== 'cover' }">
        <div class="artwork-frame" :class="{ loaded: currentTrack && loadedCovers.has(currentTrack.id) }">
          <div class="empty-artwork"><Music :size="76" fill="currentColor" /><span>MELIORA</span></div>
          <img
            v-if="currentTrack?.cover && !failedCovers.has(currentTrack.id)"
            :src="currentTrack.cover"
            :alt="`${currentTrack.title} 封面`"
            @load="handleMainCoverLoaded(currentTrack.id, $event)"
            @error="markCoverFailed(currentTrack.id)"
          />
        </div>
        <div class="primary-meta">
          <h1>{{ currentTrack?.title || '选择一首音乐' }}</h1>
          <p>{{ currentTrack?.artist || '从曲库开始播放' }}</p>
        </div>
      </article>

      <LyricsPanel
        class="lyrics-column"
        :class="{ 'mobile-hidden': mobileView !== 'lyrics', 'lyrics-disabled': !lyricsVisible }"
        @seek="seek"
        @availability="handleLyricAvailability"
        @snapshot="handleLyricsSnapshot"
      />
      <div class="mobile-shared-controls" :class="{ 'lyrics-mode': mobileView === 'lyrics' }">
        <PlayerControls variant="page" :on-toggle="toggle" :on-previous="previous" :on-next="() => next()" :on-seek="seek" />
        <div class="mobile-control-actions">
          <button :aria-label="playModeText" :title="playModeText" @click="store.cyclePlayMode">
            <component :is="playModeIcon" :size="20" />
          </button>
          <button aria-label="打开曲库" title="曲库" @click="listOpen = true">
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
        <PlayerControls variant="bar" :on-toggle="toggle" :on-previous="previous" :on-next="() => next()" :on-seek="seek" />
      </div>
      <div class="bottom-progress">
        <PlayerControls variant="progress" :on-toggle="toggle" :on-previous="previous" :on-next="() => next()" :on-seek="seek" />
      </div>
      <div class="dock-actions">
        <button :aria-label="playModeText" :title="playModeText" @click="store.cyclePlayMode">
          <component :is="playModeIcon" :size="19" />
        </button>
        <button aria-label="打开曲库" title="曲库" @click="listOpen = true">
          <ListMusic :size="20" />
        </button>
        <button
          :class="{ active: lyricsVisible }"
          :aria-label="lyricsVisible ? '隐藏歌词' : '显示歌词'"
          :title="lyricAvailability === 'unavailable' ? '暂无歌词' : lyricsVisible ? '隐藏歌词' : '显示歌词'"
          :disabled="lyricAvailability === 'unavailable'"
          @click="toggleLyrics"
        >
          <MessageSquareText :size="19" />
        </button>
      </div>
    </footer>

    <Transition name="backdrop">
      <div v-if="listOpen || settingsOpen" class="drawer-backdrop" @click="closePanels" />
    </Transition>

    <Transition name="drawer">
      <aside v-if="listOpen" class="side-drawer library-drawer" aria-label="曲库">
        <button class="drawer-close" aria-label="关闭曲库" @click="listOpen = false"><X :size="19" /></button>
        <TrackList
          :tracks="filteredTracks" :total="store.tracks.length" :current-track-id="currentTrackId"
          :is-playing="isPlaying" :loading="loading" :query="query"
          @update:query="query = $event" @select="selectTrack" @play-all="playAll"
          @shuffle="shuffleAll" @reload="loadTracks"
        />
        <div v-if="currentTrack" class="drawer-mini-player">
          <span class="mini-artwork" :class="{ loaded: loadedCovers.has(currentTrack.id) }">
            <span class="small-cover-placeholder"><Music :size="18" fill="currentColor" /></span>
            <img
              v-if="currentTrack.cover && !failedCovers.has(currentTrack.id)"
              :src="currentTrack.cover"
              alt=""
              @load="markCoverLoaded(currentTrack.id)"
              @error="markCoverFailed(currentTrack.id)"
            />
          </span>
          <div><strong>{{ currentTrack.title }}</strong><small>{{ currentTrack.artist }}</small></div>
          <PlayerControls variant="mini" :on-toggle="toggle" :on-previous="previous" :on-next="() => next()" :on-seek="seek" />
        </div>
      </aside>
    </Transition>

    <Transition name="drawer">
      <aside v-if="settingsOpen" class="side-drawer settings-drawer" aria-label="播放器设置">
        <header>
          <div><h2>播放设置</h2><p>调整播放、歌词与显示</p></div>
          <button class="drawer-close inline" aria-label="关闭设置" @click="settingsOpen = false"><X :size="19" /></button>
        </header>
        <div class="settings-section">
          <div class="setting-group">
            <label><span><SlidersHorizontal :size="17" />音量</span><strong>{{ Math.round(settings.volume * 100) }}%</strong></label>
            <input
              v-model.number="settings.volume"
              class="setting-range"
              type="range"
              min="0"
              max="1"
              step="0.01"
              :style="{ '--setting-progress': `${settings.volume * 100}%` }"
            />
          </div>
          <div class="setting-row">
            <span><strong>播放模式</strong><small>{{ playModeText }}</small></span>
            <button class="value-button" @click="store.cyclePlayMode">{{ playModeText }}</button>
          </div>
          <div class="setting-group">
            <label><span>歌词字号</span><strong>{{ settings.lyricFontSize }}px</strong></label>
            <input
              v-model.number="settings.lyricFontSize"
              class="setting-range"
              type="range"
              min="15"
              max="30"
              step="1"
              :style="{ '--setting-progress': `${((settings.lyricFontSize - 15) / 15) * 100}%` }"
            />
          </div>
        </div>
        <div class="settings-section">
          <label class="setting-row toggle-row">
            <span><strong>平滑切歌</strong><small>切歌前淡出，载入后淡入</small></span>
            <input v-model="settings.smoothTrackChange" type="checkbox" /><i />
          </label>
          <label class="setting-row toggle-row">
            <span><strong>预加载下一首</strong><small>接近播放结束时提前缓冲</small></span>
            <input v-model="settings.preloadNextTrack" type="checkbox" /><i />
          </label>
          <button
            class="setting-row window-setting-row"
            :class="{ active: lyricsWindowOpen }"
            :disabled="!currentTrack"
            @click="openLyricsWindow"
          >
            <span>
              <strong>歌词小窗</strong>
              <small>{{ lyricsWindowOpen ? '小窗已打开' : currentTrack ? '在独立小窗中显示歌曲与歌词' : '选择歌曲后可用' }}</small>
            </span>
            <PictureInPicture2 :size="20" />
          </button>
          <button
            v-if="canInstall && !isInstalled"
            class="setting-row install-row"
            @click="installPwa"
          >
            <span><strong>安装 Meliora</strong><small>添加到桌面并支持离线启动</small></span>
            <Download :size="19" />
          </button>
          <label class="setting-row toggle-row">
            <span><strong>动态封面背景</strong><small>使用当前封面渲染背景</small></span>
            <input v-model="settings.dynamicBackground" type="checkbox" /><i />
          </label>
          <label class="setting-row toggle-row">
            <span><strong>歌词自动滚动</strong><small>自动跟随当前歌词</small></span>
            <input v-model="settings.lyricAutoScroll" type="checkbox" /><i />
          </label>
          <label class="setting-row toggle-row">
            <span><strong>失败后自动跳过</strong><small>继续尝试下一首歌曲</small></span>
            <input v-model="settings.skipOnError" type="checkbox" /><i />
          </label>
        </div>
        <div class="settings-section">
          <div class="setting-group">
            <label><span>背景模糊</span><strong>{{ settings.backgroundBlur }}px</strong></label>
            <input
              v-model.number="settings.backgroundBlur"
              class="setting-range"
              type="range"
              min="45"
              max="130"
              step="1"
              :style="{ '--setting-progress': `${((settings.backgroundBlur - 45) / 85) * 100}%` }"
            />
          </div>
          <div class="setting-group">
            <label><span>背景饱和度</span><strong>{{ Math.round(settings.backgroundSaturation * 100) }}%</strong></label>
            <input
              v-model.number="settings.backgroundSaturation"
              class="setting-range"
              type="range"
              min="0.7"
              max="1.8"
              step="0.05"
              :style="{ '--setting-progress': `${((settings.backgroundSaturation - 0.7) / 1.1) * 100}%` }"
            />
          </div>
          <div class="setting-group">
            <label><span>节奏亮度</span><strong>{{ Math.round(settings.beatBrightness * 100) }}%</strong></label>
            <input
              v-model.number="settings.beatBrightness"
              class="setting-range"
              type="range"
              min="0"
              max="0.65"
              step="0.05"
              :style="{ '--setting-progress': `${(settings.beatBrightness / 0.65) * 100}%` }"
            />
          </div>
        </div>
      </aside>
    </Transition>
  </main>
</template>

<style scoped lang="scss">
.app-shell { position: relative; min-height: 100svh; overflow: hidden; isolation: isolate; }
.artwork-background,.background-overlay { position: fixed; inset: -9%; z-index: -2; pointer-events: none; }
.artwork-background {
  background-image: var(--cover-image);
  background-position: center;
  background-size: cover;
  filter: blur(calc(var(--background-blur) - var(--beat-level) * 8px)) saturate(calc(var(--background-saturation) + var(--beat-level) * .24)) brightness(calc(1 + var(--beat-level) * var(--beat-brightness)));
  opacity: calc(.72 + var(--beat-level) * .16);
  transform: scale(calc(1.18 + var(--beat-level) * .018));
  transition: opacity .12s linear,filter .12s linear,transform .18s ease;
}
.background-overlay { z-index: -1; background: linear-gradient(180deg, rgba(12,12,14,calc(.5 - var(--beat-level) * .1)), rgba(12,12,14,.7) 42%, rgba(10,10,12,.9)), radial-gradient(circle at 20% 18%, rgba(var(--accent-rgb),calc(.12 + var(--beat-level) * .12)), transparent 42%); transition: background .14s linear; }
.background-disabled .artwork-background { opacity: 0; }
.background-disabled .background-overlay {
  background:
    radial-gradient(circle at 22% 18%,rgba(var(--accent-rgb),.44),transparent 42%),
    radial-gradient(circle at 80% 78%,rgba(var(--accent-rgb),.2),transparent 46%),
    linear-gradient(145deg,color-mix(in srgb,var(--accent) 28%,#242428),#101012 72%);
}
.topbar { position: fixed; inset: 0 0 auto; z-index: 20; display: flex; height: 64px; align-items: center; justify-content: space-between; padding: 0 28px; background: linear-gradient(rgba(18,18,20,.42),transparent); }
.brand { display: flex; align-items: center; gap: 9px; color: #fff; font-size: .96rem; font-weight: 650; letter-spacing: -.02em; text-decoration: none; }
.brand-mark { color: var(--accent); filter: drop-shadow(0 0 9px rgba(var(--accent-rgb),.28)); }
.top-actions { display: flex; align-items: center; gap: 4px; }
.nav-button,.bar-actions button,.drawer-close { display: grid; width: 38px; height: 38px; place-items: center; border: 0; border-radius: 50%; background: transparent; color: rgba(255,255,255,.82); cursor: pointer; }
.nav-button:hover,.bar-actions button:hover,.drawer-close:hover { background: rgba(255,255,255,.1); color: #fff; }
.nav-button.active { color: var(--accent); background: rgba(255,255,255,.08); }
.nav-button:disabled { color: rgba(255,255,255,.24); cursor: default; }
.nav-button:disabled:hover { background: transparent; }
.source-warning { margin-right: 8px; color: rgba(255,255,255,.58); font-size: .68rem; }
.notice { position: fixed; top: 67px; left: 50%; z-index: 30; padding: 8px 13px; border-radius: 14px; corner-shape: squircle; background: rgba(30,30,32,.8); color: var(--text); font-size: .72rem; transform: translateX(-50%); backdrop-filter: blur(20px); }
.now-playing-layout {
  --layout-gap: clamp(48px,7vw,120px);
  position: relative;
  height: calc(100svh - 126px);
  padding: 78px clamp(48px,8vw,150px) 24px;
}
.artwork-column {
  position: absolute;
  top: 78px;
  bottom: 24px;
  left: clamp(48px,8vw,150px);
  display: flex;
  width: calc((100% - clamp(96px,16vw,300px) - var(--layout-gap)) * .44);
  min-width: 0;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  transition: width 720ms cubic-bezier(.16,1,.3,1);
}
.lyrics-hidden .artwork-column {
  width: calc(100% - clamp(96px,16vw,300px));
}
.artwork-frame { position: relative; width: min(100%,52vh,520px); aspect-ratio: 1; overflow: hidden; border-radius: 64px; corner-shape: squircle; background: #2c2c2e; box-shadow: 0 46px 110px rgba(0,0,0,.52), 0 18px 48px rgba(var(--accent-rgb),.16), 0 2px 12px rgba(0,0,0,.28); transition: box-shadow .8s ease; }
.artwork-frame img { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .35s ease; }
.artwork-frame.loaded img { opacity: 1; }
.empty-artwork { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 15px; background: radial-gradient(circle at 34% 22%,rgba(255,255,255,.08),transparent 38%),#2c2c2e; color: rgba(255,255,255,.28); }
.empty-artwork span { font-size: .62rem; letter-spacing: .28em; }
.primary-meta { position: relative; width: min(100%,52vh,520px); padding: 24px 2px 0; }
.primary-meta h1 { overflow: hidden; margin: 0; color: #fff; font-size: clamp(1.35rem,2vw,1.85rem); font-weight: 720; letter-spacing: -.045em; text-overflow: ellipsis; white-space: nowrap; }
.primary-meta p { overflow: hidden; margin: 5px 0 0; color: var(--accent); font-size: .95rem; font-weight: 560; text-overflow: ellipsis; white-space: nowrap; }
.lyrics-hidden .primary-meta { text-align: center; }
.lyrics-column {
  position: absolute;
  top: 78px;
  right: clamp(48px,8vw,150px);
  bottom: 24px;
  width: calc((100% - clamp(96px,16vw,300px) - var(--layout-gap)) * .56);
  min-width: 0;
  opacity: 1;
  transform: translateX(0) scale(1);
  transform-origin: left center;
  transition: opacity 440ms ease 160ms,transform 720ms cubic-bezier(.16,1,.3,1),visibility 0s linear;
}
.lyrics-disabled { visibility: hidden; opacity: 0; transform: translateX(32px) scale(.985); pointer-events: none; transition: opacity 260ms ease, transform 600ms cubic-bezier(.4,0,.2,1), visibility 0s linear 600ms; }
.mobile-shared-controls,.mobile-view-tabs { display: none; }
.player-dock {
  position: fixed;
  right: 26px;
  bottom: 12px;
  left: 26px;
  z-index: 25;
  display: grid;
  grid-template-columns: 156px minmax(0,1fr) 132px;
  align-items: stretch;
  gap: 12px;
  height: 56px;
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
  border: 1px solid rgba(255,255,255,.13);
  border-radius: 28px;
  background: rgba(42,41,45,.62);
  box-shadow: 0 12px 38px rgba(0,0,0,.28),inset 0 1px rgba(255,255,255,.08);
  backdrop-filter: blur(34px) saturate(150%);
  pointer-events: auto;
}
.transport-float { padding: 0 14px; }
.bottom-progress { padding: 0 8px; }
.bottom-progress :deep(.range) { height: 11px; }
.bottom-progress :deep(.is-progress) { width: 100%; }
.dock-actions { gap: 2px; padding: 0 9px; }
.dock-actions button,
.mobile-control-actions button {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: rgba(255,255,255,.72);
  cursor: pointer;
  transition: color .18s ease,background .18s ease,transform .18s ease;
}
.dock-actions button:hover,
.mobile-control-actions button:hover { color: #fff; background: rgba(255,255,255,.09); }
.dock-actions button:active,
.mobile-control-actions button:active { transform: scale(.92); }
.dock-actions button.active,
.mobile-control-actions button.active { color: var(--accent); }
.dock-actions button:disabled,
.mobile-control-actions button:disabled { color: rgba(255,255,255,.22); cursor: default; }
.bar-track { display: flex; min-width: 0; align-items: center; gap: 11px; }
.bar-artwork { position: relative; display: grid; width: 42px; height: 42px; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 11px; corner-shape: squircle; background: #2c2c2e; color: var(--text-subtle); }
.bar-artwork img,.mini-artwork img { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .22s ease; }
.bar-artwork.loaded img,.mini-artwork.loaded img { opacity: 1; }
.small-cover-placeholder { position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.26); background: radial-gradient(circle at 32% 22%,rgba(255,255,255,.07),transparent 42%),#2c2c2e; }
.bar-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.bar-copy strong,.bar-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-copy strong { color: #fff; font-size: .7rem; font-weight: 590; }
.bar-copy small { color: var(--text-subtle); font-size: .61rem; }
.bar-actions { display: flex; align-items: center; justify-content: flex-end; gap: 2px; }
.bar-actions button.active { color: var(--accent); }
.drawer-backdrop { position: fixed; inset: 0; z-index: 38; background: rgba(0,0,0,.12); backdrop-filter: blur(2px) saturate(110%); }
.side-drawer { position: fixed; top: 14px; right: 14px; bottom: 116px; z-index: 40; width: min(390px,calc(100vw - 28px)); overflow: hidden; border: 1px solid rgba(255,255,255,.18); border-radius: 34px; corner-shape: squircle; background: linear-gradient(145deg,rgba(72,70,78,.42),rgba(28,27,32,.3)); box-shadow: 0 26px 90px rgba(0,0,0,.28), inset 0 1px rgba(255,255,255,.13); backdrop-filter: blur(56px) saturate(185%) brightness(1.05); }
.drawer-close { position: absolute; top: 14px; right: 14px; z-index: 3; background: rgba(255,255,255,.09); }
.drawer-close.inline { position: static; }
.library-drawer { padding-bottom: 0; }
.library-drawer :deep(.track-header) { padding-right: 42px; }
.drawer-mini-player { position: absolute; right: 12px; bottom: 12px; left: 12px; display: grid; grid-template-columns: 42px minmax(0,1fr) auto; align-items: center; gap: 9px; padding: 8px; border: 1px solid rgba(255,255,255,.12); border-radius: 18px; corner-shape: squircle; background: rgba(255,255,255,.09); box-shadow: 0 8px 30px rgba(0,0,0,.16); backdrop-filter: blur(30px) saturate(160%); }
.drawer-mini-player > .mini-artwork { position: relative; display: grid; width: 42px; height: 42px; place-items: center; overflow: hidden; border-radius: 11px; corner-shape: squircle; background: #2c2c2e; }
.drawer-mini-player > div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.drawer-mini-player strong,.drawer-mini-player small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer-mini-player strong { font-size: .7rem; }
.drawer-mini-player small { color: var(--text-subtle); font-size: .61rem; }
.settings-drawer { top: 64px; bottom: auto; width: min(370px,calc(100vw - 28px)); max-height: calc(100svh - 150px); padding: 22px; overflow-y: auto; }
.settings-drawer { scrollbar-width: none; }
.settings-drawer::-webkit-scrollbar { display: none; }
.settings-drawer header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.settings-drawer h2 { margin: 0; color: #fff; font-size: 1.35rem; letter-spacing: -.035em; }
.settings-drawer header p { margin: 4px 0 0; color: var(--text-subtle); font-size: .7rem; }
.settings-section { overflow: hidden; margin-top: 12px; border: 1px solid rgba(255,255,255,.11); border-radius: 22px; corner-shape: squircle; background: rgba(255,255,255,.075); box-shadow: inset 0 1px rgba(255,255,255,.045); backdrop-filter: blur(22px); }
.setting-group,.setting-row { padding: 15px 14px; border-top: 1px solid rgba(255,255,255,.075); }
.settings-section > :first-child { border-top: 0; }
.setting-group label,.setting-row { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.setting-group label > span,.setting-row > span { display: flex; flex-direction: column; gap: 4px; }
.setting-group label > span { flex-direction: row; align-items: center; gap: 7px; }
.setting-group strong,.setting-row strong { color: #fff; font-size: .8rem; font-weight: 560; }
.setting-row small { color: var(--text-subtle); font-size: .66rem; }
.install-row {
  width: 100%;
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.install-row svg { flex: 0 0 auto; }
.window-setting-row {
  width: 100%;
  border-right: 0;
  border-bottom: 0;
  border-left: 0;
  background: transparent;
  color: rgba(255,255,255,.72);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.window-setting-row.active { color: var(--accent); }
.window-setting-row:disabled { color: rgba(255,255,255,.22); cursor: default; }
.setting-range {
  width: 100%;
  height: 7px;
  margin-top: 16px;
  appearance: none;
  border-radius: 99px;
  background: linear-gradient(
    to right,
    rgba(255,255,255,.88) 0 var(--setting-progress),
    rgba(255,255,255,.18) var(--setting-progress) 100%
  );
  cursor: pointer;
}
.setting-range::-webkit-slider-thumb { width: 0; height: 0; appearance: none; border: 0; }
.setting-range::-moz-range-thumb { width: 0; height: 0; border: 0; }
.value-button { padding: 7px 10px; border: 0; border-radius: 12px; corner-shape: squircle; background: rgba(255,255,255,.09); color: var(--accent); font-size: .68rem; cursor: pointer; }
.toggle-row { position: relative; cursor: pointer; }
.toggle-row input { position: absolute; opacity: 0; }
.toggle-row i { position: relative; width: 42px; height: 24px; flex: 0 0 auto; border-radius: 20px; background: rgba(255,255,255,.16); transition: background .18s ease; }
.toggle-row i::after { position: absolute; top: 3px; left: 3px; width: 18px; height: 18px; border-radius: 50%; background: #fff; content: ''; transition: transform .18s ease; }
.toggle-row input:checked + i { background: var(--accent); }
.toggle-row input:checked + i::after { transform: translateX(18px); }
.drawer-enter-active,.drawer-leave-active { transition: transform .28s cubic-bezier(.2,.75,.25,1); }
.drawer-enter-from,.drawer-leave-to { transform: translateX(100%); }
.backdrop-enter-active,.backdrop-leave-active { transition: opacity .22s ease; }
.backdrop-enter-from,.backdrop-leave-to { opacity: 0; }

@media (max-width: 980px) {
  .now-playing-layout {
    --layout-gap: 44px;
    padding-right: 42px;
    padding-left: 42px;
  }
  .artwork-column {
    left: 42px;
    width: calc((100% - 84px - var(--layout-gap)) * .44);
  }
  .lyrics-hidden .artwork-column { width: calc(100% - 84px); }
  .lyrics-column {
    right: 42px;
    width: calc((100% - 84px - var(--layout-gap)) * .56);
  }
  .artwork-frame,.primary-meta { width: min(100%,44vw); }
  .player-dock { right: 18px; left: 18px; grid-template-columns: 148px minmax(0,1fr) 124px; gap: 10px; }
}

@media (max-width: 720px) {
  .app-shell { min-height: 100svh; overflow: hidden; }
  .topbar {
    height: 58px;
    padding: max(6px,env(safe-area-inset-top)) 14px 0;
    background: linear-gradient(180deg,rgba(10,10,12,.44),transparent);
  }
  .brand { gap: 7px; font-size: .88rem; }
  .brand svg { width: 18px; height: 18px; }
  .top-actions { gap: 0; }
  .nav-button { width: 35px; height: 35px; }
  .source-warning { display: none; }
  .now-playing-layout {
    --mobile-content-width: min(calc(100vw - 40px),38svh,390px);
    position: static;
    display: block;
    height: 100svh;
    padding:
      calc(58px + max(8px,env(safe-area-inset-top)))
      max(20px,env(safe-area-inset-right))
      max(18px,env(safe-area-inset-bottom))
      max(20px,env(safe-area-inset-left));
    transition: none;
  }
  .mobile-view-tabs { display: none; }
  .artwork-column {
    position: static;
    width: auto;
    height: 100%;
    justify-content: flex-start;
    padding: clamp(10px,2.2svh,22px) 0 190px;
    transition: none;
  }
  .lyrics-hidden .artwork-column { width: auto; }
  .artwork-frame {
    width: var(--mobile-content-width);
    flex: 0 0 auto;
    border-radius: clamp(42px,13vw,62px);
    box-shadow: 0 30px 72px rgba(0,0,0,.52),0 14px 38px rgba(var(--accent-rgb),.16),0 2px 10px rgba(0,0,0,.24);
  }
  .primary-meta {
    width: var(--mobile-content-width);
    padding: clamp(18px,3.2svh,26px) 2px 0;
  }
  .primary-meta h1 { font-size: clamp(1.28rem,6vw,1.65rem); line-height: 1.12; }
  .primary-meta p { margin-top: 6px; font-size: clamp(.82rem,3.8vw,.98rem); }
  .lyrics-column {
    position: static;
    width: auto;
    height: 100%;
    padding: 0 0 190px;
    transition: none;
  }
  .lyrics-disabled {
    transform: none;
    transition: none;
  }
  .mobile-shared-controls {
    position: fixed;
    right: max(20px,env(safe-area-inset-right));
    bottom: max(14px,env(safe-area-inset-bottom));
    left: max(20px,env(safe-area-inset-left));
    z-index: 18;
    display: block;
    width: auto;
    padding: 16px 12px 4px;
    background: linear-gradient(180deg,transparent,rgba(12,12,14,.2) 34%,rgba(12,12,14,.46));
    border-radius: 28px;
    corner-shape: squircle;
    transition: background 320ms ease,backdrop-filter 320ms ease;
  }
  .mobile-control-actions {
    display: flex;
    align-items: center;
    justify-content: space-around;
    margin-top: 8px;
    padding: 5px 12px 2px;
    border-top: 1px solid rgba(255,255,255,.08);
  }
  .mobile-control-actions button {
    width: 42px;
    height: 38px;
  }
  .mobile-shared-controls.lyrics-mode {
    background: rgba(28,28,32,.48);
    box-shadow: 0 14px 44px rgba(0,0,0,.24),inset 0 1px rgba(255,255,255,.08);
    backdrop-filter: blur(30px) saturate(160%);
  }
  .mobile-hidden { display: none; }
  .player-dock { display: none; }
  .side-drawer {
    top: 6px;
    right: 6px;
    bottom: 6px;
    width: calc(100vw - 12px);
    border-radius: clamp(30px,9vw,42px);
    background: linear-gradient(145deg,rgba(62,61,68,.56),rgba(24,24,28,.48));
    box-shadow: 0 28px 80px rgba(0,0,0,.38),inset 0 1px rgba(255,255,255,.13);
    backdrop-filter: blur(52px) saturate(180%);
  }
  .drawer-backdrop { display: none; }
  .library-drawer { padding-bottom: calc(78px + env(safe-area-inset-bottom)); }
  .drawer-mini-player { display: grid; }
  .settings-drawer {
    top: 6px;
    bottom: auto;
    width: calc(100vw - 12px);
    max-height: calc(100svh - 12px);
    padding: 22px 18px max(22px,env(safe-area-inset-bottom));
  }
}

@media (max-width: 360px), (max-height: 700px) and (max-width: 720px) {
  .topbar { height: 54px; padding-right: 10px; padding-left: 12px; }
  .brand span { font-size: .8rem; }
  .nav-button { width: 33px; height: 33px; }
  .now-playing-layout {
    --mobile-content-width: min(calc(100vw - 32px),36svh,330px);
    padding-top: calc(54px + max(6px,env(safe-area-inset-top)));
    padding-right: 16px;
    padding-left: 16px;
  }
  .artwork-column { padding: 2px 0 172px; }
  .artwork-frame { width: var(--mobile-content-width); }
  .primary-meta { width: var(--mobile-content-width); padding-top: 16px; }
  .primary-meta h1 { font-size: 1.22rem; }
  .primary-meta p { font-size: .8rem; }
  .lyrics-column { padding-bottom: 172px; }
  .mobile-shared-controls {
    right: 16px;
    bottom: max(8px,env(safe-area-inset-bottom));
    left: 16px;
    padding-top: 10px;
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
  .drawer-mini-player { display: none; }
}
</style>
