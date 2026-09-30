// 曲库与站点配置的类型。前端、后端、构建脚本共用。
//
// 放在 shared/ 而不是 src/ 下:后端(server/core/config-handler.ts)与配置校验
// (shared/config-schema.ts)都要用它,让后端反过来 import 前端目录是错误的依赖方向。
// 播放器的领域类型(曲目、歌词、播放设置)在 src/core/types.ts,两者不该混住。

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

/** 单个音源的开关。键见 shared/music-sources.ts 的 MusicSourceKind.id */
export interface MusicSourceToggle {
  /** 缺省视为开启:老配置里没有这张表,升级不该把人家的曲库关掉 */
  enabled?: boolean
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
  /** 各音源的总开关,按音源 id 索引。缺省或缺字段都视为开启 */
  sources?: Record<string, MusicSourceToggle>
}

export interface MusicConfig extends PublicMusicConfig {
  apiToken?: string
  githubProxy?: string
  receivePrereleaseUpdates?: boolean
}
