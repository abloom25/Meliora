import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBeatResultStore } from '../platform/web/beat-result-cache'
import {
  selectBeatCacheEvictions,
  validPersistentCheckpoint,
  BEAT_RESULT_MAX_AGE_MS,
} from '../core/analysis/beat-result-cache'
import { createBeatCheckpoint } from '../core/analysis/beat-checkpoint'
import { createBeatTimelineBuffer } from '../core/analysis/beat-timeline'

function checkpoint() {
  const timeline = createBeatTimelineBuffer(1)
  timeline.completedRanges = [{ startSeconds: 0, endSeconds: 1 }]
  return createBeatCheckpoint(
    { sampleRate: 48000, sampleCount: 48000, channels: 2, modelId: 'basic' },
    timeline,
    new Set([0]),
    50,
  )
}

/** Small IDB event fixture: writes and capacity pruning share the same transaction. */
function indexedDbFixture() {
  // Node structuredClone returns another VM's typed arrays under jsdom. Native
  // IndexedDB deserializes into the caller's realm, which this fixture preserves.
  const clone = (value: unknown): unknown => {
    if (value instanceof Float32Array) return value.slice()
    if (Array.isArray(value)) return value.map(clone)
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
    return value
  }
  const tables = new Map<string, Map<string, unknown>>([
    ['results', new Map()],
    ['metadata', new Map()],
  ])
  let failTransactions = false
  const database = {
    close: vi.fn(),
    onversionchange: null as (() => void) | null,
    createObjectStore: vi.fn(),
    transaction: vi.fn(() => {
      let outstanding = 0
      const transaction = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        abort: vi.fn(),
        objectStore: (name: string) => {
          const table = tables.get(name)!
          return {
            get: (key: string) => request(() => clone(table.get(key))),
            getAll: () => request(() => [...table.values()].map(clone)),
            put: (value: { key: string }) => {
              const copy = clone(value)
              return request(() => table.set(value.key, copy))
            },
            delete: (key: string) => request(() => table.delete(key)),
            clear: () => request(() => table.clear()),
          }
        },
      }
      function request<T>(run: () => T) {
        const pending = { result: undefined as T, onsuccess: null as (() => void) | null }
        outstanding++
        queueMicrotask(() => {
          if (failTransactions) {
            transaction.onerror?.()
            return
          }
          pending.result = run()
          pending.onsuccess?.()
          outstanding--
          if (!outstanding)
            queueMicrotask(() => {
              if (!outstanding) transaction.oncomplete?.()
            })
        })
        return pending
      }
      queueMicrotask(() => {
        if (!outstanding) transaction.oncomplete?.()
      })
      return transaction
    }),
  }
  const factory = {
    open: vi.fn(() => {
      const request = {
        result: database,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
      }
      queueMicrotask(() => {
        request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    }),
  }
  vi.stubGlobal('indexedDB', factory)
  return {
    tables,
    database,
    factory,
    fail: (value: boolean) => {
      failTransactions = value
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('persistent beat results', () => {
  it('rejects malformed and incompatible checkpoints before saving', () => {
    expect(validPersistentCheckpoint(checkpoint())).toBe(true)
    expect(validPersistentCheckpoint({ ...checkpoint(), version: 0 })).toBe(false)
    expect(validPersistentCheckpoint({ ...checkpoint(), completedWindows: [1000] })).toBe(false)
    const invalid = checkpoint()
    invalid.timeline.levels[0][0] = NaN
    expect(validPersistentCheckpoint(invalid)).toBe(false)
    expect(validPersistentCheckpoint(null)).toBe(false)
  })

  it('evicts expired and over-budget records while retaining recent small results', () => {
    const now = BEAT_RESULT_MAX_AGE_MS + 100
    const meta = (key: string, bytes: number, updatedAt: number) => ({
      key,
      track: key,
      bytes,
      updatedAt,
    })
    expect(
      selectBeatCacheEvictions(
        [
          meta('new', 8, now),
          meta('second', 8, now - 1),
          meta('old', 8, now - 2),
          meta('expired', 1, 1),
        ],
        now,
        16,
        3,
      ),
    ).toEqual(['old', 'expired'])
    expect(
      selectBeatCacheEvictions([meta('huge', 17, now), meta('small', 4, now - 1)], now, 16, 1),
    ).toEqual(['huge'])
  })

  it('round-trips typed arrays, tracks unique songs and clears both stores', async () => {
    const fixture = indexedDbFixture()
    const cache = createBeatResultStore()
    const saved = checkpoint()
    await cache.store.set('song:small:hash', 'song', saved, 0)
    await cache.store.set('song:standard:hash', 'song', saved, 0)
    expect(fixture.tables.get('results')?.size).toBe(2)
    const stored = fixture.tables.get('results')?.get('song:small:hash') as {
      checkpoint: ReturnType<typeof checkpoint>
    }
    expect(stored.checkpoint.timeline.levels[0]).toBeInstanceOf(Float32Array)
    saved.timeline.levels[0][0] = 0.9
    const read = await cache.store.get('song:small:hash')
    expect(read?.timeline.levels[0]).toBeInstanceOf(Float32Array)
    expect(read?.timeline.levels[0][0]).toBe(0)
    expect(cache.status.value.cachedTracks).toBe(1)
    expect(cache.status.value.cacheBytes).toBe(61 * 5 * 4 * 2)
    expect(fixture.database.transaction).toHaveBeenCalledWith(['results', 'metadata'], 'readwrite')
    await cache.store.clear()
    expect(fixture.tables.get('results')?.size).toBe(0)
    expect(fixture.tables.get('metadata')?.size).toBe(0)
    expect(cache.status.value.cacheBytes).toBe(0)
  })

  it('does not repopulate after clear while a previous write is waiting for storage', async () => {
    indexedDbFixture()
    const cache = createBeatResultStore()
    const write = cache.store.set('old', 'song', checkpoint(), cache.store.generation)
    const clear = cache.store.clear()
    await Promise.all([write, clear])
    expect(await cache.store.get('old')).toBeNull()
    await cache.store.set('stale', 'song', checkpoint(), 0)
    expect(await cache.store.get('stale')).toBeNull()
  })

  it('reports clear failures and recovers availability after a successful transaction', async () => {
    const fixture = indexedDbFixture()
    const cache = createBeatResultStore()
    await cache.store.set('song', 'song', checkpoint(), 0)
    fixture.fail(true)
    await expect(cache.store.clear()).rejects.toThrow('无法清除')
    expect(cache.status.value.storageAvailable).toBe(false)
    expect(cache.status.value.cachedTracks).toBe(1)
    expect(cache.status.value.cacheBytes).toBeGreaterThan(0)
    fixture.fail(false)
    await cache.store.refresh()
    expect(cache.status.value.storageAvailable).toBe(true)
  })

  it('retries after a blocked open timeout and closes a late database', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const request = { result: { close }, onsuccess: null as (() => void) | null }
    vi.stubGlobal('indexedDB', { open: () => request })
    const cache = createBeatResultStore()
    const read = cache.store.get('song')
    await vi.advanceTimersByTimeAsync(501)
    expect(await read).toBeNull()
    request.onsuccess?.()
    expect(close).toHaveBeenCalledOnce()
    const fixture = indexedDbFixture()
    await cache.store.refresh()
    expect(fixture.factory.open).toHaveBeenCalledOnce()
    expect(cache.status.value.storageAvailable).toBe(true)
  })
})
