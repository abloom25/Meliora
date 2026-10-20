export const DEV_MUSIC_PROXY_PREFIX = '/__meliora-dev/music'

/** 在服务端核对原始请求路径,防止直接绕过前端 URL 转换函数。 */
export function isDevMusicProxyPathAllowed(path: string, endpoint: URL): boolean {
  return path.split('?')[0] === `${DEV_MUSIC_PROXY_PREFIX}${endpoint.pathname}`
}

/** 仅代理配置的音乐 API 路径,不接管第三方封面/CDN,也不接受任意目标地址。 */
export function resolveDevMusicUrl(url: string, apiEndpoint: string, enabled: boolean): string {
  if (!enabled) return url
  try {
    const endpoint = new URL(apiEndpoint)
    const resource = new URL(url, endpoint)
    if (!/^https?:$/.test(endpoint.protocol)) return url
    if (resource.origin !== endpoint.origin || resource.pathname !== endpoint.pathname) return url
    return `${DEV_MUSIC_PROXY_PREFIX}${resource.pathname}${resource.search}${resource.hash}`
  } catch {
    return url
  }
}
