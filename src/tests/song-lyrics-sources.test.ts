import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LyricLine, Track } from '../core/types'
import {
  getLyricsSource,
  invalidateTrackLyrics,
  loadLrcLyrics,
  loadTrackLyrics,
  loadTrackLyricsChoices,
  offsetLyrics,
  registerTrackLyrics,
  resetTrackLyricsCache,
  setLyricsTextFetcher,
} from '../services/lyrics'
import * as wordSource from '../services/lyrics-db'
import * as nativeSource from '../services/native-lyrics'

function track(id: string): Track {
  return { id, kind: 'local', title: id, artist: 'Artist', audioUrl: `/${id}.mp3` }
}

describe('explicit song lyric sources', () => {
  afterEach(() => {
    resetTrackLyricsCache()
    setLyricsTextFetcher(null)
    vi.restoreAllMocks()
  })

  it('does not probe alternatives until requested and uses only the chosen provider', async () => {
    const song = track('choices')
    const automatic = vi.fn(async () => [{ time: 1, text: 'Automatic' }])
    const words = vi
      .spyOn(wordSource, 'loadWordLyrics')
      .mockResolvedValue([{ time: 1, text: 'AMLL' }])
    const native = vi.spyOn(nativeSource, 'loadNativeLyrics').mockResolvedValue(null)
    const text = vi.fn(async () => '[00:01.00]Original')
    setLyricsTextFetcher(text)
    registerTrackLyrics(song, {
      cacheKey: 'choice:test',
      combined: { wordQuery: { platform: 'netease', id: '123' }, lyricsUrl: '/choices.lrc' },
      load: automatic,
    })
    await loadTrackLyrics(song)
    expect(words).not.toHaveBeenCalled()
    expect(native).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    const chosen = await loadTrackLyrics(song, undefined, undefined, 'foreground', 'amll')
    expect(chosen[0]?.text).toBe('AMLL')
    expect(getLyricsSource(chosen)).toBe('amll')
    expect(native).not.toHaveBeenCalled()
    expect(text).not.toHaveBeenCalled()
    const options = await loadTrackLyricsChoices(song)
    expect(options.map((choice) => choice.source)).toEqual(['amll', 'meting'])
    expect(options.find((choice) => choice.source === 'meting')?.lines[0]?.text).toBe('Original')
    expect(automatic).toHaveBeenCalledTimes(1)
  })

  it('refreshes only the current track and preserves provider identity on shifted snapshots', async () => {
    const text = vi.fn(async (url: string) => `[00:01.00]${url}:${text.mock.calls.length}`)
    setLyricsTextFetcher(text)
    const a = track('a'),
      b = track('b')
    for (const song of [a, b]) {
      const url = `/${song.id}.lrc`
      registerTrackLyrics(song, {
        cacheKey: url,
        source: 'local',
        lyricsUrl: url,
        load: (signal) => loadLrcLyrics(url, signal),
      })
    }
    const first = await loadTrackLyrics(a)
    const second = await loadTrackLyrics(b)
    const shifted = offsetLyrics(first, 300)
    expect(shifted[0]?.time).toBe(1.3)
    expect(getLyricsSource(shifted)).toBe('local')
    expect(first[0]?.time).toBe(1)
    await invalidateTrackLyrics(a)
    expect(await loadTrackLyrics(b)).toBe(second)
    const fresh = await loadTrackLyrics(a)
    expect(fresh).not.toBe(first)
    expect(text).toHaveBeenCalledTimes(3)
  })

  it('rejects an in-flight provider result after cache clearing even if its transport ignores abort', async () => {
    let complete!: (lines: LyricLine[]) => void
    const song = track('in-flight')
    registerTrackLyrics(song, {
      cacheKey: 'ignores-abort',
      load: () =>
        new Promise((resolve) => {
          complete = resolve
        }),
    })
    const pending = loadTrackLyrics(song)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    resetTrackLyricsCache()
    complete([{ time: 0, text: 'Old' }])
    await rejected
  })
})
