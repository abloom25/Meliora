import type { PlaylistDetails } from '../../shared/music-config'
import { jsonResponse } from './http'
import { consumeRateLimit } from './rate-limit'
import { readJsonWithLimit } from './read-json-with-limit'

const cache = new Map<string, { details: PlaylistDetails; expires: number }>()
const ttl = 3600
const limit = { key: 'playlist-details', limit: 120, windowMs: 60_000, blockMs: 60_000 }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function coverUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return undefined
  return value.replace(/^http:/i, 'https:')
}

export async function getPlaylistDetails(request: Request, clientIp?: string): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse({ error: '仅支持 GET' }, 405, { Allow: 'GET' })
  const params = new URL(request.url).searchParams
  const platform = params.get('server')
  const id = params.get('id') ?? ''
  if ((platform !== 'netease' && platform !== 'tencent') || !/^\d{1,20}$/.test(id))
    return jsonResponse({ error: '歌单平台或 ID 无效' }, 400)

  const key = `${platform}:${id}`
  const cached = cache.get(key)
  if (cached && cached.expires > Date.now())
    return jsonResponse(cached.details, 200, {
      'Cache-Control': `public, max-age=${Math.floor((cached.expires - Date.now()) / 1000)}`,
    })
  const quota = consumeRateLimit(limit, clientIp)
  if (!quota.allowed)
    return jsonResponse({ error: '请稍后重试' }, 429, {
      'Retry-After': String(quota.retryAfterSeconds),
    })

  const netease = platform === 'netease'
  const url = netease
    ? `https://music.163.com/api/v6/playlist/detail?id=${id}&n=0&s=0`
    : `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${id}&format=json&song_begin=0&song_num=1`
  try {
    const response = await fetch(url, {
      headers: { Referer: netease ? 'https://music.163.com/' : 'https://y.qq.com/' },
      signal: AbortSignal.timeout(6000),
      redirect: 'manual',
    })
    if (!response.ok) throw new Error('Upstream unavailable')
    const payload = record(await readJsonWithLimit(response, 2 * 1024 * 1024))
    const item = record(
      netease ? payload.playlist : Array.isArray(payload.cdlist) && payload.cdlist[0],
    )
    const name = netease ? item.name : item.dissname
    if (payload.code !== (netease ? 200 : 0) || typeof name !== 'string' || !name.trim())
      return jsonResponse({ error: '歌单资料不可用' }, 404)
    const details = { name: name.trim(), cover: coverUrl(netease ? item.coverImgUrl : item.logo) }
    cache.delete(key)
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(key, { details, expires: Date.now() + ttl * 1000 })
    return jsonResponse(details, 200, { 'Cache-Control': `public, max-age=${ttl}` })
  } catch {
    return jsonResponse({ error: '平台暂时无法返回歌单资料' }, 502)
  }
}
