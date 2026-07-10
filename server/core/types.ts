import {
  isDevelopmentMode as isExplicitDevelopmentMode,
  truthy,
  validateEncryptionKey,
  validatePublicEnv,
  type EnvValidation,
  type KeyValidation,
} from '../../shared/env-schema'
import { isPublicHttpUrl, isPublicHttpsUrl } from '../../shared/utils/url-validation'

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

export {
  truthy,
  validateEncryptionKey,
  isPublicHttpUrl,
  isPublicHttpsUrl,
  type EnvValidation,
  type KeyValidation,
}

// 综合校验生产环境必填变量:GH_TOKEN、GH_REPO 与 CONFIG_ENCRYPTION_KEY。
// 任一不满足则前端拦截到 /warning 全屏页,无法使用任何管理功能。
export function validateEnv(env: Env): EnvValidation {
  return validatePublicEnv(env)
}
