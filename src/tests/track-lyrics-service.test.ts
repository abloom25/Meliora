import { reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  hasTrackLyricsSource,
  loadTrackLyrics,
  mergeTrackLyricsProvider,
  registerTrackLyrics,
} from '../services/lyrics'
import type { LyricLine, Track } from '../types/music'

describe('track lyrics service', () => {
  it('uses structured lyrics directly without parsing a lyrics url', async () => {
    const lyrics: LyricLine[] = [
      {
        time: 12.5,
        text: 'Original line',
        translation: '直接返回的翻译',
      },
    ]
    const track: Track = {
      id: 'custom:1',
      title: 'Custom Song',
      artist: 'Custom Artist',
      audioUrl: '/custom.mp3',
      kind: 'remote',
    }
    registerTrackLyrics(track, {
      cacheKey: 'custom:lyrics:1',
      isCached: () => true,
      load: () => Promise.resolve(lyrics),
    })

    await expect(loadTrackLyrics(track)).resolves.toEqual(lyrics)
    expect(hasTrackLyricsSource(track)).toBe(true)
  })

  it('delegates lyrics loading to the adapter-provided lyrics loader', async () => {
    const load = vi.fn().mockResolvedValue([
      {
        time: 3,
        text: 'Adapter parsed line',
        translation: 'Adapter translation',
      },
    ])
    const controller = new AbortController()
    const track: Track = {
      id: 'custom:2',
      title: 'Loader Song',
      artist: 'Custom Artist',
      audioUrl: '/loader.mp3',
      kind: 'remote',
    }
    registerTrackLyrics(track, {
      cacheKey: 'custom:lyrics:2',
      isCached: () => true,
      load,
    })

    await expect(loadTrackLyrics(track, controller.signal)).resolves.toEqual([
      {
        time: 3,
        text: 'Adapter parsed line',
        translation: 'Adapter translation',
      },
    ])
    expect(load).toHaveBeenCalledWith(controller.signal)
  })

  it('resolves adapter-provided lyrics through Vue reactive track proxies', async () => {
    const track: Track = {
      id: 'custom:3',
      title: 'Reactive Song',
      artist: 'Custom Artist',
      audioUrl: '/reactive.mp3',
      kind: 'remote',
    }
    const lyrics: LyricLine[] = [{ time: 5, text: 'Still linked after proxying' }]
    registerTrackLyrics(track, {
      cacheKey: 'custom:lyrics:3',
      isCached: () => true,
      load: () => Promise.resolve(lyrics),
    })

    const reactiveTrack = reactive(track) as Track

    expect(hasTrackLyricsSource(reactiveTrack)).toBe(true)
    await expect(loadTrackLyrics(reactiveTrack)).resolves.toEqual(lyrics)
  })

  it('uses provider priority when merging duplicate track lyrics', async () => {
    const kept: Track = {
      id: 'meting:duplicate',
      title: 'Duplicate Song',
      artist: 'Same Artist',
      audioUrl: '/meting.mp3',
      kind: 'meting',
    }
    const duplicate: Track = {
      ...kept,
      id: 'local:duplicate',
      audioUrl: '/local.mp3',
      kind: 'local',
    }
    registerTrackLyrics(kept, {
      cacheKey: 'meting:duplicate',
      priority: 10,
      load: () => Promise.resolve([{ time: 1, text: 'Meting lyric' }]),
    })
    registerTrackLyrics(duplicate, {
      cacheKey: 'local:duplicate',
      priority: 20,
      load: () => Promise.resolve([{ time: 1, text: 'Local lyric' }]),
    })

    mergeTrackLyricsProvider(duplicate, kept)

    await expect(loadTrackLyrics(kept)).resolves.toEqual([{ time: 1, text: 'Local lyric' }])
  })
})
