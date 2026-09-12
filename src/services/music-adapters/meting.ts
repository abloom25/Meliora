import { buildMetingPlaylistUrl } from '../../../shared/music-api'
import type { MetingPlaylistConfig, MetingTrack, Track } from '../../types/music'
import { hasCachedLyrics, loadCombinedLyrics, registerTrackLyrics } from '../lyrics'
import { mapMetingTrack } from '../../utils/tracks'
import type { MusicProviderAdapter, MusicProviderContext } from './types'

/**
 * 从 Meting 资源地址中取出平台侧歌曲 ID(`?server=&type=&id=`)。
 * 逐字歌词库按平台 ID 寻址,而 Meting 返回的曲目本身不带 ID 字段,
 * 只能从 lrc / url 这类回链里反解。地址可能是相对路径,统一挂一个哨兵 base 再解析。
 */
export function extractMetingTrackId(resourceUrl: string): string | null {
  try {
    const url = new URL(resourceUrl, 'https://meliora.local')
    const id = url.searchParams.get('id')?.trim()
    return id || null
  } catch {
    return null
  }
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
          // 逐字歌词库按平台歌曲 ID 查询,拿不到 ID 时退化为纯 LRC 加载
          const platformId =
            extractMetingTrackId(lyricsUrl) ?? extractMetingTrackId(track.url?.trim() ?? '')
          registerTrackLyrics(mapped, {
            cacheKey: `meting:${lyricsUrl}`,
            priority: 10,
            isCached: () => hasCachedLyrics(lyricsUrl),
            load: (signal) =>
              loadCombinedLyrics(
                {
                  lyricsUrl,
                  wordQuery: platformId ? { platform: playlist.server, id: platformId } : undefined,
                },
                signal,
              ),
          })
        }
        return mapped
      })
      .filter((track): track is Track => track !== null)
  },
}

export { buildMetingPlaylistUrl }
