import { readonly, shallowRef } from 'vue'
import {
  beatCheckpointBuffers,
  type BeatAnalysisCheckpoint,
} from '../../core/analysis/beat-checkpoint'
import {
  BEAT_RESULT_VERSION,
  BEAT_RESULT_MAX_BYTES,
  BEAT_RESULT_MAX_AGE_MS,
  validPersistentCheckpoint,
  selectBeatCacheEvictions,
  type BeatResultStore,
  type BeatResultMetadata as Metadata,
} from '../../core/analysis/beat-result-cache'
export { BEAT_RESULT_VERSION, type BeatResultStore } from '../../core/analysis/beat-result-cache'
interface Record extends Metadata {
  version: string
  checkpoint: BeatAnalysisCheckpoint
}
export function createBeatResultStore() {
  const status = shallowRef({ cachedTracks: 0, cacheBytes: 0, storageAvailable: true })
  let generation = 0
  let opening: Promise<IDBDatabase | null> | null = null
  const open = (): Promise<IDBDatabase | null> => {
    if (opening) return opening
    opening = new Promise((resolve) => {
      let done = false
      const finish = (db: IDBDatabase | null): void => {
        if (done) {
          db?.close()
          return
        }
        done = true
        clearTimeout(timer)
        if (!db) status.value = { ...status.value, storageAvailable: false }
        resolve(db)
      }
      const timer = setTimeout(() => finish(null), 500)
      try {
        if (typeof indexedDB === 'undefined') {
          finish(null)
          return
        }
        const request = indexedDB.open('meliora-beat-results', 1)
        request.onupgradeneeded = () => {
          request.result.createObjectStore('results', { keyPath: 'key' })
          request.result.createObjectStore('metadata', { keyPath: 'key' })
        }
        request.onerror = request.onblocked = () => finish(null)
        request.onsuccess = () => {
          const db = request.result
          db.onversionchange = () => {
            db.close()
            opening = null
          }
          finish(db)
        }
      } catch {
        finish(null)
      }
    })
    const attempt = opening
    void attempt.then((db) => {
      if (!db && opening === attempt) opening = null
    })
    return attempt
  }
  async function transact<T>(
    mode: IDBTransactionMode,
    fallback: T,
    run: (transaction: IDBTransaction, set: (value: T) => void) => void,
  ): Promise<T> {
    const db = await open()
    if (!db) return fallback
    return new Promise((resolve) => {
      let transaction: IDBTransaction | undefined
      let done = false
      let result = fallback
      const finish = (value: T): void => {
        if (!done) {
          done = true
          clearTimeout(timer)
          resolve(value)
        }
      }
      const timer = setTimeout(() => {
        finish(fallback)
        try {
          transaction?.abort()
        } catch {
          /* Already finished. */
        }
      }, 1000)
      try {
        transaction = db.transaction(['results', 'metadata'], mode)
        transaction.oncomplete = () => {
          status.value = { ...status.value, storageAvailable: true }
          finish(result)
        }
        transaction.onerror = transaction.onabort = () => {
          status.value = { ...status.value, storageAvailable: false }
          finish(fallback)
        }
        run(transaction, (value) => {
          result = value
        })
      } catch {
        status.value = { ...status.value, storageAvailable: false }
        finish(fallback)
      }
    })
  }
  const update = (entries: Metadata[]): void => {
    status.value = {
      cachedTracks: new Set(entries.map((entry) => entry.track)).size,
      cacheBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      storageAvailable: true,
    }
  }
  async function trim(
    transaction: IDBTransaction,
    set: (value: Metadata[]) => void,
  ): Promise<void> {
    const metadata = transaction.objectStore('metadata')
    const request = metadata.getAll()
    request.onsuccess = () => {
      const entries = request.result as Metadata[]
      const removed = new Set(selectBeatCacheEvictions(entries, Date.now()))
      for (const key of removed) {
        metadata.delete(key)
        transaction.objectStore('results').delete(key)
      }
      set(entries.filter((entry) => !removed.has(entry.key)))
    }
  }
  const store: BeatResultStore = {
    get generation() {
      return generation
    },
    async get(key) {
      const epoch = generation
      const value = await transact<BeatAnalysisCheckpoint | null>('readonly', null, (tx, set) => {
        const request = tx.objectStore('results').get(key)
        request.onsuccess = () => {
          const record = request.result as Record | undefined
          if (
            record?.key === key &&
            record.version === BEAT_RESULT_VERSION &&
            record.updatedAt >= Date.now() - BEAT_RESULT_MAX_AGE_MS &&
            validPersistentCheckpoint(record.checkpoint)
          )
            set(record.checkpoint)
        }
      })
      return epoch === generation ? value : null
    },
    async set(key, track, checkpoint, epoch) {
      if (epoch !== generation || !validPersistentCheckpoint(checkpoint)) return
      const bytes = beatCheckpointBuffers(checkpoint).reduce(
        (sum, buffer) => sum + buffer.byteLength,
        0,
      )
      if (bytes > BEAT_RESULT_MAX_BYTES) return
      const entries = await transact<Metadata[] | null>('readwrite', null, (tx, set) => {
        if (epoch !== generation) return
        const metadata = { key, track, bytes, updatedAt: Date.now() }
        tx.objectStore('results').put({ ...metadata, version: BEAT_RESULT_VERSION, checkpoint })
        tx.objectStore('metadata').put(metadata)
        void trim(tx, set)
      })
      if (entries && epoch === generation) update(entries)
    },
    async clear() {
      generation += 1
      const success = await transact('readwrite', false, (tx, set) => {
        tx.objectStore('results').clear()
        tx.objectStore('metadata').clear()
        set(true)
      })
      if (!success) throw new Error('无法清除本机节拍缓存，请检查浏览器存储权限后重试')
      status.value = { ...status.value, cachedTracks: 0, cacheBytes: 0 }
    },
    async refresh() {
      const epoch = generation
      const entries = await transact<Metadata[] | null>('readwrite', null, (tx, set) => {
        void trim(tx, set)
      })
      if (entries && epoch === generation) update(entries)
    },
  }
  return { store, status: readonly(status) }
}

export const beatResultCache = createBeatResultStore()
