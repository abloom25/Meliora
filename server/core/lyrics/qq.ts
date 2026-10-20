import type { NativeLyricsData, NativeLyricsResult } from '../../../shared/native-lyrics'
import { decodeQrc } from './qrc'
import { fetchLyricsJson } from './upstream'

const QQ_LYRICS_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function optionalLyric(value: unknown, signal: AbortSignal): Promise<string | undefined> {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const result = await decodeQrc(value, signal)
    return result || undefined
  } catch {
    signal.throwIfAborted()
    return undefined
  }
}

export async function fetchQqLyrics(id: string, signal: AbortSignal): Promise<NativeLyricsResult> {
  const numericId = /^\d+$/.test(id) ? Number(id) : undefined
  if (
    (numericId !== undefined && (!Number.isSafeInteger(numericId) || numericId <= 0)) ||
    (numericId === undefined && !/^[a-z\d]{14}$/i.test(id))
  ) {
    return { status: 'unavailable' }
  }
  try {
    const payload = {
      comm: { ct: 19, cv: 1873, uin: '0' },
      req: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param: {
          crypt: 1,
          lrc_t: 0,
          qrc: 1,
          qrc_t: 0,
          roma: 1,
          roma_t: 0,
          trans: 1,
          trans_t: 0,
          type: 1,
          ...(numericId === undefined ? { songMid: id } : { songId: numericId }),
        },
      },
    }
    const response = await fetchLyricsJson(
      QQ_LYRICS_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/' },
        body: JSON.stringify(payload),
      },
      signal,
    )
    if (
      !record(response) ||
      response.code !== 0 ||
      !record(response.req) ||
      response.req.code !== 0
    ) {
      return { status: 'unavailable' }
    }
    const data = response.req.data
    if (!record(data) || typeof data.lyric !== 'string' || (data.qrc !== 0 && data.qrc !== 1)) {
      return { status: 'unavailable' }
    }
    if (numericId !== undefined && Number(data.songID) !== numericId)
      return { status: 'unavailable' }
    if (data.qrc === 0 || !data.lyric.trim()) return { status: 'missing' }
    const lyrics = await decodeQrc(data.lyric, signal)
    if (!/^\[\d+,\d+\].*\(\d+,\d+\)/m.test(lyrics)) return { status: 'unavailable' }
    const result: NativeLyricsData = { source: 'qq', format: 'qrc', lyrics }
    const extras = await Promise.allSettled([
      optionalLyric(data.trans, signal),
      optionalLyric(data.roma, signal),
    ])
    signal.throwIfAborted()
    if (extras[0].status === 'fulfilled' && extras[0].value) result.translation = extras[0].value
    if (extras[1].status === 'fulfilled' && extras[1].value) result.romanization = extras[1].value
    return { status: 'found', data: result }
  } catch {
    return { status: 'unavailable' }
  }
}
