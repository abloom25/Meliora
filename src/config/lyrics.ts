import type { MusicServer } from '../types/music'

// 逐字歌词数据源:AMLL TTML DB(github.com/amll-dev/amll-ttml-db)。
// 社区维护的 Apple Music 规格逐词歌词库,按平台歌曲 ID 直接寻址静态文件,
// 三个镜像都带 `Access-Control-Allow-Origin: *`,浏览器可直连,不需要后端代理。
//
// 覆盖率是有限的(以日系、欧美、游戏音乐为主),命中不了的曲目由
// utils/lyrics.ts 的字符权重插值兜底,渲染层通过 LyricLine.wordSource 区分两者。

export interface WordLyricsMirror {
  /** 展示用名称,只出现在开发期告警里 */
  name: string
  baseUrl: string
}

// 按顺序尝试:jsDelivr 在国内可达性更好,raw.githubusercontent 作为权威兜底
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
