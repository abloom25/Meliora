import type { MetingPlaylistConfig, MetingTrack, Track } from '../../types/music'
import { hasCachedLyrics, loadLrcLyrics, registerTrackLyrics } from '../lyrics'
import { mapMetingTrack } from '../../utils/tracks'
import type { MusicProviderAdapter, MusicProviderContext } from './types'

function buildMetingPlaylistUrl(apiEndpoint: string, playlist: MetingPlaylistConfig): string {
  const baseUrl = 'https://meliora.local'
  const isAbsoluteUrl = /^[a-z][a-z\d+.-]*:/i.test(apiEndpoint)
  const isProtocolRelativeUrl = apiEndpoint.startsWith('//')
  const url = new URL(apiEndpoint, baseUrl)

  url.searchParams.set('server', playlist.server)
  url.searchParams.set('type', 'playlist')
  url.searchParams.set('id', playlist.playlistId)

  if (isAbsoluteUrl) return url.toString()
  if (isProtocolRelativeUrl) return `//${url.host}${url.pathname}${url.search}${url.hash}`

  const pathname = apiEndpoint.startsWith('/') ? url.pathname : url.pathname.replace(/^\//, '')
  return `${pathname}${url.search}${url.hash}`
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export const metingMusicAdapter: MusicProviderAdapter<MetingPlaylistConfig> = {
  id: 'meting',

  async load(playlist: MetingPlaylistConfig, context: MusicProviderContext): Promise<Track[]> {
    const response = await fetchWithTimeout(
      buildMetingPlaylistUrl(context.apiEndpoint, playlist),
      context.timeoutMs,
    )
    if (!response.ok) throw new Error(`Meting request failed with ${response.status}`)

    const payload: unknown = await response.json()
    if (!Array.isArray(payload)) throw new Error('Meting response is not a track list')

    const sourceKey = `${playlist.server}:${playlist.playlistId}`
    return (payload as MetingTrack[])
      .map((track, index) => {
        const mapped = mapMetingTrack(track, sourceKey, index)
        const lyricsUrl = track.lrc?.trim()
        if (mapped && lyricsUrl) {
          registerTrackLyrics(mapped, {
            cacheKey: `meting:${lyricsUrl}`,
            priority: 10,
            isCached: () => hasCachedLyrics(lyricsUrl),
            load: (signal) => loadLrcLyrics(lyricsUrl, signal),
          })
        }
        return mapped
      })
      .filter((track): track is Track => track !== null)
  },
}

export { buildMetingPlaylistUrl }
