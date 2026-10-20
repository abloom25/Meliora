import {
  isLyricsCacheRecord,
  LYRICS_CACHE_CAPACITY,
  type LyricsCacheRecord,
  type LyricsCacheStore,
} from '../../core/platform/lyrics-cache'

const DATABASE_NAME = 'meliora-lyrics'
const STORE_NAME = 'queries'
const STORAGE_TIMEOUT_MS = 500

/** IndexedDB 被禁用、升级被旧页阻塞或事务失败时,直接退回网络/内存缓存。 */
export function createWebLyricsCacheStore(): LyricsCacheStore {
  let pending: Promise<IDBDatabase | null> | null = null

  function open(): Promise<IDBDatabase | null> {
    if (pending) return pending
    pending = new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null)
      let finished = false
      const finish = (database: IDBDatabase | null) => {
        if (finished) {
          database?.close()
          return
        }
        finished = true
        clearTimeout(timer)
        resolve(database)
      }
      const timer = setTimeout(() => finish(null), STORAGE_TIMEOUT_MS)
      try {
        const request = indexedDB.open(DATABASE_NAME, 2)
        request.onupgradeneeded = () => {
          const store = request.result.objectStoreNames.contains(STORE_NAME)
            ? request.transaction?.objectStore(STORE_NAME)
            : request.result.createObjectStore(STORE_NAME, { keyPath: 'key' })
          if (store && !store.indexNames.contains('updatedAt')) {
            store.createIndex('updatedAt', 'updatedAt')
          }
        }
        request.onerror = () => finish(null)
        request.onblocked = () => finish(null)
        request.onsuccess = () => {
          const database = request.result
          database.onversionchange = () => {
            database.close()
            pending = null
          }
          finish(database)
        }
      } catch {
        finish(null)
      }
    })
    return pending
  }

  async function transact<T>(
    mode: IDBTransactionMode,
    fallback: T,
    run: (store: IDBObjectStore, setResult: (value: T) => void) => void,
  ): Promise<T> {
    const database = await open()
    if (!database) return fallback
    return new Promise((resolve) => {
      let transaction: IDBTransaction | undefined
      let result = fallback
      let finished = false
      const finish = (value: T) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        finish(fallback)
        try {
          transaction?.abort()
        } catch {
          // 已结束的事务无需再次中止。
        }
      }, STORAGE_TIMEOUT_MS)
      try {
        transaction = database.transaction(STORE_NAME, mode)
        transaction.oncomplete = () => finish(result)
        transaction.onerror = transaction.onabort = () => finish(fallback)
        run(transaction.objectStore(STORE_NAME), (value) => {
          result = value
        })
      } catch {
        finish(fallback)
      }
    })
  }

  return {
    get: (key) =>
      transact<LyricsCacheRecord | null>('readonly', null, (store, setResult) => {
        const request = store.get(key)
        request.onsuccess = () => {
          const value: unknown = request.result
          if (isLyricsCacheRecord(value) && value.key === key) setResult(value)
        }
      }),
    set: async (record) => {
      if (!isLyricsCacheRecord(record)) return
      await transact('readwrite', undefined, (store) => {
        store.put(record)
        const request = store.count()
        request.onsuccess = () => {
          let remaining = request.result - LYRICS_CACHE_CAPACITY
          if (remaining <= 0) return
          // 只读索引键,不把最多 128 首歌词全文反序列化到主线程。
          // 同一读写事务内裁剪,多个标签页同时写入也不会越过容量限制。
          const cursor = store.index('updatedAt').openKeyCursor()
          cursor.onsuccess = () => {
            if (!cursor.result || remaining <= 0) return
            store.delete(cursor.result.primaryKey)
            remaining -= 1
            if (remaining > 0) cursor.result.continue()
          }
        }
      })
    },
  }
}

export const webLyricsCacheStore = createWebLyricsCacheStore()
