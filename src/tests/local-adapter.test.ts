import { afterEach, describe, expect, it, vi } from 'vitest'
import { localMusicAdapter } from '../services/music-adapters/local'
import {
  getLyricsSource,
  hasTrackLyricsSource,
  loadTrackLyrics,
  mergeTrackLyricsProvider,
} from '../services/lyrics'
import * as lyricsDb from '../services/lyrics-db'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('local track lyrics', () => {
  it('searches original metadata when the user did not provide a lyrics file', async () => {
    const lines = [{ time: 1, text: 'Matched local lyrics' }]
    const loadWords = vi.spyOn(lyricsDb, 'loadWordLyrics').mockResolvedValue(lines)
    const [track] = await localMusicAdapter.load(
      {
        id: 'metadata-fallback',
        title: 'Song (Live)',
        artist: 'Local Artist',
        album: 'Live Album',
        audio: '/music/fallback.mp3',
      },
      { apiEndpoint: '', timeoutMs: 8000 },
    )

    expect(hasTrackLyricsSource(track)).toBe(true)
    await expect(loadTrackLyrics(track)).resolves.toBe(lines)
    expect(getLyricsSource(lines)).toBe('amll')
    expect(loadWords).toHaveBeenCalledWith(
      { title: 'Song (Live)', artist: 'Local Artist', album: 'Live Album' },
      expect.any(AbortSignal),
    )
  })

  it('keeps explicit local lyrics authoritative over metadata search', async () => {
    const loadWords = vi.spyOn(lyricsDb, 'loadWordLyrics').mockResolvedValue(null)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('[00:01.00]User supplied lyrics')),
    )
    const [explicit] = await localMusicAdapter.load(
      {
        id: 'explicit-lyrics',
        title: 'Explicit Song',
        artist: 'Local Artist',
        audio: '/music/explicit.mp3',
        lyrics: '/music/explicit-authoritative.lrc',
      },
      { apiEndpoint: '', timeoutMs: 8000 },
    )
    const [fallback] = await localMusicAdapter.load(
      {
        id: 'implicit-lyrics',
        title: 'Explicit Song',
        artist: 'Local Artist',
        audio: '/music/implicit.mp3',
      },
      { apiEndpoint: '', timeoutMs: 8000 },
    )
    mergeTrackLyricsProvider(fallback, explicit)

    const displayed = await loadTrackLyrics(explicit)
    expect(displayed[0]?.text).toBe('User supplied lyrics')
    expect(getLyricsSource(displayed)).toBe('local')
    expect(await loadTrackLyrics(explicit)).toBe(displayed)
    expect(getLyricsSource(await loadTrackLyrics(explicit))).toBe('local')
    expect(loadWords).not.toHaveBeenCalled()
  })
})
