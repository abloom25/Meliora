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
    expect(load).toHaveBeenCalledWith(expect.any(AbortSignal))
  })

  it('caches provider lyrics by cacheKey and deduplicates in-flight loads', async () => {
    const lyrics: LyricLine[] = [{ time: 6, text: 'Cached provider line' }]
    const load = vi.fn().mockResolvedValue(lyrics)
    const track: Track = {
      id: 'custom:provider-cache',
      title: 'Provider Cache Song',
      artist: 'Custom Artist',
      audioUrl: '/provider-cache.mp3',
      kind: 'remote',
    }
    registerTrackLyrics(track, {
      cacheKey: 'custom:lyrics:provider-cache',
      load,
    })

    await expect(Promise.all([loadTrackLyrics(track), loadTrackLyrics(track)])).resolves.toEqual([
      lyrics,
      lyrics,
    ])
    await expect(loadTrackLyrics(track)).resolves.toEqual(lyrics)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('lets one aborted provider-cache caller reject without cancelling the shared load', async () => {
    const lyrics: LyricLine[] = [{ time: 7, text: 'Shared provider line' }]
    let resolveLoad!: (lines: LyricLine[]) => void
    const load = vi.fn(
      () =>
        new Promise<LyricLine[]>((resolve) => {
          resolveLoad = resolve
        }),
    )
    const track: Track = {
      id: 'custom:provider-abort',
      title: 'Provider Abort Song',
      artist: 'Custom Artist',
      audioUrl: '/provider-abort.mp3',
      kind: 'remote',
    }
    registerTrackLyrics(track, {
      cacheKey: 'custom:lyrics:provider-abort',
      load,
    })

    const controller = new AbortController()
    const first = loadTrackLyrics(track, controller.signal)
    const second = loadTrackLyrics(track)
    first.catch(() => {})
    controller.abort(new DOMException('Caller aborted', 'AbortError'))

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    resolveLoad(lyrics)
    await expect(second).resolves.toEqual(lyrics)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('aborts the shared provider load when every active caller has aborted', async () => {
    let providerSignal: AbortSignal | undefined
    const load = vi.fn(
      (signal?: AbortSignal) =>
        new Promise<LyricLine[]>((_resolve, reject) => {
          providerSignal = signal
          signal?.addEventListener('abort', () => {
            reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          })
        }),
    )
    const track: Track = {
      id: 'custom:provider-all-abort',
      title: 'Provider All Abort Song',
      artist: 'Custom Artist',
      audioUrl: '/provider-all-abort.mp3',
      kind: 'remote',
    }
    registerTrackLyrics(track, {
      cacheKey: 'custom:lyrics:provider-all-abort',
      load,
    })

    const controller = new AbortController()
    const request = loadTrackLyrics(track, controller.signal)
    request.catch(() => {})
    controller.abort(new DOMException('Caller aborted', 'AbortError'))

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    expect(providerSignal?.aborted).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('clears provider cache after a failed load', async () => {
    const load = vi
      .fn<() => Promise<LyricLine[]>>()
      .mockRejectedValueOnce(new Error('temporary lyrics failure'))
      .mockResolvedValueOnce([{ time: 8, text: 'Recovered provider line' }])
    const track: Track = {
      id: 'custom:provider-retry',
      title: 'Provider Retry Song',
      artist: 'Custom Artist',
      audioUrl: '/provider-retry.mp3',
      kind: 'remote',
    }
    registerTrackLyrics(track, {
      cacheKey: 'custom:lyrics:provider-retry',
      load,
    })

    await expect(loadTrackLyrics(track)).rejects.toThrow('temporary lyrics failure')
    await expect(loadTrackLyrics(track)).resolves.toEqual([
      { time: 8, text: 'Recovered provider line' },
    ])
    expect(load).toHaveBeenCalledTimes(2)
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
