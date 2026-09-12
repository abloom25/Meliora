import type { MetingPlaylistConfig } from './music-config'

export function buildMetingPlaylistUrl(
  apiEndpoint: string,
  playlist: MetingPlaylistConfig,
): string {
  const baseUrl = 'https://meliora.local'
  const isAbsoluteUrl = /^[a-z][a-z\d+.-]*:/i.test(apiEndpoint)
  const isProtocolRelativeUrl = apiEndpoint.startsWith('//')
  const url = new URL(apiEndpoint, baseUrl)

  url.searchParams.set('server', playlist.server)
  url.searchParams.set('type', 'playlist')
  url.searchParams.set('id', playlist.playlistId)

  if (isAbsoluteUrl) return url.toString()
  if (isProtocolRelativeUrl) return `//${url.host}${url.pathname}${url.search}${url.hash}`

  const pathname = apiEndpoint.startsWith('/') ? url.pathname : url.pathname.replace(/^\//, '')
  return `${pathname}${url.search}${url.hash}`
}
