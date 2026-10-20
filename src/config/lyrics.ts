import type { MusicServer } from '../../shared/music-config'

// 逐字歌词数据源:AMLL TTML DB(github.com/amll-dev/amll-ttml-db)。
// 社区维护的 Apple Music 规格逐词歌词库,按平台歌曲 ID 直接寻址静态文件,
// 官方 API 支持平台 ID 与元数据检索,静态镜像在 API 不可用时兜底。
//
// 社区词库的覆盖率有限,未命中的曲目回退普通歌词。
// 没有真实字级时间轴时保持整行高亮,不合成猜测的逐字数据。

export const WORD_LYRICS_API_URL = 'https://api.amll.dev/v1/lyrics'
export const WORD_LYRICS_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000
export const WORD_LYRICS_NEGATIVE_TTL_MS = 15 * 60 * 1000
export const WORD_LYRICS_QUERY_TIMEOUT_MS = 8000
// All lyric sources share this budget; speculative neighbors leave room for the current song.
export const LYRICS_MAX_CONCURRENT_REQUESTS = 4
export const LYRICS_MAX_BACKGROUND_REQUESTS = 2
export const LYRICS_MAX_QUEUED_REQUESTS = 32

export const NATIVE_LYRICS_API_URL = '/api/lyrics'
export const NATIVE_LYRICS_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000
export const NATIVE_LYRICS_NEGATIVE_TTL_MS = 15 * 60 * 1000
export const NATIVE_LYRICS_TIMEOUT_MS = 8000

export interface WordLyricsMirror {
  /** 镜像标识 */
  name: string
  baseUrl: string
}

// API 不可用时在统一并发预算内查询镜像,首个有效结果返回。
export const WORD_LYRICS_MIRRORS: readonly WordLyricsMirror[] = [
  { name: 'jsdelivr', baseUrl: 'https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main' },
  { name: 'jsdelivr-fastly', baseUrl: 'https://fastly.jsdelivr.net/gh/amll-dev/amll-ttml-db@main' },
  {
    name: 'github-raw',
    baseUrl: 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/refs/heads/main',
  },
]

/** 各音乐平台在歌词库中的目录名与可用的逐字格式(按优先级排列) */
export const WORD_LYRICS_PLATFORMS: Record<
  MusicServer,
  { directory: string; extensions: readonly string[] }
> = {
  netease: { directory: 'ncm-lyrics', extensions: ['ttml', 'yrc'] },
  tencent: { directory: 'qq-lyrics', extensions: ['ttml', 'qrc'] },
}

/** 单个镜像的请求超时。歌词库只是增强项,不能拖慢主歌词的显示 */
export const WORD_LYRICS_TIMEOUT_MS = 3500
