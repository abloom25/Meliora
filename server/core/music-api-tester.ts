import type { ConfigPayload } from './types'
import { validateMusicConfig } from '../../shared/config-schema'
import { CONFIG_LIMITS } from '../../shared/constants'
import { buildMetingPlaylistUrl } from '../../shared/music-api'
import { getPlaybackSupportError } from '../../shared/playback-support'
import { jsonResponse } from './http'
import { ResponseTooLargeError, readJsonWithLimit } from './read-json-with-limit'

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

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal, redirect: 'manual' })
  } finally {
    clearTimeout(timer)
  }
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
  try {
    const response = await fetchWithTimeout(buildMetingPlaylistUrl(config.apiEndpoint, playlist))
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
  const playbackError = getPlaybackSupportError(config)
  if (playbackError) return jsonResponse({ error: playbackError }, 400)

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
