import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import {
  loadLyricsText,
  loadTrackLyrics,
  registerTrackLyrics,
  setLyricsTextFetcher,
} from '../services/lyrics'
import {
  loadNativeLyrics,
  resetNativeLyricsCache,
  setNativeLyricsCacheStore,
} from '../services/native-lyrics'
import { initializeLyricsPriority } from '../services/lyrics-requests'
import { acquireLyricsRequest, subscribeLyricsPriority } from '../services/lyrics-requests'
import { setHttpFetcher } from '../services/http'
import type { Track } from '../core/types'

const controllers: AbortController[] = []
function controller(background = false) {
  const value = new AbortController()
  controllers.push(value)
  if (background) initializeLyricsPriority(value.signal)
  return value
}
beforeEach(() => {
  setNativeLyricsCacheStore({ get: async () => null, set: async () => {} })
})
afterEach(async () => {
  for (const value of controllers.splice(0)) value.abort()
  await flushPromises()
  resetNativeLyricsCache()
  setNativeLyricsCacheStore(null)
  setLyricsTextFetcher(null)
  setHttpFetcher(null)
})

describe('shared lyric request priority', () => {
  it('demotes queued shared work after its last foreground subscriber leaves', async () => {
    const active = await Promise.all(
      Array.from({ length: 4 }, () => acquireLyricsRequest(controller().signal)),
    )
    const target = controller(true)
    const removeBackground = subscribeLyricsPriority(target.signal, controller(true).signal)
    const removeForeground = subscribeLyricsPriority(target.signal, controller().signal)
    const starts: string[] = []
    const shared = acquireLyricsRequest(target.signal).then((release) => {
      starts.push('shared')
      return release
    })
    const later = acquireLyricsRequest(controller().signal).then((release) => {
      starts.push('current')
      return release
    })
    removeForeground()
    active[0]!()
    const releaseCurrent = await later
    expect(starts).toEqual(['current'])
    releaseCurrent()
    const releaseShared = await shared
    releaseShared()
    removeBackground()
    for (const release of active) release()
  })
  it('promotes a queued prefetch through the provider signal and keeps the foreground subscriber alive', async () => {
    const starts: string[] = []
    const pending = new Map<string, { signal: AbortSignal; finish: (value: string) => void }>()
    setLyricsTextFetcher(
      (url, signal) =>
        new Promise((resolve, reject) => {
          starts.push(url)
          pending.set(url, { signal, finish: resolve })
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const loads = ['one', 'two', 'three'].map((name) =>
      loadLyricsText(`/priority-${name}`, controller(true).signal).catch(() => ''),
    )
    const track: Track = {
      id: 'promoted-priority',
      title: 'Song',
      artist: 'Artist',
      audioUrl: '/priority.mp3',
      kind: 'local',
    }
    registerTrackLyrics(track, {
      cacheKey: 'promoted-priority',
      load: async (signal) => [{ time: 0, text: await loadLyricsText('/priority-target', signal) }],
    })
    const prefetchController = controller()
    const prefetched = loadTrackLyrics(
      track,
      prefetchController.signal,
      undefined,
      'background',
    ).catch(() => [])
    await flushPromises()
    expect(starts).toEqual(['/priority-one', '/priority-two'])
    const current = loadTrackLyrics(track, controller().signal)
    await flushPromises()
    expect(starts).toEqual(['/priority-one', '/priority-two', '/priority-target'])
    prefetchController.abort()
    await prefetched
    expect(pending.get('/priority-target')!.signal.aborted).toBe(false)
    pending.get('/priority-target')!.finish('Current lyrics')
    await expect(current).resolves.toEqual([{ time: 0, text: 'Current lyrics' }])
    for (const value of controllers) value.abort()
    await Promise.all(loads)
  })

  it('shares the budget with native sources and cancels orphaned text bodies', async () => {
    const signals: AbortSignal[] = []
    setLyricsTextFetcher(
      (_url, signal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal)
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
    )
    const first = controller(true)
    const text = loadLyricsText('/priority-orphan-one', first.signal).catch(() => '')
    const second = controller(true)
    const other = loadLyricsText('/priority-orphan-two', second.signal).catch(() => '')
    const fetcher = vi.fn(async () => Response.json({ status: 'missing' }, { status: 404 }))
    setHttpFetcher(fetcher)
    const background = controller(true)
    const native = loadNativeLyrics({ source: 'netease', id: 'priority-budget' }, background.signal)
    await flushPromises()
    expect(signals).toHaveLength(2)
    expect(fetcher).not.toHaveBeenCalled()
    const active = loadNativeLyrics(
      { source: 'netease', id: 'priority-budget' },
      controller().signal,
    )
    await expect(active).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledOnce()
    await native
    first.abort()
    await text
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    second.abort()
    await other
  })
})
