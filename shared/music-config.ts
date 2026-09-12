export type MusicServer = 'netease' | 'tencent'

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
