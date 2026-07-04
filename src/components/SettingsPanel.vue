<script setup lang="ts">
  import { Download, GitFork, PictureInPicture2, SlidersHorizontal } from '@lucide/vue'
  import { storeToRefs } from 'pinia'
  import { APP_VERSION } from '../generated/app-version'
  import { usePlayerStore } from '../stores/player'
  import EqualizerPanel from './EqualizerPanel.vue'
  import SettingRange from './SettingRange.vue'
  import SleepTimerControl from './SleepTimerControl.vue'
  import ToggleSwitch from './ToggleSwitch.vue'

  const REPO_URL = 'https://github.com/abloom25/Meliora'

  const { settings } = storeToRefs(usePlayerStore())

  interface Props {
    playModeText: string
    sleepTimerMinutes: number
    sleepTimerRemaining: number
    sleepTimerDisplayMinutes: number
    sleepTimerProgress: number
    sleepTimerOptions: readonly number[]
    formatSleepTimerRemaining: (value: number) => string
    portableDevice: boolean
    fullscreenActive: boolean
    fullscreenSupported: boolean
    lyricsWindowSupported: boolean
    lyricsWindowOpen: boolean
    hasCurrentTrack: boolean
    canInstall: boolean
    isInstalled: boolean
    iosInstallAvailable: boolean
  }

  defineProps<Props>()

  const emit = defineEmits<{
    cyclePlayMode: []
    sleepTimerInput: [value: number]
    sleepTimerChange: [value: number]
    toggleFullscreenMode: []
    openLyricsWindow: []
    installPwa: []
    showIosInstallGuide: []
  }>()
</script>

<template>
  <div class="settings-scroll">
    <div class="settings-section">
      <h3 class="settings-section-title">播放</h3>
      <div class="setting-group">
        <label
          ><span><SlidersHorizontal :size="17" /><strong>音量</strong></span
          ><strong>{{ Math.round(settings.volume * 100) }}%</strong></label
        >
        <SettingRange
          v-model="settings.volume"
          aria-label="音量"
          :aria-value-text="`${Math.round(settings.volume * 100)}%`"
          :min="0"
          :max="1"
          :step="0.01"
        />
      </div>
      <div class="setting-row">
        <span
          ><strong>播放模式</strong><small>{{ playModeText }}</small></span
        >
        <button class="value-button" @click="emit('cyclePlayMode')">
          {{ playModeText }}
        </button>
      </div>
      <div class="setting-row toggle-row">
        <span><strong>平滑切歌</strong><small>切歌前淡出，载入后淡入</small></span>
        <ToggleSwitch v-model="settings.smoothTrackChange" aria-label="平滑切歌" />
      </div>
      <div class="setting-row toggle-row">
        <span><strong>预加载前后歌曲</strong><small>当前歌曲载入后准备上一首和下一首</small></span>
        <ToggleSwitch v-model="settings.preloadNextTrack" aria-label="预加载前后歌曲" />
      </div>
      <SleepTimerControl
        :minutes="sleepTimerMinutes"
        :remaining="sleepTimerRemaining"
        :display-minutes="sleepTimerDisplayMinutes"
        :progress="sleepTimerProgress"
        :options="sleepTimerOptions"
        :format-remaining="formatSleepTimerRemaining"
        @input="emit('sleepTimerInput', $event)"
        @change="emit('sleepTimerChange', $event)"
      />
      <div class="setting-row toggle-row">
        <span><strong>失败后自动跳过</strong><small>继续尝试下一首歌曲</small></span>
        <ToggleSwitch v-model="settings.skipOnError" aria-label="失败后自动跳过" />
      </div>
    </div>

    <EqualizerPanel
      :enabled="settings.equalizer.enabled"
      :preset="settings.equalizer.preset"
      :bands="settings.equalizer.bands"
      @update:enabled="settings.equalizer.enabled = $event"
      @update:preset="settings.equalizer.preset = $event"
      @update:bands="settings.equalizer.bands = $event"
    />

    <div class="settings-section">
      <h3 class="settings-section-title">显示</h3>
      <div class="setting-row toggle-row">
        <span><strong>自动隐藏上下控件</strong><small>鼠标闲置 30 秒后只保留歌曲内容</small></span>
        <ToggleSwitch v-model="settings.autoHideChrome" aria-label="自动隐藏上下控件" />
      </div>
      <div v-if="!portableDevice && fullscreenSupported" class="setting-row toggle-row">
        <span
          ><strong>全屏模式</strong
          ><small>{{ fullscreenActive ? '已进入全屏' : '让播放器占满整个屏幕' }}</small></span
        >
        <ToggleSwitch
          :model-value="fullscreenActive"
          aria-label="全屏模式"
          @update:model-value="emit('toggleFullscreenMode')"
        />
      </div>
      <div class="setting-group">
        <label
          ><span><strong>歌词字号</strong></span
          ><strong>{{ settings.lyricFontSize }}px</strong></label
        >
        <SettingRange
          v-model="settings.lyricFontSize"
          aria-label="歌词字号"
          :aria-value-text="`${settings.lyricFontSize}px`"
          :min="15"
          :max="30"
          :step="1"
        />
      </div>
      <div class="setting-row toggle-row">
        <span><strong>歌词动画</strong><small>开启牵拉、淡入淡出与状态切换动画</small></span>
        <ToggleSwitch v-model="settings.lyricAnimation" aria-label="歌词动画" />
      </div>
      <div class="setting-row toggle-row">
        <span><strong>歌词翻译</strong><small>显示歌词中解析出的翻译文本</small></span>
        <ToggleSwitch v-model="settings.lyricTranslation" aria-label="歌词翻译" />
      </div>
      <div class="setting-row toggle-row">
        <span><strong>进度条歌词预览</strong><small>悬停进度条时显示对应时间的歌词</small></span>
        <ToggleSwitch v-model="settings.progressLyricPreview" aria-label="进度条歌词预览" />
      </div>
      <button
        v-if="lyricsWindowSupported"
        class="setting-row window-setting-row"
        :class="{ active: lyricsWindowOpen }"
        :disabled="!hasCurrentTrack"
        @click="emit('openLyricsWindow')"
      >
        <span>
          <strong>歌词小窗</strong>
          <small>{{
            lyricsWindowOpen
              ? '小窗已打开'
              : hasCurrentTrack
                ? '在独立小窗中显示歌曲与歌词'
                : '选择歌曲后可用'
          }}</small>
        </span>
        <PictureInPicture2 :size="20" />
      </button>
      <button
        v-if="canInstall && !isInstalled"
        class="setting-row install-row"
        @click="emit('installPwa')"
      >
        <span><strong>安装 Meliora</strong><small>添加到桌面并支持离线启动</small></span>
        <Download :size="19" />
      </button>
      <button
        v-if="iosInstallAvailable && !canInstall"
        class="setting-row install-row"
        @click="emit('showIosInstallGuide')"
      >
        <span><strong>安装 Meliora</strong><small>通过 Safari 分享菜单添加到主屏幕</small></span>
        <Download :size="19" />
      </button>
    </div>

    <div class="settings-section">
      <h3 class="settings-section-title">背景</h3>
      <div class="setting-row toggle-row">
        <span><strong>动态封面背景</strong><small>使用当前封面渲染背景</small></span>
        <ToggleSwitch v-model="settings.dynamicBackground" aria-label="动态封面背景" />
      </div>
      <div class="setting-group">
        <label
          ><span><strong>背景模糊</strong></span
          ><strong>{{ settings.backgroundBlur }}px</strong></label
        >
        <SettingRange
          v-model="settings.backgroundBlur"
          aria-label="背景模糊"
          :aria-value-text="`${settings.backgroundBlur}px`"
          :min="45"
          :max="130"
          :step="1"
        />
      </div>
      <div class="setting-group">
        <label
          ><span><strong>背景饱和度</strong></span
          ><strong>{{ Math.round(settings.backgroundSaturation * 100) }}%</strong></label
        >
        <SettingRange
          v-model="settings.backgroundSaturation"
          aria-label="背景饱和度"
          :aria-value-text="`${Math.round(settings.backgroundSaturation * 100)}%`"
          :min="0.7"
          :max="1.8"
          :step="0.05"
        />
      </div>
      <div class="setting-group">
        <label
          ><span><strong>节奏亮度</strong></span
          ><strong>{{ Math.round(settings.beatBrightness * 100) }}%</strong></label
        >
        <SettingRange
          v-model="settings.beatBrightness"
          aria-label="节奏亮度"
          :aria-value-text="`${Math.round(settings.beatBrightness * 100)}%`"
          :min="0"
          :max="0.65"
          :step="0.05"
        />
      </div>
    </div>

    <div class="settings-section about-section">
      <h3 class="settings-section-title">关于</h3>
      <div class="about-block">
        <div class="about-headline">
          <span class="about-name">Meliora</span>
          <span class="about-version">v{{ APP_VERSION }}</span>
        </div>
        <a class="about-repo" :href="REPO_URL" target="_blank" rel="noopener noreferrer">
          <GitFork :size="16" />
          <span>GitHub 仓库</span>
        </a>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
  .settings-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-right: 2px;
    padding-bottom: 18px;
    mask-image: linear-gradient(
      180deg,
      transparent 0,
      #000 24px,
      #000 calc(100% - 34px),
      transparent 100%
    );
    scrollbar-width: none;
  }
  .settings-scroll::-webkit-scrollbar {
    display: none;
  }
  .settings-section {
    overflow: hidden;
    margin-top: 12px;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 22px;
    corner-shape: squircle;
    background: rgba(255, 255, 255, 0.075);
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.045);
    backdrop-filter: blur(22px);
  }
  .settings-section-title {
    margin: 0;
    padding: 12px 14px 10px;
    color: rgba(255, 255, 255, 0.48);
    font-size: 0.62rem;
    font-weight: 680;
    letter-spacing: 0.08em;
  }
  .setting-group,
  .setting-row {
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }
  .settings-section > :first-child {
    border-top: 0;
  }
  .about-section {
    margin-top: 14px;
  }
  .about-block {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }
  .about-headline {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
  }
  .about-name {
    color: #fff;
    font-size: 0.92rem;
    font-weight: 680;
    letter-spacing: -0.02em;
  }
  .about-version {
    color: var(--text-subtle);
    font-size: 0.68rem;
    font-variant-numeric: tabular-nums;
  }
  .about-repo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 10px 14px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 14px;
    corner-shape: squircle;
    background: rgba(var(--accent-rgb), 0.16);
    color: var(--accent);
    font-size: 0.78rem;
    font-weight: 560;
    text-decoration: none;
    transition:
      background 0.2s cubic-bezier(0.16, 1, 0.3, 1),
      border-color 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .about-repo:hover {
    background: rgba(var(--accent-rgb), 0.28);
    border-color: rgba(var(--accent-rgb), 0.5);
  }
  .about-repo:active {
    transform: scale(0.98);
  }
  .setting-group label,
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }
  .setting-group label > span,
  .setting-row > span {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .setting-group label > span {
    flex-direction: row;
    align-items: center;
    gap: 7px;
  }
  .setting-group strong,
  .setting-row strong {
    color: #fff;
    font-size: 0.8rem;
    font-weight: 560;
  }
  .setting-row small {
    color: var(--text-subtle);
    font-size: 0.66rem;
  }
  .install-row {
    width: 100%;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.88);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .install-row svg {
    flex: 0 0 auto;
  }
  .window-setting-row {
    width: 100%;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.72);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .window-setting-row.active {
    color: rgba(255, 255, 255, 0.92);
    background: rgba(var(--accent-rgb), 0.1);
  }
  .window-setting-row:disabled {
    color: rgba(255, 255, 255, 0.22);
    cursor: default;
  }
  .value-button {
    padding: 7px 10px;
    border: 0;
    border-radius: 12px;
    corner-shape: squircle;
    background: rgba(var(--accent-rgb), 0.12);
    color: rgba(255, 255, 255, 0.9);
    font-size: 0.68rem;
    cursor: pointer;
  }
  .setting-value {
    color: rgba(255, 255, 255, 0.7);
    font-size: 0.68rem;
    font-weight: 560;
  }

  @media (max-width: 720px) {
    .settings-scroll {
      margin: 0 -3px;
      padding: 0 3px max(18px, env(safe-area-inset-bottom));
      mask-image: linear-gradient(
        180deg,
        transparent 0,
        #000 18px,
        #000 calc(100% - 26px),
        transparent 100%
      );
    }
    .settings-section {
      margin-top: 9px;
      border-radius: 20px;
    }
    .settings-section-title {
      padding: 11px 12px 8px;
      font-size: 0.58rem;
    }
    .setting-group,
    .setting-row {
      padding: 13px 12px;
    }
    .setting-group label,
    .setting-row {
      gap: 14px;
    }
    .setting-group strong,
    .setting-row strong {
      font-size: 0.76rem;
    }
    .setting-row small {
      font-size: 0.62rem;
      line-height: 1.35;
    }
    .value-button {
      padding: 7px 10px;
      flex: 0 0 auto;
    }
  }

  @media (max-width: 360px), (max-height: 700px) and (max-width: 720px) {
    .settings-section {
      margin-top: 7px;
      border-radius: 18px;
    }
    .settings-section-title {
      padding: 9px 10px 7px;
    }
    .setting-group,
    .setting-row {
      padding: 11px 10px;
    }
  }
</style>
