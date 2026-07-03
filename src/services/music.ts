import type {
  LocalTrackConfig,
  MetingPlaylistConfig,
  PublicMusicConfig,
  Track,
} from '../types/music'
import { musicConfig } from '../config/music'
import { mergeTrackLyricsProvider } from './lyrics'
import { localMusicAdapter } from './music-adapters/local'
import { metingMusicAdapter } from './music-adapters/meting'
import type { MusicProviderAdapter } from './music-adapters/types'
import { deduplicateTracks, mergeTrackShareAliases } from '../utils/tracks'

export interface TrackLoadResult {
  tracks: Track[]
  failedSources: number
}

export interface MusicAdapterRegistry {
  meting: MusicProviderAdapter<MetingPlaylistConfig>
  local: MusicProviderAdapter<LocalTrackConfig>
}

export interface LoadConfiguredTracksOptions {
  adapters?: Partial<MusicAdapterRegistry>
}

const DEFAULT_ADAPTERS: MusicAdapterRegistry = {
  meting: metingMusicAdapter,
  local: localMusicAdapter,
}

const MUSIC_SOURCE_TIMEOUT_MS = 8000

interface ConfiguredSource {
  load(config: PublicMusicConfig): Promise<Track[]>
}

function createConfiguredSource<TSource>(
  adapter: MusicProviderAdapter<TSource>,
  source: TSource,
): ConfiguredSource {
  return {
    load(config) {
      return adapter.load(source, {
        apiEndpoint: config.apiEndpoint,
        timeoutMs: MUSIC_SOURCE_TIMEOUT_MS,
      })
    },
  }
}

function createConfiguredSources(
  config: PublicMusicConfig,
  adapters: MusicAdapterRegistry,
): ConfiguredSource[] {
  const playlists = config.playlists.filter((playlist) => playlist.enabled !== false)
  return [
    ...playlists.map((playlist) => createConfiguredSource(adapters.meting, playlist)),
    ...config.localTracks.map((track) => createConfiguredSource(adapters.local, track)),
  ]
}

export async function loadConfiguredTracks(
  config: PublicMusicConfig,
  options: LoadConfiguredTracksOptions = {},
): Promise<TrackLoadResult> {
  const adapters: MusicAdapterRegistry = {
    ...DEFAULT_ADAPTERS,
    ...options.adapters,
  }
  const sources = createConfiguredSources(config, adapters)
  const settled = await Promise.allSettled(sources.map((source) => source.load(config)))
  const remoteTracks: Track[] = []
  let failedSources = 0

  settled.forEach((result) => {
    if (result.status === 'fulfilled') remoteTracks.push(...result.value)
    else failedSources += 1
  })

  return {
    tracks: deduplicateTracks(remoteTracks, (kept, duplicate) => {
      mergeTrackLyricsProvider(duplicate, kept)
      mergeTrackShareAliases(kept, duplicate)
    }),
    failedSources,
  }
}

function injectPreconnect(url: string) {
  if (!url) return
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return
  }
  if (origin === window.location.origin) return
  const id = `preconnect-${origin}`
  if (document.getElementById(id)) return
  const link = document.createElement('link')
  link.id = id
  link.rel = 'preconnect'
  link.href = origin
  link.crossOrigin = 'anonymous'
  document.head.appendChild(link)
}

export function loadMusicConfig(): PublicMusicConfig {
  injectPreconnect(musicConfig.apiEndpoint)
  return musicConfig
}
