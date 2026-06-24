export interface Env {
  GH_TOKEN: string
  GH_REPO: string
  GH_BRANCH: string
  GITHUB_PROXY?: string
  ADMIN_DISABLED?: string
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

// 本地开发模式:GH_TOKEN 为空或占位符时,配置/密码不持久化,加密与签名走明文降级。
// 集中定义避免各模块重复实现导致判断条件不一致。
export function isLocalMode(env: Env): boolean {
  return (
    !env.GH_TOKEN || env.GH_TOKEN.startsWith('placeholder') || env.GH_TOKEN.startsWith('ghp_xxx')
  )
}

export interface KeyValidation {
  ok: boolean
  error?: string
}

const MIN_KEY_LENGTH = 32
// 常见弱密钥模式:全相同字符、纯顺序字符
const WEAK_KEY_PATTERNS = [
  /^(.)\1+$/,
  /^(0123456789|1234567890|abcdefgh|abcdefghijklmnopqrstuvwxyz)/i,
]

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
    if (host === '[::1]') return false
    if (host.startsWith('[fe80')) return false
    if (host.startsWith('[fc') || host.startsWith('[fd')) return false
    return true
  }

  return true
}

// 校验配置加密密钥强度。生产模式下 CONFIG_ENCRYPTION_KEY 必填且需达到最低强度,
// 否则拒绝初始化(setup)并提示用户更换为随机字符串。本地开发模式不校验(不加密)。
export function validateEncryptionKey(env: Env): KeyValidation {
  if (isLocalMode(env)) return { ok: true }
  const key = env.CONFIG_ENCRYPTION_KEY
  if (!key) {
    return {
      ok: false,
      error: '未设置 CONFIG_ENCRYPTION_KEY 环境变量,请在部署平台配置后再初始化',
    }
  }
  if (key.length < MIN_KEY_LENGTH) {
    return {
      ok: false,
      error: `CONFIG_ENCRYPTION_KEY 强度不足(至少 ${MIN_KEY_LENGTH} 位),请更换为足够长的随机字符串`,
    }
  }
  for (const pattern of WEAK_KEY_PATTERNS) {
    if (pattern.test(key)) {
      return {
        ok: false,
        error: 'CONFIG_ENCRYPTION_KEY 过于简单,请更换为随机字符串',
      }
    }
  }
  return { ok: true }
}

export interface EnvValidation {
  ok: boolean
  errors: string[]
}

// 综合校验生产环境必填变量:GH_TOKEN 与 CONFIG_ENCRYPTION_KEY。
// 任一不满足则前端拦截到 /warning 全屏页,无法使用任何管理功能。
// 本地开发模式直接放行,但若已设置 CONFIG_ENCRYPTION_KEY 却仍被判为本地模式
// (GH_TOKEN 缺失/占位),视为生产环境漏配 GH_TOKEN,拒绝静默降级。
export function validateEnv(env: Env): EnvValidation {
  if (isLocalMode(env)) {
    if (env.CONFIG_ENCRYPTION_KEY) {
      return {
        ok: false,
        errors: [
          'GH_TOKEN 未设置或为占位符,但已设置 CONFIG_ENCRYPTION_KEY。请配置真实 GH_TOKEN,或清除 CONFIG_ENCRYPTION_KEY 以使用本地开发模式。',
        ],
      }
    }
    return { ok: true, errors: [] }
  }
  const errors: string[] = []
  if (!env.GH_TOKEN) {
    errors.push('未设置 GH_TOKEN 环境变量,无法读写 GitHub 仓库配置')
  }
  const keyCheck = validateEncryptionKey(env)
  if (!keyCheck.ok && keyCheck.error) {
    errors.push(keyCheck.error)
  }
  return { ok: errors.length === 0, errors }
}
