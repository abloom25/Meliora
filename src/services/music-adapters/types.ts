import type { Track } from '../../types/music'

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
