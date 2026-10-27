import type { Track } from '../../core/types'
import type { LocalTrackConfig } from '../../../shared/music-config'
import { mapLocalTrack } from './track-mapping'
import { hasCachedLyrics, loadCombinedLyrics, loadLrcLyrics, registerTrackLyrics } from '../lyrics'
import {
  getWordLyricsCacheToken,
  hasCachedWordLyrics,
  wordLyricsCacheKey,
  type WordLyricsQuery,
} from '../lyrics-db'
import type { MusicProviderAdapter } from './types'

export const localMusicAdapter: MusicProviderAdapter<LocalTrackConfig> = {
  id: 'local',
  requiresNetwork: false,

  load(trackConfig: LocalTrackConfig): Promise<Track[]> {
    const track = mapLocalTrack(trackConfig)
    const lyricsUrl = trackConfig.lyrics?.trim()
    if (lyricsUrl) {
      registerTrackLyrics(track, {
        cacheKey: `local:${lyricsUrl}`,
        lyricsUrl,
        source: 'local',
        priority: 20,
        isCached: () => hasCachedLyrics(lyricsUrl),
        load: (signal) => loadLrcLyrics(lyricsUrl, signal),
      })
    } else {
      const wordQuery: WordLyricsQuery = {
        title: trackConfig.title.trim(),
        artist: track.artist,
        album: track.album,
      }
      registerTrackLyrics(track, {
        cacheKey: `local:${wordLyricsCacheKey(wordQuery)}`,
        combined: { wordQuery },
        // 用户上传的歌词和带平台 ID 的来源应优先于元数据搜索。
        priority: 0,
        isCached: () => hasCachedWordLyrics(wordQuery),
        cacheable: () => hasCachedWordLyrics(wordQuery),
        cacheToken: () => getWordLyricsCacheToken(wordQuery),
        load: (signal, onProgress) => loadCombinedLyrics({ wordQuery }, signal, onProgress),
      })
    }
    return Promise.resolve([track])
  },
}
