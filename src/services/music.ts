import type { MetingPlaylistConfig, MetingTrack, PublicMusicConfig, Track } from '../types/music'
import { musicConfig } from '../config/music'
import { deduplicateTracks, mapLocalTrack, mapMetingTrack } from '../utils/tracks'

export interface TrackLoadResult {
  tracks: Track[]
  failedSources: number
}

async function fetchPlaylist(
  playlist: MetingPlaylistConfig,
  apiEndpoint: string,
): Promise<Track[]> {
  const params = new URLSearchParams({
    server: playlist.server,
    type: 'playlist',
    id: playlist.playlistId,
  })
  // 创建本地 controller，用于实现 8 秒超时与可中止能力
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const response = await fetch(`${apiEndpoint}?${params.toString()}`, {
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Meting request failed with ${response.status}`)

    const payload: unknown = await response.json()
    if (!Array.isArray(payload)) throw new Error('Meting response is not a track list')

    const sourceKey = `${playlist.server}:${playlist.playlistId}`
    return (payload as MetingTrack[])
      .map((track, index) => mapMetingTrack(track, sourceKey, index))
      .filter((track): track is Track => track !== null)
  } finally {
    // 无论成功失败都要清理定时器，避免资源泄漏
    clearTimeout(timer)
  }
}

export async function loadConfiguredTracks(config: PublicMusicConfig): Promise<TrackLoadResult> {
  const playlists = config.playlists.filter((playlist) => playlist.enabled !== false)
  const settled = await Promise.allSettled(
    playlists.map((playlist) => fetchPlaylist(playlist, config.apiEndpoint)),
  )
  const remoteTracks: Track[] = []
  let failedSources = 0

  settled.forEach((result) => {
    if (result.status === 'fulfilled') remoteTracks.push(...result.value)
    else failedSources += 1
  })

  const localTracks = config.localTracks.map(mapLocalTrack)
  return {
    tracks: deduplicateTracks([...remoteTracks, ...localTracks]),
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
