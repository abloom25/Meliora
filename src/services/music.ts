import type { MetingPlaylistConfig, MetingTrack, Track } from '../types/music'
import { musicConfig } from '../config/music'
import { deduplicateTracks, mapLocalTrack, mapMetingTrack } from '../utils/tracks'

export interface TrackLoadResult {
  tracks: Track[]
  failedSources: number
}

async function fetchPlaylist(playlist: MetingPlaylistConfig): Promise<Track[]> {
  const params = new URLSearchParams({
    server: playlist.server,
    type: 'playlist',
    id: playlist.playlistId,
  })
  const response = await fetch(`${musicConfig.apiEndpoint}?${params.toString()}`)
  if (!response.ok) throw new Error(`Meting request failed with ${response.status}`)

  const payload: unknown = await response.json()
  if (!Array.isArray(payload)) throw new Error('Meting response is not a track list')

  const sourceKey = `${playlist.server}:${playlist.playlistId}`
  return (payload as MetingTrack[])
    .map((track, index) => mapMetingTrack(track, sourceKey, index))
    .filter((track): track is Track => track !== null)
}

export async function loadConfiguredTracks(): Promise<TrackLoadResult> {
  const playlists = musicConfig.playlists.filter((playlist) => playlist.enabled !== false)
  const settled = await Promise.allSettled(playlists.map(fetchPlaylist))
  const remoteTracks: Track[] = []
  let failedSources = 0

  settled.forEach((result) => {
    if (result.status === 'fulfilled') remoteTracks.push(...result.value)
    else failedSources += 1
  })

  const localTracks = musicConfig.localTracks.map(mapLocalTrack)
  return {
    tracks: deduplicateTracks([...remoteTracks, ...localTracks]),
    failedSources,
  }
}
