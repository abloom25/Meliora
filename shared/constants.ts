/**
 * 应用常量定义
 * 集中管理项目中的魔法数字和常量值
 */

/**
 * 认证相关常量
 */
export const AUTH_CONSTANTS = {
  /** PBKDF2 迭代次数 */
  PBKDF2_ITERATIONS: 600000,
  /** 最小密码长度 */
  MIN_PASSWORD_LENGTH: 8,
  /** Admin token 最大有效期（毫秒）*/
  ADMIN_TOKEN_MAX_AGE: 2 * 60 * 60 * 1000, // 2 小时
  /** Viewer token 最大有效期（毫秒）*/
  VIEWER_TOKEN_MAX_AGE: 7 * 24 * 60 * 60 * 1000, // 7 天
  /** Token 版本缓存 TTL（毫秒）*/
  TOKEN_VERSION_TTL: 5_000, // 5 秒
} as const

/**
 * CSRF 相关常量
 */
export const CSRF_CONSTANTS = {
  /** Token 最大有效期（毫秒）*/
  MAX_AGE: 7 * 24 * 60 * 60 * 1000, // 7 天
  /** 浏览器端临时持久化键 */
  STORAGE_KEY: 'meliora_csrf',
} as const

/**
 * 缓存相关常量
 */
export const CACHE_CONSTANTS = {
  /** 封面预加载缓存限制 */
  COVER_PRELOAD_LIMIT: 64,
  /** 封面预加载缓存 TTL（毫秒）*/
  COVER_PRELOAD_TTL: 2 * 60 * 1000, // 2 分钟
  /** 歌词预加载缓存限制 */
  LYRICS_PRELOAD_LIMIT: 32,
} as const

/**
 * 预加载超时常量（毫秒）
 */
export const PRELOAD_TIMEOUTS = {
  /** 封面预加载超时 */
  COVER: 9000, // 9 秒
  /** 歌词预加载超时 */
  LYRICS: 5000, // 5 秒
} as const

/**
 * 最小密钥长度要求
 */
export const SECURITY_CONSTANTS = {
  /** 最小加密密钥长度 */
  MIN_ENCRYPTION_KEY_LENGTH: 32,
} as const

/**
 * 配置与外部请求的资源上限
 */
export const CONFIG_LIMITS = {
  /** 持久化配置允许的最大歌单数 */
  MAX_PLAYLISTS: 100,
  /** 持久化配置允许的最大本地歌曲数 */
  MAX_LOCAL_TRACKS: 5_000,
  /** 单次“测试音乐 API”允许测试的最大歌单数 */
  MAX_TEST_PLAYLISTS: 20,
  /** 单个音乐 API 测试响应允许读取的最大字节数 */
  MAX_TEST_RESPONSE_BYTES: 2 * 1024 * 1024,
} as const

export const UPLOAD_LIMITS = {
  MAX_BYTES: 25 * 1024 * 1024,
  MAX_SIZE_LABEL: '25MB',
  MAX_BASE64_LENGTH: Math.ceil((25 * 1024 * 1024) / 3) * 4,
} as const

/**
 * 媒体会话操作类型
 */
export const MEDIA_SESSION_ACTIONS = [
  'play',
  'pause',
  'previoustrack',
  'nexttrack',
  'seekto',
  'seekbackward',
  'seekforward',
] as const
