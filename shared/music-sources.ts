// 音源注册表:这个部署认识哪几种音乐来源。
//
// 前端运行时(services/music)按它装配加载器,后台设置页按它自动列出开关,
// 配置校验(config-schema)按它决定要校验哪些字段 —— 三方共用同一份声明,
// 加一种音源只需要在这里补一项,不必再去改后台界面或校验逻辑。
//
// 放在 shared/ 是因为后端也要用:配置校验跑在服务端。

import type { PublicMusicConfig } from './music-config'

export interface MusicSourceKind {
  /** 稳定标识。同时是配置里 `sources` 开关表的键,改名会让老配置失效 */
  id: string
  /** 后台设置页显示的名字 */
  label: string
  /** 一句话说明它从哪里取歌 */
  description: string
  /** 该音源的条目存在整份配置的哪个字段下 */
  entriesKey: keyof PublicMusicConfig & string
  /** 后台里这一类条目的量词,用于"共 N 个歌单"这类文案 */
  unit: string
}

export const MUSIC_SOURCE_KINDS: readonly MusicSourceKind[] = [
  {
    id: 'meting',
    label: '远程歌单',
    description: '通过 Meting API 拉取网易云 / QQ 音乐的公开歌单',
    entriesKey: 'playlists',
    unit: '个歌单',
  },
  {
    id: 'local',
    label: '本地音乐',
    description: '后台上传或自行托管的单曲',
    entriesKey: 'localTracks',
    unit: '首歌曲',
  },
]

export function findMusicSourceKind(id: string): MusicSourceKind | null {
  return MUSIC_SOURCE_KINDS.find((kind) => kind.id === id) ?? null
}

/** 取出某个音源在配置里的条目。字段缺失或不是数组时按空处理 */
export function musicSourceEntries(
  config: Partial<PublicMusicConfig>,
  kind: MusicSourceKind,
): readonly unknown[] {
  const entries = config[kind.entriesKey]
  return Array.isArray(entries) ? entries : []
}

/**
 * 该音源是否启用。
 *
 * 缺省视为**启用** —— 老配置里没有 `sources` 字段,不能因为升级就把人家的曲库关掉。
 */
export function isMusicSourceEnabled(config: Partial<PublicMusicConfig>, id: string): boolean {
  return config.sources?.[id]?.enabled !== false
}

/** 把某个音源的开关写进一份新的配置(不改原对象) */
export function withMusicSourceEnabled<T extends Partial<PublicMusicConfig>>(
  config: T,
  id: string,
  enabled: boolean,
): T {
  return {
    ...config,
    sources: { ...config.sources, [id]: { ...config.sources?.[id], enabled } },
  }
}
