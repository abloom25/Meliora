import {
  isDevelopmentMode as isExplicitDevelopmentMode,
  truthy,
  validateEncryptionKey,
  validatePublicEnv,
  type EnvValidation,
  type KeyValidation,
} from '../../shared/env-schema'

export interface Env {
  GH_TOKEN: string
  GH_REPO: string
  GH_BRANCH: string
  GITHUB_PROXY?: string
  ADMIN_DISABLED?: string
  // 显式开发模式开关。设为 true/1/yes/on(大小写、首尾空格不敏感)时进入开发模式,
  // 配置/密码不持久化、加密签名走明文降级。
  DEVELOPMENT?: string
  // 必填的独立配置加密密钥。配置加密与 Cookie 签名均从它派生,
  // GH_TOKEN 仅用于 GitHub API 读写,可独立轮换而不影响已加密的配置。
  CONFIG_ENCRYPTION_KEY: string
}

export interface AdminUser {
  authenticated: boolean
}

export interface ConfigPayload {
  siteName: string
  siteIcon?: string
  apiEndpoint: string
  apiToken?: string
  playlists: Array<{ server: 'netease' | 'tencent'; playlistId: string; enabled?: boolean }>
  localTracks: Array<{
    id: string
    title: string
    artist: string
    audio: string
    album?: string
    cover?: string
    lyrics?: string
  }>
  githubProxy?: string
  umami?: {
    enabled?: boolean
    scriptUrl?: string
    websiteId?: string
  }
  googleAnalytics?: {
    enabled?: boolean
    measurementId?: string
  }
  googleSiteVerification?: string
  customCss?: string
  customJs?: string
}

export interface UploadPayload {
  path: string
  content: string
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

// 开发模式:DEVELOPMENT 显式启用。
// 开发模式下配置/密码不持久化,加密与签名走明文降级。
// 集中定义避免各模块重复实现导致判断条件不一致。
export function isDevelopmentMode(env: Env): boolean {
  return isExplicitDevelopmentMode(env)
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
// Edge Runtime 无法做 DNS 反查,此处仅做 hostname 字面量校验,可挡住直接 IP 型 SSRF。
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

  // IPv4 字面量:拒绝所有私有/保留/链路本地/环回/元数据网段
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
    if (a >= 224) return false // 组播(224-239)与保留(240+)
    return true
  }

  // IPv6 字面量:拒绝环回、链路本地、唯一本地地址
  if (host.startsWith('[')) {
    if (isBlockedIpv6Host(host)) return false
    return true
  }

  return true
}

export { truthy, validateEncryptionKey, type EnvValidation, type KeyValidation }

// 综合校验生产环境必填变量:GH_REPO 与 CONFIG_ENCRYPTION_KEY。
// 任一不满足则前端拦截到 /warning 全屏页,无法使用任何管理功能。
export function validateEnv(env: Env): EnvValidation {
  return validatePublicEnv(env)
}
