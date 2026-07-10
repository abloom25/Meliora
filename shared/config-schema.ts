import type {
  GoogleAnalyticsConfig,
  LocalTrackConfig,
  MetingPlaylistConfig,
  MusicConfig,
  MusicServer,
  UmamiConfig,
} from '../src/types/music'
import { isPublicHttpsUrl, isValidUrl } from './utils/url-validation'
import { CONFIG_LIMITS } from './constants'

export interface MusicConfigValidationResult {
  valid: boolean
  config?: MusicConfig
  errors: string[]
}

export interface MusicConfigValidationOptions {
  /** 仅供显式开发模式使用；默认执行公网 HTTPS 限制。 */
  allowPrivateUrls?: boolean
  maxPlaylists?: number
  maxLocalTracks?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function validateMusicConfig(
  input: unknown,
  options: MusicConfigValidationOptions = {},
): MusicConfigValidationResult {
  const errors: string[] = []
  const requirePublicHttps = options.allowPrivateUrls !== true
  const maxPlaylists = options.maxPlaylists ?? CONFIG_LIMITS.MAX_PLAYLISTS
  const maxLocalTracks = options.maxLocalTracks ?? CONFIG_LIMITS.MAX_LOCAL_TRACKS

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
  } else if (config.apiEndpoint.trim()) {
    if (requirePublicHttps && !isPublicHttpsUrl(config.apiEndpoint)) {
      errors.push('生产环境 apiEndpoint 必须是公网 https URL')
    } else if (!isValidUrl(config.apiEndpoint)) {
      errors.push('apiEndpoint 必须是有效的 http(s) URL')
    }
  }

  if (config.apiToken !== undefined && typeof config.apiToken !== 'string') {
    errors.push('apiToken 必须是字符串')
  }

  if (config.githubProxy !== undefined && typeof config.githubProxy !== 'string') {
    errors.push('githubProxy 必须是字符串')
  } else if (typeof config.githubProxy === 'string' && config.githubProxy.trim()) {
    const proxyUrl = config.githubProxy.includes('{url}')
      ? config.githubProxy.replace('{url}', encodeURIComponent('https://api.github.com'))
      : config.githubProxy

    if (requirePublicHttps && !isPublicHttpsUrl(proxyUrl)) {
      errors.push('生产环境 githubProxy 必须是公网 https URL')
    } else if (!isValidUrl(proxyUrl)) {
      errors.push('githubProxy 必须是有效的 http(s) URL')
    }
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
      } else if (typeof umami.scriptUrl === 'string' && umami.scriptUrl.trim()) {
        if (requirePublicHttps && !isPublicHttpsUrl(umami.scriptUrl)) {
          errors.push('生产环境 umami.scriptUrl 必须是公网 https URL')
        } else if (!isValidUrl(umami.scriptUrl)) {
          errors.push('umami.scriptUrl 必须是有效的 http(s) URL')
        }
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
    const playlistKeys = new Set<string>()
    if (config.playlists.length > maxPlaylists) {
      errors.push(`playlists 最多允许 ${maxPlaylists} 项`)
    }
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
      } else if (playlist.server === 'netease' || playlist.server === 'tencent') {
        const key = `${playlist.server}:${playlist.playlistId.trim()}`
        if (playlistKeys.has(key)) {
          errors.push(`playlists[${index}] 与已有歌单重复`)
        } else {
          playlistKeys.add(key)
        }
      }
    })
  }

  if (!Array.isArray(config.localTracks)) {
    errors.push('localTracks 必须是数组')
  } else {
    const localTrackIds = new Set<string>()
    if (config.localTracks.length > maxLocalTracks) {
      errors.push(`localTracks 最多允许 ${maxLocalTracks} 项`)
    }
    config.localTracks.forEach((item, index) => {
      if (!isObject(item)) {
        errors.push(`localTracks[${index}] 必须是对象`)
        return
      }
      const track = item
      if (typeof track.id !== 'string' || !track.id.trim()) {
        errors.push(`localTracks[${index}].id 必须是非空字符串`)
      } else {
        const normalizedId = track.id.trim()
        if (localTrackIds.has(normalizedId)) {
          errors.push(`localTracks[${index}].id 与已有歌曲重复`)
        } else {
          localTrackIds.add(normalizedId)
        }
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
    siteName: (config.siteName as string).trim(),
    apiEndpoint: (config.apiEndpoint as string).trim(),
    playlists: (config.playlists as Record<string, unknown>[]).map((item) => {
      const playlist: MetingPlaylistConfig = {
        server: item.server as MusicServer,
        playlistId: (item.playlistId as string).trim(),
      }
      if (typeof item.enabled === 'boolean') playlist.enabled = item.enabled
      return playlist
    }),
    localTracks: (config.localTracks as Record<string, unknown>[]).map((item) => {
      const track: LocalTrackConfig = {
        id: (item.id as string).trim(),
        title: (item.title as string).trim(),
        artist: (item.artist as string).trim(),
        audio: (item.audio as string).trim(),
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
