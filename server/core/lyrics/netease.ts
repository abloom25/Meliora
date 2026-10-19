import type { NativeLyricsResult } from '../../../shared/native-lyrics'
import { encryptNeteaseParams } from './netease-crypto'
import { fetchLyricsJson } from './upstream'

const LYRICS_PATH = '/api/song/lyric/v1'
const LYRICS_URL = 'https://interface3.music.163.com/eapi/song/lyric/v1'
const YRC_WORD_LINE = /^\[\d+,\d+\]\s*\(\d+,\d+,-?\d+\)[^\r\n]+/m

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readLyric(value: unknown): string | undefined {
  return isRecord(value) && typeof value.lyric === 'string' ? value.lyric : undefined
}

function optionalLyric(primary: unknown, fallback: unknown): string | undefined {
  return readLyric(primary)?.trim() || readLyric(fallback)?.trim() || undefined
}

export async function fetchNeteaseLyrics(
  id: string,
  signal: AbortSignal,
): Promise<NativeLyricsResult> {
  if (!/^[1-9]\d{0,19}$/.test(id) || signal.aborted) return { status: 'unavailable' }

  try {
    const params = await encryptNeteaseParams(LYRICS_PATH, {
      id,
      cp: false,
      tv: 0,
      lv: 0,
      rv: 0,
      kv: 0,
      yv: 0,
      ytv: 0,
      yrv: 0,
    })
    if (signal.aborted) return { status: 'unavailable' }
    const response = await fetchLyricsJson(
      LYRICS_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          Origin: 'https://music.163.com',
          Referer: 'https://music.163.com',
          'User-Agent': 'Mozilla/5.0',
        },
        body: new URLSearchParams({ params }).toString(),
      },
      signal,
    )
    if (signal.aborted || !isRecord(response) || response.code !== 200) {
      return { status: 'unavailable' }
    }

    const lyrics = readLyric(response.yrc)
    if (response.yrc != null && lyrics === undefined) return { status: 'unavailable' }
    if (lyrics?.trim()) {
      if (!YRC_WORD_LINE.test(lyrics)) return { status: 'unavailable' }
      return {
        status: 'found',
        data: {
          source: 'netease',
          format: 'yrc',
          lyrics,
          translation: optionalLyric(response.ytlrc, response.tlyric),
          romanization: optionalLyric(response.yromalrc, response.romalrc),
        },
      }
    }

    // Only a recognizable lyric response can establish a cacheable miss.
    // Truncated payloads and upstream error pages must remain retryable.
    if (
      lyrics !== undefined ||
      readLyric(response.lrc) !== undefined ||
      response.nolyric === true ||
      response.uncollected === true
    ) {
      return { status: 'missing' }
    }
    return { status: 'unavailable' }
  } catch {
    return { status: 'unavailable' }
  }
}
