import type {
  GoogleAnalyticsConfig,
  LocalTrackConfig,
  MetingPlaylistConfig,
  MusicConfig,
  MusicServer,
  UmamiConfig,
} from '../src/types/music'

export interface MusicConfigValidationResult {
  valid: boolean
  config?: MusicConfig
  errors: string[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBlockedIpv6Host(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fe80:')) return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  // IPv4-mapped IPv6 can hide private IPv4 targets after URL normalization
  // (for example [::ffff:127.0.0.1] -> [::ffff:7f00:1]).
  if (normalized.startsWith('::ffff:')) return true
  return false
}

// 判断 URL 是否为公网 http(s) 地址,用于防止管理员将 apiEndpoint 指向内网/元数据端点
// 造成 SSRF(如 169.254.169.254 云元数据、localhost、私有网段)。
// Edge Runtime 与浏览器均无法做 DNS 反查,此处仅做 hostname 字面量校验,可挡住直接 IP 型 SSRF。
// 此处为 shared 独立实现,不依赖 server/core/types,避免 server 代码混入前端 bundle。
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false

  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.endsWith('.local')) return false

  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
    const parts = host.split('.').map(Number)
    if (parts.some((p) => p > 255)) return false
    const [a, b] = parts
    if (a === 0) return false
    if (a === 10) return false
    if (a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a >= 224) return false
    return true
  }

  if (host.startsWith('[')) {
    if (isBlockedIpv6Host(host)) return false
    return true
  }

  return true
}

export function validateMusicConfig(input: unknown): MusicConfigValidationResult {
  const errors: string[] = []

  if (!isObject(input)) {
    return { valid: false, errors: ['配置必须是一个对象'] }
  }

  const config = input

  if (typeof config.siteName !== 'string' || !config.siteName.trim()) {
    errors.push('siteName 必须是非空字符串')
  }

  if (config.siteIcon !== undefined && typeof config.siteIcon !== 'string') {
    errors.push('siteIcon 必须是字符串')
  }

  const hasEnabledPlaylist =
    Array.isArray(config.playlists) &&
    config.playlists.some((item) => isObject(item) && item.enabled !== false)
  if (typeof config.apiEndpoint !== 'string') {
    errors.push('apiEndpoint 必须是字符串')
  } else if (hasEnabledPlaylist && !config.apiEndpoint.trim()) {
    errors.push('启用远程歌单时 apiEndpoint 必须是非空字符串')
  } else if (config.apiEndpoint.trim() && !isPublicHttpUrl(config.apiEndpoint)) {
    errors.push('apiEndpoint 必须是公网 http(s) URL,不允许内网或本地地址')
  }

  if (config.apiToken !== undefined && typeof config.apiToken !== 'string') {
    errors.push('apiToken 必须是字符串')
  }

  if (config.githubProxy !== undefined && typeof config.githubProxy !== 'string') {
    errors.push('githubProxy 必须是字符串')
  } else if (
    typeof config.githubProxy === 'string' &&
    config.githubProxy.trim() &&
    !isPublicHttpUrl(
      config.githubProxy.includes('{url}')
        ? config.githubProxy.replace('{url}', encodeURIComponent('https://api.github.com'))
        : config.githubProxy,
    )
  ) {
    errors.push('githubProxy 必须是公网 http(s) URL,不允许内网或本地地址')
  }

  if (
    config.receivePrereleaseUpdates !== undefined &&
    typeof config.receivePrereleaseUpdates !== 'boolean'
  ) {
    errors.push('receivePrereleaseUpdates 必须是布尔值')
  }

  if (config.umami !== undefined) {
    if (!isObject(config.umami)) {
      errors.push('umami 必须是对象')
    } else {
      const umami = config.umami
      if (umami.enabled !== undefined && typeof umami.enabled !== 'boolean') {
        errors.push('umami.enabled 必须是布尔值')
      }
      if (umami.scriptUrl !== undefined && typeof umami.scriptUrl !== 'string') {
        errors.push('umami.scriptUrl 必须是字符串')
      }
      if (umami.websiteId !== undefined && typeof umami.websiteId !== 'string') {
        errors.push('umami.websiteId 必须是字符串')
      }
    }
  }

  if (config.googleAnalytics !== undefined) {
    if (!isObject(config.googleAnalytics)) {
      errors.push('googleAnalytics 必须是对象')
    } else {
      const googleAnalytics = config.googleAnalytics
      if (googleAnalytics.enabled !== undefined && typeof googleAnalytics.enabled !== 'boolean') {
        errors.push('googleAnalytics.enabled 必须是布尔值')
      }
      if (
        googleAnalytics.measurementId !== undefined &&
        typeof googleAnalytics.measurementId !== 'string'
      ) {
        errors.push('googleAnalytics.measurementId 必须是字符串')
      }
    }
  }

  if (
    config.googleSiteVerification !== undefined &&
    typeof config.googleSiteVerification !== 'string'
  ) {
    errors.push('googleSiteVerification 必须是字符串')
  }

  if (config.customCss !== undefined && typeof config.customCss !== 'string') {
    errors.push('customCss 必须是字符串')
  }

  if (config.customJs !== undefined && typeof config.customJs !== 'string') {
    errors.push('customJs 必须是字符串')
  }

  if (!Array.isArray(config.playlists)) {
    errors.push('playlists 必须是数组')
  } else {
    config.playlists.forEach((item, index) => {
      if (!isObject(item)) {
        errors.push(`playlists[${index}] 必须是对象`)
        return
      }
      const playlist = item
      if (playlist.server !== 'netease' && playlist.server !== 'tencent') {
        errors.push(`playlists[${index}].server 必须是 netease 或 tencent`)
      }
      if (typeof playlist.playlistId !== 'string' || !playlist.playlistId.trim()) {
        errors.push(`playlists[${index}].playlistId 必须是非空字符串`)
      }
    })
  }

  if (!Array.isArray(config.localTracks)) {
    errors.push('localTracks 必须是数组')
  } else {
    config.localTracks.forEach((item, index) => {
      if (!isObject(item)) {
        errors.push(`localTracks[${index}] 必须是对象`)
        return
      }
      const track = item
      if (typeof track.id !== 'string' || !track.id.trim()) {
        errors.push(`localTracks[${index}].id 必须是非空字符串`)
      }
      if (typeof track.title !== 'string' || !track.title.trim()) {
        errors.push(`localTracks[${index}].title 必须是非空字符串`)
      }
      if (typeof track.artist !== 'string' || !track.artist.trim()) {
        errors.push(`localTracks[${index}].artist 必须是非空字符串`)
      }
      if (typeof track.audio !== 'string' || !track.audio.trim()) {
        errors.push(`localTracks[${index}].audio 必须是非空字符串`)
      }
    })
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  const cleaned: MusicConfig = {
    siteName: config.siteName as string,
    apiEndpoint: config.apiEndpoint as string,
    playlists: (config.playlists as Record<string, unknown>[]).map((item) => {
      const playlist: MetingPlaylistConfig = {
        server: item.server as MusicServer,
        playlistId: item.playlistId as string,
      }
      if (typeof item.enabled === 'boolean') playlist.enabled = item.enabled
      return playlist
    }),
    localTracks: (config.localTracks as Record<string, unknown>[]).map((item) => {
      const track: LocalTrackConfig = {
        id: item.id as string,
        title: item.title as string,
        artist: item.artist as string,
        audio: item.audio as string,
      }
      if (typeof item.album === 'string') track.album = item.album
      if (typeof item.cover === 'string') track.cover = item.cover
      if (typeof item.lyrics === 'string') track.lyrics = item.lyrics
      return track
    }),
  }

  if (typeof config.siteIcon === 'string') cleaned.siteIcon = config.siteIcon
  if (typeof config.apiToken === 'string') cleaned.apiToken = config.apiToken
  if (typeof config.githubProxy === 'string') cleaned.githubProxy = config.githubProxy
  if (typeof config.receivePrereleaseUpdates === 'boolean') {
    cleaned.receivePrereleaseUpdates = config.receivePrereleaseUpdates
  }
  if (typeof config.googleSiteVerification === 'string') {
    cleaned.googleSiteVerification = config.googleSiteVerification
  }
  if (typeof config.customCss === 'string') cleaned.customCss = config.customCss
  if (typeof config.customJs === 'string') cleaned.customJs = config.customJs

  if (isObject(config.umami)) {
    const umami: UmamiConfig = {}
    const u = config.umami
    if (typeof u.enabled === 'boolean') umami.enabled = u.enabled
    if (typeof u.scriptUrl === 'string') umami.scriptUrl = u.scriptUrl
    if (typeof u.websiteId === 'string') umami.websiteId = u.websiteId
    cleaned.umami = umami
  }

  if (isObject(config.googleAnalytics)) {
    const googleAnalytics: GoogleAnalyticsConfig = {}
    const g = config.googleAnalytics
    if (typeof g.enabled === 'boolean') googleAnalytics.enabled = g.enabled
    if (typeof g.measurementId === 'string') googleAnalytics.measurementId = g.measurementId
    cleaned.googleAnalytics = googleAnalytics
  }

  return { valid: true, config: cleaned, errors: [] }
}
