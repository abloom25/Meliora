/** 只存原文,解析器升级后重新解析,避免旧的字轴结构污染新版本。 */
export interface LyricsCacheRecord {
  cacheVersion: 1
  key: string
  text: string | null
  updatedAt: number
  expiresAt: number
}

/** 持久缓存是可选加速层。调用方必须容忍不可用或配额不足。 */
export interface LyricsCacheStore {
  readonly generation?: number
  get(key: string): Promise<LyricsCacheRecord | null>
  set(record: LyricsCacheRecord, generation?: number): Promise<void>
  clear?(): Promise<void>
  stats?(): Promise<LyricsCacheStats>
}

export interface LyricsCacheStats {
  entries: number
  /** Estimated UTF-16 text payload; browser database overhead is excluded. */
  bytes: number
  storageAvailable: boolean
}

export const LYRICS_CACHE_CAPACITY = 128
export const LYRICS_CACHE_MAX_TEXT_LENGTH = 512 * 1024

export function isLyricsCacheRecord(value: unknown): value is LyricsCacheRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<LyricsCacheRecord>
  return (
    record.cacheVersion === 1 &&
    typeof record.key === 'string' &&
    (record.text === null ||
      (typeof record.text === 'string' && record.text.length <= LYRICS_CACHE_MAX_TEXT_LENGTH)) &&
    typeof record.updatedAt === 'number' &&
    Number.isFinite(record.updatedAt) &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt) &&
    record.expiresAt > record.updatedAt
  )
}
