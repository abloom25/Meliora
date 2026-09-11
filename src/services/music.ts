import type { Track } from '../core/types'
import type { PublicMusicConfig } from '../../shared/music-config'
import { musicConfig } from '../config/music'
import { mergeTrackLyricsProvider } from './lyrics'
import { localMusicAdapter } from './music-adapters/local'
import { metingMusicAdapter } from './music-adapters/meting'
import type { MusicProviderAdapter } from './music-adapters/types'
import {
  MUSIC_SOURCE_KINDS,
  isMusicSourceEnabled,
  musicSourceEntries,
} from '../../shared/music-sources'
import { deduplicateTracks, mergeTrackShareAliases } from '../core/library/tracks'

export interface TrackLoadResult {
  tracks: Track[]
  failedSources: number
}

/**
 * 音源 id → 适配器。开放形状:加一种音源只需在 shared/music-sources.ts 补一项声明,
 * 再往这里注册一个适配器,装配逻辑与后台界面都不用改
 */
export type MusicAdapterRegistry = Record<string, MusicProviderAdapter<never>>

export interface LoadConfiguredTracksOptions {
  adapters?: Partial<MusicAdapterRegistry>
}

const DEFAULT_ADAPTERS: MusicAdapterRegistry = {
  meting: metingMusicAdapter as MusicProviderAdapter<never>,
  local: localMusicAdapter as MusicProviderAdapter<never>,
}

const MUSIC_SOURCE_TIMEOUT_MS = 8000
const MUSIC_SOURCE_CONCURRENCY = 3

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

/** 该条目自身是否启用。目前只有远程歌单支持逐条开关,其余音源的条目恒为启用 */
function isEntryEnabled(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return true
  return (entry as { enabled?: boolean }).enabled !== false
}

function createConfiguredSources(
  config: PublicMusicConfig,
  adapters: MusicAdapterRegistry,
): ConfiguredSource[] {
  const sources: ConfiguredSource[] = []
  for (const kind of MUSIC_SOURCE_KINDS) {
    // 音源总开关关掉时整类都不加载;没注册适配器的声明直接跳过
    if (!isMusicSourceEnabled(config, kind.id)) continue
    const adapter = adapters[kind.id]
    if (!adapter) continue
    for (const entry of musicSourceEntries(config, kind)) {
      if (!isEntryEnabled(entry)) continue
      sources.push(createConfiguredSource(adapter, entry as never))
    }
  }
  return sources
}

async function settleConfiguredSources(
  sources: ConfiguredSource[],
  config: PublicMusicConfig,
  concurrency: number,
): Promise<PromiseSettledResult<Track[]>[]> {
  const settled: PromiseSettledResult<Track[]>[] = new Array(sources.length)
  let nextSourceIndex = 0

  async function worker() {
    while (nextSourceIndex < sources.length) {
      const sourceIndex = nextSourceIndex
      nextSourceIndex += 1
      const source = sources[sourceIndex]
      if (!source) continue

      try {
        settled[sourceIndex] = {
          status: 'fulfilled',
          value: await source.load(config),
        }
      } catch (reason) {
        settled[sourceIndex] = {
          status: 'rejected',
          reason,
        }
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), sources.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return settled
}

export async function loadConfiguredTracks(
  config: PublicMusicConfig,
  options: LoadConfiguredTracksOptions = {},
): Promise<TrackLoadResult> {
  // Partial 覆盖里可能显式传 undefined,过滤掉才不会把默认适配器擦掉
  const adapters: MusicAdapterRegistry = { ...DEFAULT_ADAPTERS }
  for (const [id, adapter] of Object.entries(options.adapters ?? {})) {
    if (adapter) adapters[id] = adapter
  }
  const sources = createConfiguredSources(config, adapters)
  const settled = await settleConfiguredSources(sources, config, MUSIC_SOURCE_CONCURRENCY)
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
  const config = musicConfig()
  injectPreconnect(config.apiEndpoint)
  return config
}
