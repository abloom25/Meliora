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
  normalizeBeatCacheBudget,
  type BeatResultStore,
  type BeatResultMetadata as Metadata,
} from '../../core/analysis/beat-result-cache'
import { settingsStore } from '../settings-store'
export { BEAT_RESULT_VERSION, type BeatResultStore } from '../../core/analysis/beat-result-cache'
interface Record extends Metadata {
  version: string
  checkpoint: BeatAnalysisCheckpoint
}
export function createBeatResultStore() {
  const preferencesKey = 'meliora:beat-cache:settings:v1'
  let maxBytes = BEAT_RESULT_MAX_BYTES
  try {
    const value: unknown = JSON.parse(settingsStore().getItem(preferencesKey) ?? 'null')
    if (
      value &&
      typeof value === 'object' &&
      'version' in value &&
      value.version === 1 &&
      'maxBytes' in value
    )
      maxBytes = normalizeBeatCacheBudget(value.maxBytes)
  } catch {
    /* Use the default when storage is unavailable or malformed. */
  }
  const status = shallowRef({
    cachedTracks: 0,
    cacheBytes: 0,
    storageAvailable: true,
    maxBytes,
    entries: [] as Metadata[],
  })
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
        status.value = { ...status.value, storageAvailable: false }
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
      maxBytes,
      entries,
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
      const removed = new Set(selectBeatCacheEvictions(entries, Date.now(), maxBytes))
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
      if (bytes > maxBytes) return
      const entries = await transact<Metadata[] | null>('readwrite', null, (tx, set) => {
        if (epoch !== generation) return
        const previous = tx.objectStore('metadata').getAll()
        previous.onsuccess = () => {
          if (epoch !== generation) return
          const metadata: Metadata = {
            key,
            track,
            bytes,
            updatedAt: Date.now(),
            version: BEAT_RESULT_VERSION,
            pinned: (previous.result as Metadata[]).some(
              (entry) => entry.track === track && entry.pinned === true,
            ),
          }
          tx.objectStore('results').put({ ...metadata, version: BEAT_RESULT_VERSION, checkpoint })
          tx.objectStore('metadata').put(metadata)
          void trim(tx, set)
        }
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
      status.value = { ...status.value, cachedTracks: 0, cacheBytes: 0, entries: [] }
    },
    async refresh() {
      const epoch = generation
      const entries = await transact<Metadata[] | null>('readwrite', null, (tx, set) => {
        void trim(tx, set)
      })
      if (entries && epoch === generation) update(entries)
    },
  }
  async function removeTrack(track: string): Promise<void> {
    // Invalidate writes already queued by a running analysis before touching IDB.
    generation += 1
    const entries = await transact<Metadata[] | null>('readwrite', null, (tx, set) => {
      const request = tx.objectStore('metadata').getAll()
      request.onsuccess = () => {
        for (const entry of request.result as Metadata[]) {
          if (entry.track !== track) continue
          tx.objectStore('metadata').delete(entry.key)
          tx.objectStore('results').delete(entry.key)
        }
        void trim(tx, set)
      }
    })
    if (!entries) throw new Error('无法清除这首歌的节拍缓存，请重试')
    update(entries)
  }
  async function pinTrack(track: string, pinned: boolean): Promise<void> {
    const entries = await transact<Metadata[] | null>('readwrite', null, (tx, set) => {
      const request = tx.objectStore('metadata').getAll()
      request.onsuccess = () => {
        for (const entry of request.result as Metadata[]) {
          if (entry.track === track) tx.objectStore('metadata').put({ ...entry, pinned })
        }
        void trim(tx, set)
      }
    })
    if (!entries) throw new Error('缓存保留设置未能保存，请重试')
    update(entries)
  }
  async function setMaxBytes(bytes: number): Promise<void> {
    const next = normalizeBeatCacheBudget(bytes)
    const serialized = JSON.stringify({ version: 1, maxBytes: next })
    settingsStore().setItem(preferencesKey, serialized)
    if (settingsStore().getItem(preferencesKey) !== serialized)
      throw new Error('缓存容量设置未能保存，请检查浏览器存储权限后重试')
    maxBytes = next
    status.value = { ...status.value, maxBytes }
    await store.refresh()
    if (!status.value.storageAvailable) throw new Error('容量设置已保存，但缓存清理未完成，请重试')
  }
  return { store, status: readonly(status), removeTrack, pinTrack, setMaxBytes }
}

export const beatResultCache = createBeatResultStore()
