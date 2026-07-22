import fc from 'fast-check'
import type { Track, MetingTrack } from '../../types/music'

export const trackArb: fc.Arbitrary<Track> = fc.record(
  {
    id: fc.string(),
    title: fc.string(),
    artist: fc.string(),
    album: fc.option(fc.string(), { nil: undefined }),
    cover: fc.option(fc.webUrl(), { nil: undefined }),
    audioUrl: fc.webUrl(),
    lyricsUrl: fc.option(fc.webUrl(), { nil: undefined }),
    kind: fc.constantFrom('meting' as const, 'local' as const),
  },
  { requiredKeys: ['id', 'title', 'artist', 'audioUrl', 'kind'] },
)

export const collidingTrackArb: fc.Arbitrary<Track> = fc.record({
  id: fc.string(),
  title: fc.constantFrom('Song', ' song ', 'SONG', 'Other', 'other  x'),
  artist: fc.constantFrom('A', ' a ', 'B', 'b'),
  audioUrl: fc.webUrl(),
  kind: fc.constantFrom('meting' as const, 'local' as const),
})

export const metingTrackArb: fc.Arbitrary<MetingTrack> = fc.record(
  {
    title: fc.option(fc.string(), { nil: undefined }),
    author: fc.option(fc.string(), { nil: undefined }),
    pic: fc.option(fc.string(), { nil: undefined }),
    url: fc.option(fc.webUrl(), { nil: undefined }),
    lrc: fc.option(fc.webUrl(), { nil: undefined }),
  },
  { requiredKeys: [] },
)
