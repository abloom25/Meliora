export type MusicServer = 'netease' | 'tencent'
export type PlayMode = 'sequence' | 'loop' | 'single' | 'shuffle'
export type LyricAvailability = 'available' | 'loading' | 'unavailable'
export type LyricStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'
export type EqPresetId = 'flat' | 'pop' | 'rock' | 'jazz' | 'vocal' | 'bass-boost' | 'custom'

export interface MetingPlaylistConfig {
  server: MusicServer
  playlistId: string
  enabled?: boolean
}

export interface LocalTrackConfig {
  id: string
  title: string
  artist: string
  audio: string
  album?: string
  cover?: string
  lyrics?: string
}

export interface UmamiConfig {
  enabled?: boolean
  scriptUrl?: string
  websiteId?: string
}

export interface GoogleAnalyticsConfig {
  enabled?: boolean
  measurementId?: string
}

export interface PublicMusicConfig {
  siteName: string
  siteIcon?: string
  apiEndpoint: string
  umami?: UmamiConfig
  googleAnalytics?: GoogleAnalyticsConfig
  googleSiteVerification?: string
  customCss?: string
  customJs?: string
  playlists: MetingPlaylistConfig[]
  localTracks: LocalTrackConfig[]
}

export interface MusicConfig extends PublicMusicConfig {
  apiToken?: string
  githubProxy?: string
  receivePrereleaseUpdates?: boolean
}

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

export interface MetingTrack {
  title?: string
  author?: string
  pic?: string
  url?: string
  lrc?: string
}

export interface LyricsSnapshot {
  lines: LyricLine[]
  /** 锚点行:活跃集合里最靠后的主行,决定居中与前后分段 */
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
  dynamicBackground: boolean
  /** 背景随节奏闪光(与动态封面背景独立) */
  beatFlash: boolean
  backgroundBlur: number
  backgroundSaturation: number
  beatBrightness: number
  /** 闪烁密度:每拍最多闪几次(0.5 / 1 / 2 / 4),见 utils/beat-envelope.ts */
  beatFlashRate: number
  /** 闪光延迟微调(ms),叠加在按输出延迟自动补偿之上;0 = 自动 */
  beatVisualDelay: number
  lyricFontSize: number
  lyricAnimation: boolean
  /** 歌词牵引滚动的弹簧刚度系数(1 = 默认)。越大越紧绷、越快到位,越小越绵软 */
  lyricSpring: number
  lyricTranslation: boolean
  progressLyricPreview: boolean
  skipOnError: boolean
  autoHideChrome: boolean
  equalizer: EqualizerSettings
  settingsVersion: number
}
