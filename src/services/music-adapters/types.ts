import type { Track } from '../../core/types'

/** Meting API 返回的一条曲目。字段全是可选的,上游并不保证 */
export interface MetingTrack {
  title?: string
  author?: string
  pic?: string
  url?: string
  lrc?: string
}

export interface MusicProviderContext {
  apiEndpoint: string
  timeoutMs: number
  signal?: AbortSignal
}

export interface MusicProviderAdapter<TSource> {
  id: string
  /** 无远程 IO 的适配器可批量加载，不占用网络并发槽。 */
  requiresNetwork?: boolean
  load(source: TSource, context: MusicProviderContext): Promise<Track[]>
}

export interface ConfiguredMusicSource<TSource> {
  adapter: MusicProviderAdapter<TSource>
  source: TSource
}
