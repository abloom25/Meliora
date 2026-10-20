import { buildMetingPlaylistUrl } from '../../../shared/music-api'
import { httpFetch } from '../http'
import type { Track } from '../../core/types'
import type { MetingPlaylistConfig } from '../../../shared/music-config'
import type { MetingTrack } from './types'
import {
  getCombinedLyricsCacheToken,
  hasCachedLyrics,
  loadCombinedLyrics,
  registerTrackLyrics,
} from '../lyrics'
import { mapMetingTrack } from './track-mapping'
import type { MusicProviderAdapter, MusicProviderContext } from './types'
import { resolveMusicRequestUrl } from '../../config/music'
import { wordLyricsCacheKey, type WordLyricsQuery } from '../lyrics-db'

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

async function fetchPlaylist(url: string, context: MusicProviderContext): Promise<unknown> {
  const controller = new AbortController()
  const cancel = () => controller.abort(context.signal?.reason)
  if (context.signal?.aborted) cancel()
  else context.signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => controller.abort(), context.timeoutMs)
  try {
    const response = await httpFetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`Meting request failed with ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
    context.signal?.removeEventListener('abort', cancel)
  }
}

function isMetingTrack(value: unknown): value is MetingTrack {
  if (!value || typeof value !== 'object') return false
  const track = value as Record<string, unknown>
  return ['title', 'author', 'pic', 'url', 'lrc'].every(
    (key) => track[key] === undefined || typeof track[key] === 'string',
  )
}

export const metingMusicAdapter: MusicProviderAdapter<MetingPlaylistConfig> = {
  id: 'meting',

  async load(playlist: MetingPlaylistConfig, context: MusicProviderContext): Promise<Track[]> {
    const payload = await fetchPlaylist(
      resolveMusicRequestUrl(buildMetingPlaylistUrl(context.apiEndpoint, playlist)),
      context,
    )
    if (!Array.isArray(payload)) throw new Error('Meting response is not a track list')

    const sourceKey = `${playlist.server}:${playlist.playlistId}`
    return payload
      .filter(isMetingTrack)
      .map((track, index) => {
        const mapped = mapMetingTrack(track, sourceKey, index)
        if (mapped) {
          mapped.audioUrl = resolveMusicRequestUrl(mapped.audioUrl)
          if (mapped.cover) mapped.cover = resolveMusicRequestUrl(mapped.cover)
        }
        const lyricsUrl = track.lrc?.trim() ? resolveMusicRequestUrl(track.lrc.trim()) : undefined
        if (mapped) {
          // ID 查询与普通歌词地址独立;缺少 ID 时仍可用原始歌名/歌手匹配。
          // 保留标题里的 Live/Remix 等版本标记,不能拿剥离后的显示标题查库。
          const platformId =
            extractMetingTrackId(track.lrc?.trim() ?? '') ??
            extractMetingTrackId(track.url?.trim() ?? '')
          const wordQuery: WordLyricsQuery = {
            platform: platformId ? playlist.server : undefined,
            id: platformId ?? undefined,
            title: track.title?.trim(),
            artist: track.author?.trim(),
            album: mapped.album,
          }
          registerTrackLyrics(mapped, {
            cacheKey: `meting:${JSON.stringify([lyricsUrl, wordLyricsCacheKey(wordQuery)])}`,
            priority: 10,
            isCached: () =>
              (!lyricsUrl || hasCachedLyrics(lyricsUrl)) &&
              getCombinedLyricsCacheToken(wordQuery) !== null,
            cacheable: () => getCombinedLyricsCacheToken(wordQuery) !== null,
            cacheToken: () => getCombinedLyricsCacheToken(wordQuery),
            load: (signal, onProgress) =>
              loadCombinedLyrics(
                {
                  lyricsUrl,
                  wordQuery,
                },
                signal,
                onProgress,
              ),
          })
        }
        return mapped
      })
      .filter((track): track is Track => track !== null)
  },
}

export { buildMetingPlaylistUrl }
