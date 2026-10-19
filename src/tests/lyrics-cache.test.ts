import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebLyricsCacheStore } from '../platform/web/lyrics-cache'
import {
  isLyricsCacheRecord,
  LYRICS_CACHE_CAPACITY,
  LYRICS_CACHE_MAX_TEXT_LENGTH,
  type LyricsCacheRecord,
} from '../core/platform/lyrics-cache'

function record(key: string, updatedAt = 1): LyricsCacheRecord {
  return { cacheVersion: 1, key, text: 'lyrics', updatedAt, expiresAt: updatedAt + 1000 }
}

/** 模拟请求/事务的事件顺序,验证适配器只遍历索引键而不读取整库歌词。 */
function indexedDbFixture() {
  const records = new Map<string, unknown>()
  const createIndex = vi.fn()
  const openKeyCursor = vi.fn()
  const close = vi.fn()
  const database = {
    close,
    onversionchange: null as (() => void) | null,
    objectStoreNames: { contains: () => false },
    createObjectStore: () => ({ indexNames: { contains: () => false }, createIndex }),
    transaction: vi.fn(() => {
      let outstanding = 0
      const transaction = {
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        abort: vi.fn(),
        objectStore: () => store,
      }
      interface Request<T> {
        result: T
        onsuccess: (() => void) | null
      }
      function schedule<T>(request: Request<T>, read: () => T) {
        outstanding += 1
        queueMicrotask(() => {
          request.result = read()
          request.onsuccess?.()
          outstanding -= 1
          if (outstanding === 0)
            queueMicrotask(() => {
              if (outstanding === 0) transaction.oncomplete?.()
            })
        })
      }
      function request<T>(read: () => T): Request<T> {
        const pending: Request<T> = { result: undefined as T, onsuccess: null }
        schedule(pending, read)
        return pending
      }
      const store = {
        get: (key: string) => request(() => records.get(key)),
        put: (value: LyricsCacheRecord) => request(() => records.set(value.key, value)),
        count: () => request(() => records.size),
        delete: (key: string) => request(() => records.delete(key)),
        index: (name: string) => {
          expect(name).toBe('updatedAt')
          return {
            openKeyCursor: () => {
              openKeyCursor()
              const keys = [...records.values()]
                .filter(isLyricsCacheRecord)
                .sort((left, right) => left.updatedAt - right.updatedAt)
                .map((value) => value.key)
              let position = 0
              interface Cursor {
                primaryKey: string
                continue: () => void
              }
              const cursor: Request<Cursor | null> = { result: null, onsuccess: null }
              const read = (): Cursor | null =>
                position >= keys.length
                  ? null
                  : {
                      primaryKey: keys[position]!,
                      continue: () => {
                        position += 1
                        schedule(cursor, read)
                      },
                    }
              schedule(cursor, read)
              return cursor
            },
          }
        },
      }
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
  return { records, factory, database, createIndex, openKeyCursor, close }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('persistent lyric cache', () => {
  it('validates version, bounds and expiration before trusting a record', () => {
    expect(isLyricsCacheRecord(record('one'))).toBe(true)
    expect(isLyricsCacheRecord({ ...record('one'), text: null })).toBe(true)
    expect(isLyricsCacheRecord({ ...record('one'), cacheVersion: 0 })).toBe(false)
    expect(isLyricsCacheRecord({ ...record('one'), expiresAt: 1 })).toBe(false)
    expect(isLyricsCacheRecord({ ...record('one'), updatedAt: Number.NaN })).toBe(false)
    expect(
      isLyricsCacheRecord({ ...record('one'), text: 'x'.repeat(LYRICS_CACHE_MAX_TEXT_LENGTH + 1) }),
    ).toBe(false)
  })

  it('reads and writes records and trims only the oldest keys within the write transaction', async () => {
    const fixture = indexedDbFixture()
    for (let index = 0; index < LYRICS_CACHE_CAPACITY + 2; index += 1) {
      fixture.records.set(String(index), record(String(index), index))
    }
    const store = createWebLyricsCacheStore()
    await store.set(record('newest', 1000))
    expect(fixture.records.size).toBe(LYRICS_CACHE_CAPACITY)
    expect(fixture.records.has('0')).toBe(false)
    expect(fixture.records.has('1')).toBe(false)
    expect(fixture.records.has('2')).toBe(false)
    expect(await store.get('newest')).toEqual(record('newest', 1000))
    expect(fixture.createIndex).toHaveBeenCalledWith('updatedAt', 'updatedAt')
    expect(fixture.openKeyCursor).toHaveBeenCalledTimes(1)
    expect(fixture.database.transaction).toHaveBeenCalledWith('queries', 'readwrite')
  })

  it('does not return malformed stored data or persist oversized content', async () => {
    const fixture = indexedDbFixture()
    fixture.records.set('old', { ...record('old'), cacheVersion: 0 })
    const store = createWebLyricsCacheStore()
    expect(await store.get('old')).toBeNull()
    await store.set({ ...record('huge'), text: 'x'.repeat(LYRICS_CACHE_MAX_TEXT_LENGTH + 1) })
    expect(fixture.records.has('huge')).toBe(false)
  })

  it('falls back silently when IndexedDB is missing or denied', async () => {
    vi.stubGlobal('indexedDB', undefined)
    const unavailable = createWebLyricsCacheStore()
    expect(await unavailable.get('key')).toBeNull()
    await expect(unavailable.set(record('key'))).resolves.toBeUndefined()
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('denied')
      },
    })
    expect(await createWebLyricsCacheStore().get('key')).toBeNull()
  })

  it('bounds a blocked open and closes a database that arrives after timeout', async () => {
    vi.useFakeTimers()
    const close = vi.fn()
    const request = { result: { close }, onsuccess: null as (() => void) | null }
    vi.stubGlobal('indexedDB', { open: () => request })
    const pending = createWebLyricsCacheStore().get('key')
    await vi.advanceTimersByTimeAsync(501)
    expect(await pending).toBeNull()
    request.onsuccess?.()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('bounds hung transactions and tolerates transaction creation failures', async () => {
    vi.useFakeTimers()
    const fixture = indexedDbFixture()
    const store = createWebLyricsCacheStore()
    const abort = vi.fn()
    fixture.database.transaction.mockImplementationOnce(
      () =>
        ({
          oncomplete: null,
          onerror: null,
          onabort: null,
          abort,
          objectStore: () => ({ get: () => ({ onsuccess: null }) }),
        }) as unknown as ReturnType<typeof fixture.database.transaction>,
    )
    const pending = store.get('key')
    await vi.advanceTimersByTimeAsync(501)
    expect(await pending).toBeNull()
    expect(abort).toHaveBeenCalledTimes(1)
    fixture.database.transaction.mockImplementationOnce(() => {
      throw new Error('closed')
    })
    expect(await store.get('key')).toBeNull()
  })
})
