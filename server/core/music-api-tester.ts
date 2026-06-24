import { isPublicHttpUrl, type ConfigPayload } from './types'

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    return await fetch(url, { signal: controller.signal })
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
  const params = new URLSearchParams({
    server: playlist.server,
    type: 'playlist',
    id: playlist.playlistId.trim(),
  })
  if (config.apiToken?.trim()) params.set('token', config.apiToken.trim())

  try {
    const response = await fetchWithTimeout(`${config.apiEndpoint.trim()}?${params.toString()}`)
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

    const payload: unknown = await response.json()
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
      error: error instanceof DOMException && error.name === 'AbortError' ? '请求超时' : '请求失败',
    }
  }
}

export async function testMusicApi(config: ConfigPayload): Promise<Response> {
  if (!config.apiEndpoint?.trim()) {
    return jsonResponse({ error: '请先填写 API 端点' }, 400)
  }
  // testMusicApi 接收的是前端传入的临时配置,不一定经 putConfig 校验,
  // 此处独立校验 apiEndpoint 为公网 http(s) URL,防止 SSRF 探测内网/元数据端点。
  if (!isPublicHttpUrl(config.apiEndpoint)) {
    return jsonResponse({ error: 'API 端点必须是公网 http(s) URL,不允许内网或本地地址' }, 400)
  }

  const playlists = config.playlists.filter(
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
