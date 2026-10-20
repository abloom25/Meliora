import { DEV_MUSIC_PROXY_PREFIX, isDevMusicProxyPathAllowed } from '../shared/dev-music-proxy'

interface DevRequest {
  headers: Record<string, string | string[] | undefined>
  url?: string
  method?: string
}

interface DevResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body: string): void
}

/** 只允许本页的 JSON 写入,避免局域网开发服务接受其他站点提交的配置。 */
export function isLocalConfigWriteAllowed(request: DevRequest): boolean {
  const { origin, referer, host } = request.headers
  const source = origin ?? referer
  if (typeof host !== 'string' || typeof source !== 'string') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const contentType = request.headers['content-type']
  if (
    typeof contentType !== 'string' ||
    contentType.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    return false
  }
  try {
    return new URL(source).origin === `http://${host}`
  } catch {
    return false
  }
}

export function guardDevMusicProxy(
  endpoint: URL | null,
): (request: DevRequest, response: DevResponse, next: () => void) => void {
  return (request, response, next) => {
    const path = request.url ?? ''
    if (!path.startsWith(`${DEV_MUSIC_PROXY_PREFIX}/`)) {
      next()
      return
    }
    if (!endpoint || !isDevMusicProxyPathAllowed(path, endpoint)) {
      response.statusCode = 404
      response.end('Not Found')
      return
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.statusCode = 405
      response.setHeader('Allow', 'GET, HEAD')
      response.end('Method Not Allowed')
      return
    }
    next()
  }
}
