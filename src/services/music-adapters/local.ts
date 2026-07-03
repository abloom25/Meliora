import type { LocalTrackConfig, Track } from '../../types/music'
import { mapLocalTrack } from '../../utils/tracks'
import { hasCachedLyrics, loadLrcLyrics, registerTrackLyrics } from '../lyrics'
import type { MusicProviderAdapter } from './types'

export const localMusicAdapter: MusicProviderAdapter<LocalTrackConfig> = {
  id: 'local',

  load(trackConfig: LocalTrackConfig): Promise<Track[]> {
    const track = mapLocalTrack(trackConfig)
    const lyricsUrl = trackConfig.lyrics?.trim()
    if (lyricsUrl) {
      registerTrackLyrics(track, {
        cacheKey: `local:${lyricsUrl}`,
        priority: 20,
        isCached: () => hasCachedLyrics(lyricsUrl),
        load: (signal) => loadLrcLyrics(lyricsUrl, signal),
      })
    }
    return Promise.resolve([track])
  },
}
