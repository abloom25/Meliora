// 播放器的领域类型。曲目、歌词、播放设置 —— 与在哪个平台上播放无关。
//
// 这里**不放配置类型**(曲库来源、站点集成、后台配置那些在 shared/music-config.ts):
// 那些是"这个部署怎么配"的事,后端和构建脚本也要用;核心层只认"在放什么"。

export type PlayMode = 'sequence' | 'loop' | 'single' | 'shuffle'
export type BeatAnalysisMode = 'basic' | 'beat-this-small' | 'beat-this-standard'
export type LyricAvailability = 'available' | 'loading' | 'unavailable'
export type LyricStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
/** 当前歌词正文/时间轴实际采用的来源,不把字级格式当成平台来源。 */
export type LyricProviderSource = 'amll' | 'netease' | 'qq' | 'meting' | 'local'
export type EqPresetId = 'flat' | 'pop' | 'rock' | 'jazz' | 'vocal' | 'bass-boost' | 'custom'

/** 音节时间轴来源。目前只有一种:歌词文件自带的字级时间轴。
 *  没有真实逐字数据的行不做插值合成,整行高亮即可 */
export type LyricWordSource = 'native'

/** 对唱声部。TTML 的 ttm:agent 映射而来,单声部歌词恒为 primary */
export type LyricAgent = 'primary' | 'secondary'

export interface LyricWord {
  /** 音节起始时间(秒) */
  time: number
  /** 音节时长(秒) */
  duration: number
  text: string
  /** 该音节后是否跟随一个空格(拉丁文分词后仍要还原原始排版) */
  trailingSpace?: boolean
}

export interface LyricLine {
  time: number | null
  text: string
  translation?: string
  /** 罗马音/音译,目前仅 TTML 源提供 */
  roman?: string
  /** 行结束时间(秒)。缺省时由下一行起始时间推算 */
  endTime?: number
  /** 逐字音节序列。缺省表示该行只有行级时间 */
  words?: LyricWord[]
  /** 音节时间轴来源,用于区分真实逐字与插值兜底 */
  wordSource?: LyricWordSource
  /** 对唱声部,决定该行左对齐还是右对齐 */
  agent?: LyricAgent
  /** 背景和声行(TTML 的 x-bg),渲染为更小更淡的附属行 */
  background?: boolean
}

export interface Track {
  id: string
  title: string
  titleVersions?: string[]
  shareAliases?: string[]
  artist: string
  album?: string
  cover?: string
  audioUrl: string
  kind: 'meting' | 'remote' | 'local'
}

export interface LyricsSnapshot {
  lines: LyricLine[]
  /** 当前显示歌词的主来源;翻译/音译补充不会改变此值。 */
  source?: LyricProviderSource
  /** 锚点行:最前面的高亮主句组,无高亮时保留最近主句位置 */
  activeIndex: number
  /** 当前正在唱的所有行。对唱双声部与背景和声可以同时在唱,缺省视为只有锚点行 */
  activeIndices?: number[]
  status: LyricStatus
  /** 快节奏歌词下的动画压缩系数(1 = 完整节奏,0 = 瞬切),缺省按 1 处理 */
  tempoScale?: number
}

export interface EqualizerSettings {
  enabled: boolean
  preset: EqPresetId
  bands: number[]
}

export interface PlayerSettings {
  volume: number
  playMode: PlayMode
  smoothTrackChange: boolean
  preloadNextTrack: boolean
  adaptivePerformance: boolean
  tabCoordination: boolean
  syncTabPlayback: boolean
  dynamicBackground: boolean
  /** 背景随节奏闪光(与动态封面背景独立) */
  beatFlash: boolean
  /** 默认基础模式；增强模型由用户手动下载并启用，均在播放后预构建。 */
  beatAnalysisMode: BeatAnalysisMode
  backgroundBlur: number
  backgroundSaturation: number
  beatBrightness: number
  /** 闪烁密度:每拍最多闪几次(0.5 / 1 / 2 / 4),见 core/analysis/beat-envelope.ts */
  beatFlashRate: number
  /** 闪光延迟微调(ms),叠加在按输出延迟自动补偿之上;0 = 自动 */
  beatVisualDelay: number
  /** 歌词在自适应字号基础上的缩放倍率(1 = 100%)。 */
  lyricScale: number
  lyricAnimation: boolean
  /** 歌词牵引滚动的弹簧刚度系数(1 = 默认)。越大越紧绷、越快到位,越小越绵软 */
  lyricSpring: number
  lyricTranslation: boolean
  lyricRomanization: boolean
  /** null follows the main lyric scale; otherwise remembers an independent window scale. */
  lyricWindowScale: number | null
  progressLyricPreview: boolean
  skipOnError: boolean
  autoHideChrome: boolean
  /** 手动开启后显示独立的播放器调试入口。 */
  debugPanelEnabled: boolean
  equalizer: EqualizerSettings
  settingsVersion: number
}
