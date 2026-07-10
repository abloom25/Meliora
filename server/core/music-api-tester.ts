import type { ConfigPayload } from './types'
import { validateMusicConfig } from '../../shared/config-schema'
import { CONFIG_LIMITS } from '../../shared/constants'
import { jsonResponse } from './http'

interface PlaylistApiCheck {
  server: string
  playlistId: string
  ok: boolean
  status?: number
  trackCount: number
  error?: string
}

interface MusicApiTestResult {
  ok: boolean
  playlistCount: number
  failedPlaylists: number
  trackCount: number
  playlists: PlaylistApiCheck[]
}

const TEST_TIMEOUT_MS = 8000
const PLAYLIST_CONCURRENCY = 3

class ResponseTooLargeError extends Error {}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'manual' })
  } finally {
    clearTimeout(timer)
  }
}

async function readJsonWithLimit(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ResponseTooLargeError('response body exceeds limit')
  }

  if (!response.body) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new ResponseTooLargeError('response body exceeds limit')
    }
    return JSON.parse(text)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      if (receivedBytes > maxBytes) {
        await reader.cancel('response body exceeds limit')
        throw new ResponseTooLargeError('response body exceeds limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(receivedBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

async function runLimited<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency = PLAYLIST_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = []
  let cursor = 0

  async function runNext(): Promise<void> {
    const index = cursor
    cursor += 1
    if (index >= items.length) return
    results[index] = await worker(items[index])
    await runNext()
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runNext()))
  return results
}

async function testPlaylistApi(
  config: ConfigPayload,
  playlist: ConfigPayload['playlists'][number],
): Promise<PlaylistApiCheck> {
  const params = new URLSearchParams({
    server: playlist.server,
    type: 'playlist',
    id: playlist.playlistId.trim(),
  })
  if (config.apiToken?.trim()) params.set('token', config.apiToken.trim())

  try {
    const response = await fetchWithTimeout(`${config.apiEndpoint.trim()}?${params.toString()}`)
    if (response.status >= 300 && response.status < 400) {
      return {
        server: playlist.server,
        playlistId: playlist.playlistId,
        ok: false,
        status: response.status,
        trackCount: 0,
        error: '重定向已拒绝',
      }
    }
    if (!response.ok) {
      return {
        server: playlist.server,
        playlistId: playlist.playlistId,
        ok: false,
        status: response.status,
        trackCount: 0,
        error: `HTTP ${response.status}`,
      }
    }

    const payload = await readJsonWithLimit(response, CONFIG_LIMITS.MAX_TEST_RESPONSE_BYTES)
    if (!Array.isArray(payload)) {
      return {
        server: playlist.server,
        playlistId: playlist.playlistId,
        ok: false,
        status: response.status,
        trackCount: 0,
        error: '响应不是歌曲列表',
      }
    }

    return {
      server: playlist.server,
      playlistId: playlist.playlistId,
      ok: true,
      status: response.status,
      trackCount: payload.length,
    }
  } catch (error) {
    return {
      server: playlist.server,
      playlistId: playlist.playlistId,
      ok: false,
      trackCount: 0,
      error:
        error instanceof DOMException && error.name === 'AbortError'
          ? '请求超时'
          : error instanceof ResponseTooLargeError
            ? '响应数据过大'
            : '请求失败',
    }
  }
}

export async function testMusicApi(input: unknown): Promise<Response> {
  const validation = validateMusicConfig(input, {
    maxPlaylists: CONFIG_LIMITS.MAX_TEST_PLAYLISTS,
    maxLocalTracks: CONFIG_LIMITS.MAX_LOCAL_TRACKS,
  })
  if (!validation.valid || !validation.config) {
    return jsonResponse({ error: '配置校验失败', details: validation.errors }, 400)
  }
  const config = validation.config

  const playlists: ConfigPayload['playlists'] = config.playlists.filter(
    (playlist) => playlist.enabled !== false && playlist.playlistId.trim(),
  )
  if (!playlists.length) {
    return jsonResponse({ error: '请先添加一个启用的歌单' }, 400)
  }

  const results = await runLimited(playlists, (playlist) => testPlaylistApi(config, playlist))
  const summary: MusicApiTestResult = {
    ok: results.every((item) => item.ok),
    playlistCount: results.length,
    failedPlaylists: results.filter((item) => !item.ok).length,
    trackCount: results.reduce((total, item) => total + item.trackCount, 0),
    playlists: results,
  }

  return jsonResponse(summary)
}
