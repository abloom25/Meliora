<script setup lang="ts">
  import { Download, GitFork, PictureInPicture2, SlidersHorizontal } from '@lucide/vue'
  import { storeToRefs } from 'pinia'
  import { computed } from 'vue'
  import { BEAT_FLASH_RATE_STEPS, sanitizeBeatFlashRate } from '../utils/beat-envelope'
  import { APP_VERSION } from '../generated/app-version'
  import { usePlayerStore, type ResettableSettingKey } from '../stores/player'
  import Collapse from './Collapse.vue'
  import EqualizerPanel from './EqualizerPanel.vue'
  import SettingSlider from './SettingSlider.vue'
  import SettingToggleRow from './SettingToggleRow.vue'
  import SettingsSectionHeader from './SettingsSectionHeader.vue'
  import SleepTimerControl from './SleepTimerControl.vue'
  import ToggleSwitch from './ToggleSwitch.vue'

  const REPO_URL = 'https://github.com/abloom25/Meliora'

  const store = usePlayerStore()
  const { settings } = storeToRefs(store)

  // 各分组「恢复默认」覆盖的设置项。均衡器有自己的预设,不在这里重置
  const PLAYBACK_KEYS: readonly ResettableSettingKey[] = [
    'volume',
    'playMode',
    'smoothTrackChange',
    'preloadNextTrack',
    'skipOnError',
  ]
  const LYRICS_KEYS: readonly ResettableSettingKey[] = [
    'lyricFontSize',
    'lyricAnimation',
    'lyricSpring',
    'lyricTranslation',
    'progressLyricPreview',
  ]
  const DISPLAY_KEYS: readonly ResettableSettingKey[] = ['autoHideChrome']
  const BACKGROUND_KEYS: readonly ResettableSettingKey[] = [
    'dynamicBackground',
    'beatFlash',
    'backgroundBlur',
    'backgroundSaturation',
    'beatBrightness',
    'beatFlashRate',
    'beatVisualDelay',
  ]

  // 闪烁频率滑块:档位吸附,滑块值是档位下标,存储的是每拍闪烁次数
  const BEAT_FLASH_RATE_LABELS = ['每 2 拍', '每拍', '每半拍', '每 ¼ 拍'] as const
  const beatFlashRateIndex = computed({
    get: () => BEAT_FLASH_RATE_STEPS.indexOf(sanitizeBeatFlashRate(settings.value.beatFlashRate)),
    set: (index: number) => {
      const clamped = Math.max(0, Math.min(BEAT_FLASH_RATE_STEPS.length - 1, Math.round(index)))
      settings.value.beatFlashRate = BEAT_FLASH_RATE_STEPS[clamped] ?? 1
    },
  })
  const beatFlashRateLabel = computed(
    () => BEAT_FLASH_RATE_LABELS[beatFlashRateIndex.value] ?? BEAT_FLASH_RATE_LABELS[1],
  )
  // 闪光延迟:0 表示只用按设备输出延迟的自动补偿;正值让画面更晚,负值更早
  const beatVisualDelayLabel = computed(() => {
    const value = Math.round(settings.value.beatVisualDelay)
    if (value === 0) return '自动'
    return `${value > 0 ? '+' : '−'}${Math.abs(value)} ms`
  })

  const volumeLabel = computed(() => `${Math.round(settings.value.volume * 100)}%`)
  const lyricSpringLabel = computed(() => `×${settings.value.lyricSpring.toFixed(2)}`)
  const backgroundSaturationLabel = computed(
    () => `${Math.round(settings.value.backgroundSaturation * 100)}%`,
  )
  const beatBrightnessLabel = computed(() => `${Math.round(settings.value.beatBrightness * 100)}%`)

  interface SleepTimerState {
    minutes: number
    remaining: number
    displayMinutes: number
    progress: number
    options: readonly number[]
    formatRemaining: (value: number) => string
  }

  /** 由 PlayerView 侧的 composable 决定的能力/状态,面板只读不管来源 */
  interface SettingsCapabilities {
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

  defineProps<{
    playModeText: string
    sleepTimer: SleepTimerState
    capabilities: SettingsCapabilities
  }>()

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
    <section class="settings-section">
      <SettingsSectionHeader title="播放" resettable @reset="store.resetSettings(PLAYBACK_KEYS)" />
      <SettingSlider
        v-model="settings.volume"
        label="音量"
        :value-text="volumeLabel"
        :min="0"
        :max="1"
        :step="0.01"
      >
        <template #icon><SlidersHorizontal :size="17" /></template>
      </SettingSlider>
      <div class="setting-row">
        <span><strong>播放模式</strong><small>顺序 / 随机 / 单曲循环</small></span>
        <button class="value-button" @click="emit('cyclePlayMode')">
          {{ playModeText }}
        </button>
      </div>
      <SettingToggleRow
        v-model="settings.smoothTrackChange"
        label="平滑切歌"
        description="切歌前淡出，载入后淡入"
      />
      <SettingToggleRow
        v-model="settings.preloadNextTrack"
        label="预加载前后歌曲"
        description="当前歌曲载入后准备上一首和下一首"
      />
      <SleepTimerControl
        :minutes="sleepTimer.minutes"
        :remaining="sleepTimer.remaining"
        :display-minutes="sleepTimer.displayMinutes"
        :progress="sleepTimer.progress"
        :options="sleepTimer.options"
        :format-remaining="sleepTimer.formatRemaining"
        @input="emit('sleepTimerInput', $event)"
        @change="emit('sleepTimerChange', $event)"
      />
      <SettingToggleRow
        v-model="settings.skipOnError"
        label="失败后自动跳过"
        description="继续尝试下一首歌曲"
      />
    </section>

    <EqualizerPanel
      :enabled="settings.equalizer.enabled"
      :preset="settings.equalizer.preset"
      :bands="settings.equalizer.bands"
      @update:enabled="settings.equalizer.enabled = $event"
      @update:preset="settings.equalizer.preset = $event"
      @update:bands="settings.equalizer.bands = $event"
    />

    <section class="settings-section">
      <SettingsSectionHeader title="歌词" resettable @reset="store.resetSettings(LYRICS_KEYS)" />
      <SettingSlider
        v-model="settings.lyricFontSize"
        label="歌词字号"
        :value-text="`${settings.lyricFontSize}px`"
        :min="15"
        :max="30"
      />
      <SettingToggleRow
        v-model="settings.lyricAnimation"
        label="歌词动画"
        description="开启牵拉、逐字扫光与状态切换动画"
      />
      <!-- 弹簧只在牵拉动画开着时才有作用对象 -->
      <Collapse :expanded="settings.lyricAnimation">
        <SettingSlider
          v-model="settings.lyricSpring"
          label="歌词弹簧"
          description="越大越紧绷利落,越小越绵软拖沓"
          :value-text="lyricSpringLabel"
          :min="0.5"
          :max="2"
          :step="0.05"
        />
      </Collapse>
      <SettingToggleRow
        v-model="settings.lyricTranslation"
        label="歌词翻译"
        description="显示歌词中解析出的翻译文本"
      />
      <SettingToggleRow
        v-if="!capabilities.portableDevice"
        v-model="settings.progressLyricPreview"
        label="进度条歌词预览"
        description="悬停进度条时显示对应时间的歌词"
      />
      <button
        v-if="capabilities.lyricsWindowSupported"
        class="setting-row window-setting-row"
        :class="{ active: capabilities.lyricsWindowOpen }"
        :disabled="!capabilities.hasCurrentTrack"
        @click="emit('openLyricsWindow')"
      >
        <span>
          <strong>歌词小窗</strong>
          <small>{{
            capabilities.lyricsWindowOpen
              ? '小窗已打开'
              : capabilities.hasCurrentTrack
                ? '在独立小窗中显示歌曲与歌词'
                : '选择歌曲后可用'
          }}</small>
        </span>
        <PictureInPicture2 :size="20" />
      </button>
    </section>

    <section class="settings-section">
      <SettingsSectionHeader title="显示" resettable @reset="store.resetSettings(DISPLAY_KEYS)" />
      <SettingToggleRow
        v-model="settings.autoHideChrome"
        label="自动隐藏上下控件"
        description="鼠标闲置 30 秒后只保留歌曲内容"
      />
      <div
        v-if="!capabilities.portableDevice && capabilities.fullscreenSupported"
        class="setting-row toggle-row"
      >
        <span
          ><strong>全屏模式</strong
          ><small>{{
            capabilities.fullscreenActive ? '已进入全屏' : '让播放器占满整个屏幕'
          }}</small></span
        >
        <ToggleSwitch
          :model-value="capabilities.fullscreenActive"
          aria-label="全屏模式"
          @update:model-value="emit('toggleFullscreenMode')"
        />
      </div>
    </section>

    <section class="settings-section">
      <SettingsSectionHeader
        title="背景"
        resettable
        @reset="store.resetSettings(BACKGROUND_KEYS)"
      />
      <SettingToggleRow
        v-model="settings.dynamicBackground"
        label="动态封面背景"
        description="使用当前封面渲染背景"
      />
      <!-- 关掉封面背景后这两项没有作用对象,收起来而不是留一排拖不动结果的滑块 -->
      <Collapse :expanded="settings.dynamicBackground">
        <SettingSlider
          v-model="settings.backgroundBlur"
          label="背景模糊"
          :value-text="`${settings.backgroundBlur}px`"
          :min="45"
          :max="130"
        />
        <SettingSlider
          v-model="settings.backgroundSaturation"
          label="背景饱和度"
          :value-text="backgroundSaturationLabel"
          :min="0.7"
          :max="1.8"
          :step="0.05"
        />
      </Collapse>
      <SettingToggleRow
        v-model="settings.beatFlash"
        label="节奏闪光"
        description="背景随音乐的节奏亮起"
      />
      <!-- 同上:闪光关掉后亮度 / 频率 / 延迟都无处生效 -->
      <Collapse :expanded="settings.beatFlash">
        <SettingSlider
          v-model="settings.beatBrightness"
          label="节奏亮度"
          :value-text="beatBrightnessLabel"
          :min="0"
          :max="0.65"
          :step="0.05"
        />
        <SettingSlider
          v-model="beatFlashRateIndex"
          label="闪烁频率"
          :value-text="beatFlashRateLabel"
          :min="0"
          :max="BEAT_FLASH_RATE_STEPS.length - 1"
        />
        <SettingSlider
          v-model="settings.beatVisualDelay"
          label="闪光延迟"
          description="闪光比声音早就调大,晚就调小"
          :value-text="beatVisualDelayLabel"
          :min="-100"
          :max="300"
          :step="10"
        />
      </Collapse>
    </section>

    <section class="settings-section about-section">
      <SettingsSectionHeader title="关于" />
      <button
        v-if="capabilities.canInstall && !capabilities.isInstalled"
        class="setting-row install-row"
        @click="emit('installPwa')"
      >
        <span><strong>安装 Meliora</strong><small>添加到桌面并支持离线启动</small></span>
        <Download :size="19" />
      </button>
      <button
        v-if="capabilities.iosInstallAvailable && !capabilities.canInstall"
        class="setting-row install-row"
        @click="emit('showIosInstallGuide')"
      >
        <span><strong>安装 Meliora</strong><small>通过 Safari 分享菜单添加到主屏幕</small></span>
        <Download :size="19" />
      </button>
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
    </section>
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
  .setting-group,
  .setting-row {
    padding: 15px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.075);
  }
  // 分组标题后的第一项不画分隔线
  .settings-section-header + * {
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
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
  }
  .setting-row > span {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
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

  @media (max-width: 720px) {
    .settings-scroll {
      margin: 0 -2px;
      padding: 0 2px max(56px, calc(18px + env(safe-area-inset-bottom)));
      mask-image: linear-gradient(
        180deg,
        transparent 0,
        #000 18px,
        #000 calc(100% - 72px),
        transparent 100%
      );
    }
    .settings-section {
      margin-top: 9px;
      border-radius: 20px;
    }
    .setting-group,
    .setting-row {
      padding: 13px 12px;
    }
    .setting-row {
      gap: 14px;
    }
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
    .setting-group,
    .setting-row {
      padding: 11px 10px;
    }
  }
</style>
