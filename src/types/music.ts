export type MusicServer = 'netease' | 'tencent'
export type PlayMode = 'sequence' | 'loop' | 'single' | 'shuffle'
export type LyricAvailability = 'available' | 'unavailable'
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

export interface Track {
  id: string
  title: string
  artist: string
  album?: string
  cover?: string
  audioUrl: string
  lyricsUrl?: string
  kind: 'meting' | 'local'
}

export interface MetingTrack {
  title?: string
  author?: string
  pic?: string
  url?: string
  lrc?: string
}

export interface LyricLine {
  time: number | null
  text: string
  translation?: string
}

export interface LyricsSnapshot {
  lines: LyricLine[]
  activeIndex: number
  status: 'idle' | 'ready' | 'empty' | 'error'
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
  backgroundBlur: number
  backgroundSaturation: number
  beatBrightness: number
  lyricFontSize: number
  lyricAnimation: boolean
  lyricTranslation: boolean
  skipOnError: boolean
  autoHideChrome: boolean
  equalizer: EqualizerSettings
  settingsVersion: number
}
