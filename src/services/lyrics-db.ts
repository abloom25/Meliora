import { httpFetch } from './http'
import {
  WORD_LYRICS_MIRRORS,
  WORD_LYRICS_PLATFORMS,
  WORD_LYRICS_TIMEOUT_MS,
} from '../config/lyrics'
import type { LyricLine } from '../core/types'
import type { MusicServer } from '../../shared/music-config'
import { LruCache } from '../core/util/lru-cache'
import { parseAnyLyrics } from '../core/lyrics'

// AMLL TTML DB 逐字歌词查询。命中即返回真实字级时间轴,未命中返回 null,
// 由调用方回退到普通 LRC(再由 resolveLyricTimings 做插值兜底)。
//
// 缓存同时记录命中与未命中:曲库里大部分曲目不在库中,不缓存未命中的话
// 每次切歌都会重新打三个镜像。

export interface WordLyricsQuery {
  platform: MusicServer
  /** 平台侧歌曲 ID:网易云是数字 ID,QQ 音乐是 songmid */
  id: string
}

interface WordLyricsEntry {
  promise: Promise<LyricLine[] | null>
  ready: boolean
}

const wordLyricsCache = new LruCache<string, WordLyricsEntry>(128)

function cacheKey(query: WordLyricsQuery): string {
  return `${query.platform}:${query.id}`
}

export function wordLyricsCacheKey(query: WordLyricsQuery): string {
  return `word-lyrics:${cacheKey(query)}`
}

export function hasCachedWordLyrics(query: WordLyricsQuery): boolean {
  return wordLyricsCache.get(cacheKey(query))?.ready ?? false
}

/** 仅用于测试:跨用例重置模块级缓存 */
export function resetWordLyricsCache() {
  wordLyricsCache.clear()
}

interface FetchOutcome {
  text: string | null
  /** true 表示这个镜像明确回答了"库里没有",不必再问下一个镜像 */
  definitive: boolean
}

// 每次镜像请求只受自身超时控制,不接受调用方 signal:
// 查询结果在多个订阅者之间共享,让第一个订阅者的取消连带取消共享请求会误伤其他人
async function fetchFromMirror(url: string): Promise<FetchOutcome> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WORD_LYRICS_TIMEOUT_MS)

  try {
    const response = await httpFetch(url, { cache: 'force-cache', signal: controller.signal })
    // 404 是"这首歌不在库里"的确定答案,换镜像也是一样的结果;
    // 5xx / 网络错误才说明是这个镜像本身不可用,需要换下一个
    if (response.status === 404) return { text: null, definitive: true }
    if (!response.ok) return { text: null, definitive: false }
    return { text: await response.text(), definitive: true }
  } catch {
    return { text: null, definitive: false }
  } finally {
    clearTimeout(timer)
  }
}

async function requestWordLyrics(query: WordLyricsQuery): Promise<LyricLine[] | null> {
  const platform = WORD_LYRICS_PLATFORMS[query.platform]
  if (!platform || !query.id) return null

  for (const extension of platform.extensions) {
    let mirrorFailures = 0
    for (const mirror of WORD_LYRICS_MIRRORS) {
      const url = `${mirror.baseUrl}/${platform.directory}/${encodeURIComponent(query.id)}.${extension}`
      const outcome = await fetchFromMirror(url)
      if (outcome.text) {
        const lines = parseAnyLyrics(outcome.text)
        // 解析不出带音节的行说明这个文件不是逐字数据,继续试下一种格式
        if (lines.some((line) => line.wordSource === 'native')) return lines
        break
      }
      if (outcome.definitive) break
      mirrorFailures += 1
    }
    if (mirrorFailures === WORD_LYRICS_MIRRORS.length) {
      // 所有镜像都不可达:网络受限或全站故障,不再试其他格式,直接交给 LRC
      console.warn('[lyrics-db] 逐字歌词库全部镜像不可达,回退到普通歌词')
      return null
    }
  }

  return null
}

// 调用方的 abort 只结束自己的等待,不影响共享请求
function withAbort(
  promise: Promise<LyricLine[] | null>,
  signal: AbortSignal | undefined,
): Promise<LyricLine[] | null> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(null)

  return new Promise((resolve) => {
    const onAbort = () => {
      cleanup()
      resolve(null)
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (lines) => {
        cleanup()
        resolve(lines)
      },
      () => {
        cleanup()
        resolve(null)
      },
    )
  })
}

/**
 * 查询逐字歌词。命中返回已补齐时间轴的行,未命中或不可用返回 null。
 * 同一 query 的并发请求共享同一个 promise;失败结果不写入缓存,允许下次重试。
 */
export function loadWordLyrics(
  query: WordLyricsQuery,
  signal?: AbortSignal,
): Promise<LyricLine[] | null> {
  const key = cacheKey(query)
  const existing = wordLyricsCache.get(key)
  if (existing) return withAbort(existing.promise, signal)

  const entry: WordLyricsEntry = { ready: false, promise: Promise.resolve(null) }
  entry.promise = requestWordLyrics(query)
    .then((lines) => {
      entry.ready = true
      return lines
    })
    .catch(() => {
      // 逐字歌词是增强项,任何失败都不得冒泡打断主歌词加载
      wordLyricsCache.delete(key)
      return null
    })

  wordLyricsCache.set(key, entry)
  return withAbort(entry.promise, signal)
}
