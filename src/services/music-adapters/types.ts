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
}

export interface MusicProviderAdapter<TSource> {
  id: string
  load(source: TSource, context: MusicProviderContext): Promise<Track[]>
}

export interface ConfiguredMusicSource<TSource> {
  adapter: MusicProviderAdapter<TSource>
  source: TSource
}
