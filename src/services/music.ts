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
import { deduplicateTracks, mergeTrackShareAliases, trackIdentity } from '../core/library/tracks'

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
  signal?: AbortSignal
  onProgress?: (result: TrackLoadResult) => void
}

const DEFAULT_ADAPTERS: MusicAdapterRegistry = {
  meting: metingMusicAdapter as MusicProviderAdapter<never>,
  local: localMusicAdapter as MusicProviderAdapter<never>,
}

const MUSIC_SOURCE_TIMEOUT_MS = 8000
const MUSIC_SOURCE_CONCURRENCY = 3

interface ConfiguredSource {
  requiresNetwork: boolean
  load(config: PublicMusicConfig, signal?: AbortSignal): Promise<Track[]>
}

function createConfiguredSource<TSource>(
  adapter: MusicProviderAdapter<TSource>,
  source: TSource,
): ConfiguredSource {
  return {
    requiresNetwork: adapter.requiresNetwork !== false,
    load(config, signal) {
      return adapter.load(source, {
        apiEndpoint: config.apiEndpoint,
        timeoutMs: MUSIC_SOURCE_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
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
    const entries = musicSourceEntries(config, kind).filter(isEntryEnabled)
    const configured = entries.map((entry) => createConfiguredSource(adapter, entry as never))
    if (adapter.requiresNetwork === false && configured.length) {
      sources.push({
        requiresNetwork: false,
        async load(config, signal) {
          return (await Promise.all(configured.map((source) => source.load(config, signal)))).flat()
        },
      })
    } else sources.push(...configured)
  }
  return sources
}

async function settleConfiguredSources(
  sources: ConfiguredSource[],
  config: PublicMusicConfig,
  concurrency: number,
  options: LoadConfiguredTracksOptions,
): Promise<PromiseSettledResult<Track[]>[]> {
  const settled: PromiseSettledResult<Track[]>[] = new Array(sources.length)
  const remoteIndices = sources.flatMap((source, index) => (source.requiresNetwork ? [index] : []))
  let nextSourceIndex = 0

  async function loadSource(sourceIndex: number): Promise<void> {
    if (options.signal?.aborted) throw options.signal.reason
    const source = sources[sourceIndex]!
    try {
      settled[sourceIndex] = {
        status: 'fulfilled',
        value: await source.load(config, options.signal),
      }
    } catch (reason) {
      settled[sourceIndex] = { status: 'rejected', reason }
    }
    if (options.signal?.aborted) throw options.signal.reason
    options.onProgress?.(collectResults(settled))
  }

  async function worker() {
    while (nextSourceIndex < remoteIndices.length) {
      const sourceIndex = remoteIndices[nextSourceIndex]!
      nextSourceIndex += 1
      await loadSource(sourceIndex)
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), remoteIndices.length)
  await Promise.all([
    ...sources.flatMap((source, index) => (source.requiresNetwork ? [] : [loadSource(index)])),
    ...Array.from({ length: workerCount }, () => worker()),
  ])
  return settled
}

function collectResults(settled: PromiseSettledResult<Track[]>[]): TrackLoadResult {
  const tracks: Track[] = []
  let failedSources = 0
  settled.forEach((result) => {
    if (result.status === 'fulfilled') tracks.push(...result.value)
    else failedSources += 1
  })
  return {
    tracks: deduplicateTracks(tracks, (kept, duplicate) => {
      mergeTrackLyricsProvider(duplicate, kept)
      mergeTrackShareAliases(kept, duplicate)
    }),
    failedSources,
  }
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
  // 已经展示/开始播放的曲目不能因较慢来源带来同名曲目而更换 ID。
  const retained = new Map<string, Track>()
  const retainTracks = (result: TrackLoadResult): TrackLoadResult => ({
    ...result,
    tracks: result.tracks.map((track) => {
      const identity = trackIdentity(track)
      const existing = retained.get(identity)
      if (existing) {
        mergeTrackLyricsProvider(track, existing)
        mergeTrackShareAliases(existing, track)
        return existing
      }
      retained.set(identity, track)
      return track
    }),
  })
  const settled = await settleConfiguredSources(sources, config, MUSIC_SOURCE_CONCURRENCY, {
    ...options,
    onProgress: options.onProgress
      ? (result) => options.onProgress!(retainTracks(result))
      : undefined,
  })
  return retainTracks(collectResults(settled))
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
