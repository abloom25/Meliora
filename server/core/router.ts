import type { Env } from './types'
import {
  signToken,
  verifyAuth,
  createLoginHeaders,
  createLogoutHeaders,
  getSigningSecret,
} from './auth'
import { getConfig, putConfig } from './config-handler'
import { uploadFile, deleteTrackFiles } from './upload-handler'
import {
  verifyAdminPassword,
  isInitialized,
  setupPassword,
  changePassword,
} from './admin-auth-store'
import { isDevelopmentMode, validateEnv } from './types'
import { checkUpdate, getUpdateStatus, triggerUpdate } from './update-handler'
import { testMusicApi } from './music-api-tester'
import { consumeRateLimit, resetRateLimit, tryAcquireWorkSlot } from './rate-limit'
import { renderEnvNotReadyPage, renderDisabledPage } from './status-pages'
import { validateCsrfRequest, requiresCsrfProtection } from './csrf'
import { createErrorResponse, logSanitizedError } from './error-handler'
import { isLoopbackOrigin } from '../../shared/utils/url-validation'
import { UPLOAD_LIMITS } from '../../shared/constants'
import { jsonResponse } from './http'

export interface RequestContext {
  /** 仅允许由部署适配器从平台保证可信的请求元数据中填充。 */
  clientIp?: string
}

const LOGIN_RATE_LIMIT = {
  key: 'login',
  limit: 8,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
}

const SETUP_RATE_LIMIT = {
  key: 'setup',
  limit: 5,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
}

const UPDATE_RATE_LIMIT = {
  key: 'update',
  limit: 3,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
}

const CHECK_UPDATE_RATE_LIMIT = {
  key: 'check-update',
  limit: 10,
  windowMs: 10 * 60 * 1000,
  blockMs: 5 * 60 * 1000,
}

const UPDATE_STATUS_RATE_LIMIT = {
  key: 'update-status',
  limit: 240,
  windowMs: 15 * 60 * 1000,
  blockMs: 2 * 60 * 1000,
}

// changePassword 执行 PBKDF2 100k 迭代(CPU 密集),token 泄露后可被滥用消耗 CPU,故限流。
const CHANGE_PASSWORD_RATE_LIMIT = {
  key: 'change-password',
  limit: 5,
  windowMs: 10 * 60 * 1000,
  blockMs: 15 * 60 * 1000,
}

// testMusicApi 发起外部 fetch,可被用于 SSRF 探测/DoS,故限流。
const TEST_MUSIC_API_RATE_LIMIT = {
  key: 'test-music-api',
  limit: 10,
  windowMs: 10 * 60 * 1000,
  blockMs: 5 * 60 * 1000,
}

const PASSWORD_WORK_CONCURRENCY = 2

function rateLimitResponse(retryAfterSeconds: number): Response {
  return jsonResponse({ error: '请求过于频繁,请稍后再试' }, 429, {
    'Retry-After': String(retryAfterSeconds),
  })
}

function busyResponse(): Response {
  return jsonResponse({ error: '服务器正忙,请稍后再试' }, 503, { 'Retry-After': '2' })
}

// 归一化判断 ADMIN_DISABLED 是否为真值。
// 接受 true/1/yes/on(大小写、首尾空格不敏感),避免部署平台惯用值不生效且无提示。
function isDisabledValue(value: string | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase()
  return v === 'true' || v === '1' || v === 'yes' || v === 'on'
}

// 状态探针端点:禁用或环境未就绪时仍需返回对应状态页,供 /admin 前端感知并整页替换。
function isStatusProbe(path: string, method: string): boolean {
  return method === 'GET' && (path === '/api/setup-status' || path === '/api/status-page')
}

function isApiWriteRequest(path: string, method: string): boolean {
  return path.startsWith('/api/') && (method === 'POST' || method === 'PUT' || method === 'DELETE')
}

function headerMatchesRequestOrigin(headerValue: string, requestOrigin: string): boolean {
  try {
    return new URL(headerValue).origin === requestOrigin
  } catch {
    return false
  }
}

function headerOriginIsAllowed(headerValue: string, requestOrigin: string, env: Env): boolean {
  if (headerMatchesRequestOrigin(headerValue, requestOrigin)) return true
  return isDevelopmentMode(env) && isLoopbackOrigin(headerValue) && isLoopbackOrigin(requestOrigin)
}

function passesSameOriginWriteCheck(request: Request, url: URL, env: Env): boolean {
  const origin = request.headers.get('Origin')
  if (origin) {
    return headerOriginIsAllowed(origin, url.origin, env)
  }

  const referer = request.headers.get('Referer')
  if (referer) {
    return headerOriginIsAllowed(referer, url.origin, env)
  }

  // 服务端调用、CLI、部分同源表单请求可能没有 Origin/Referer,保留这些合理调用。
  return true
}

function isJsonRequest(request: Request): boolean {
  const contentType = request.headers.get('Content-Type') || ''
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

async function csrfErrorResponse(request: Request, env: Env): Promise<Response | null> {
  if (!requiresCsrfProtection(request)) return null
  const secret = await getSigningSecret(env)
  const isValidCsrf = await validateCsrfRequest(request, secret)
  if (isValidCsrf) return null
  return jsonResponse({ error: 'CSRF 令牌无效或已过期' }, 403)
}

export async function handleRequest(
  request: Request,
  env: Env,
  context: RequestContext = {},
): Promise<Response> {
  if (request.method === 'OPTIONS') {
    // 管理后台 API 为同域调用(SameSite=Lax Cookie 鉴权),不需要跨域 CORS 支持。
    // 之前版本反射任意 Origin 并允许 Credentials 是危险的半成品:一旦补上响应 CORS 头,
    // 任意站点即可携带 Cookie 调用管理 API。此处返回 204 不带 CORS 头,浏览器会阻止跨域请求。
    return new Response(null, { status: 204 })
  }

  const url = new URL(request.url)
  const path = url.pathname

  if (path === '/api/runtime-config') {
    return jsonResponse({ error: '未找到' }, 404)
  }

  const envCheck = validateEnv(env)
  const isDisabled = isDisabledValue(env.ADMIN_DISABLED)

  if (!envCheck.ok || isDisabled) {
    if (isStatusProbe(path, request.method)) {
      return isDisabled ? renderDisabledPage() : renderEnvNotReadyPage(envCheck)
    }
    return jsonResponse({ error: isDisabled ? '管理后台已禁用' : '环境变量未就绪' }, 403)
  }

  if (isApiWriteRequest(path, request.method) && !passesSameOriginWriteCheck(request, url, env)) {
    return jsonResponse({ error: '跨站请求已拒绝' }, 403)
  }

  try {
    if (path === '/api/login' && request.method === 'POST') {
      const rateLimit = consumeRateLimit(LOGIN_RATE_LIMIT, context.clientIp)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }

      const body = (await request.json().catch(() => ({}))) as { password?: string }
      if (!body.password) {
        return jsonResponse({ error: '密码错误' }, 401)
      }
      const releaseWork = tryAcquireWorkSlot('password', PASSWORD_WORK_CONCURRENCY)
      if (!releaseWork) return busyResponse()
      try {
        const valid = await verifyAdminPassword(body.password, env)
        if (!valid) {
          return jsonResponse({ error: '密码错误' }, 401)
        }
        const token = await signToken(env)
        resetRateLimit(LOGIN_RATE_LIMIT.key, context.clientIp)
        const headers = await createLoginHeaders(token, env)
        return jsonResponse({ success: true }, 200, headers)
      } finally {
        releaseWork()
      }
    }

    if (path === '/api/logout' && request.method === 'POST') {
      return jsonResponse({ success: true }, 200, createLogoutHeaders())
    }

    if (path === '/api/auth' && request.method === 'GET') {
      const authenticated = await verifyAuth(request, env)
      return jsonResponse({ authenticated }, 200)
    }

    if (path === '/api/setup-status' && request.method === 'GET') {
      const initialized = await isInitialized(env)
      return jsonResponse({ initialized }, 200)
    }

    if (path === '/api/setup' && request.method === 'POST') {
      const rateLimit = consumeRateLimit(SETUP_RATE_LIMIT, context.clientIp)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }

      const initialized = await isInitialized(env)
      if (initialized) {
        return jsonResponse({ error: '密码已初始化' }, 409)
      }
      const body = (await request.json().catch(() => ({}))) as { password?: string }
      if (!body.password) {
        return jsonResponse({ error: '请输入密码' }, 400)
      }
      const releaseWork = tryAcquireWorkSlot('password', PASSWORD_WORK_CONCURRENCY)
      if (!releaseWork) return busyResponse()
      try {
        const result = await setupPassword(body.password, env)
        if (!result.ok) {
          return jsonResponse({ error: result.error || '初始化失败' }, 400)
        }
        const token = await signToken(env)
        resetRateLimit(SETUP_RATE_LIMIT.key, context.clientIp)
        const headers = await createLoginHeaders(token, env)
        return jsonResponse({ success: true }, 200, headers)
      } finally {
        releaseWork()
      }
    }

    if (path === '/api/check-update' && request.method === 'POST') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      if (!isJsonRequest(request)) {
        return jsonResponse({ error: 'Content-Type 必须为 application/json' }, 415)
      }
      const csrfError = await csrfErrorResponse(request, env)
      if (csrfError) return csrfError
      const rateLimit = consumeRateLimit(CHECK_UPDATE_RATE_LIMIT, context.clientIp)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }
      const body = (await request.json().catch(() => ({}))) as {
        current?: string
        githubProxy?: string
        receivePrereleaseUpdates?: boolean
      }
      return checkUpdate(
        body.current || '',
        env,
        body.githubProxy || undefined,
        body.receivePrereleaseUpdates === true,
      )
    }

    if (path === '/api/update/status' && request.method === 'GET') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const rateLimit = consumeRateLimit(UPDATE_STATUS_RATE_LIMIT, context.clientIp)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }
      const response = await getUpdateStatus(
        env,
        url.searchParams.get('since'),
        url.searchParams.get('triggerId') || '',
      )
      response.headers.set('Cache-Control', 'no-store')
      return response
    }

    if (path === '/api/update' && request.method === 'POST') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      if (!isJsonRequest(request)) {
        return jsonResponse({ error: 'Content-Type 必须为 application/json' }, 415)
      }
      const csrfError = await csrfErrorResponse(request, env)
      if (csrfError) return csrfError
      const rateLimit = consumeRateLimit(UPDATE_RATE_LIMIT, context.clientIp)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }
      const body = (await request.json().catch(() => ({}))) as {
        githubProxy?: string
        targetTag?: string
        receivePrereleaseUpdates?: boolean
      }
      return triggerUpdate(
        env,
        body.githubProxy,
        body.targetTag,
        body.receivePrereleaseUpdates === true,
      )
    }

    if (path === '/api/change-password' && request.method === 'POST') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const csrfError = await csrfErrorResponse(request, env)
      if (csrfError) return csrfError
      const rateLimit = consumeRateLimit(CHANGE_PASSWORD_RATE_LIMIT, context.clientIp)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }
      const body = (await request.json().catch(() => ({}))) as {
        current?: string
        next?: string
      }
      if (!body.current || !body.next) {
        return jsonResponse({ error: '缺少当前密码或新密码' }, 400)
      }
      const releaseWork = tryAcquireWorkSlot('password', PASSWORD_WORK_CONCURRENCY)
      if (!releaseWork) return busyResponse()
      try {
        const result = await changePassword(body.current, body.next, env)
        if (!result.ok) {
          return jsonResponse({ error: result.error || '修改失败' }, 400)
        }
        return jsonResponse({ success: true }, 200)
      } finally {
        releaseWork()
      }
    }

    if (path === '/api/test-music-api' && request.method === 'POST') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const csrfError = await csrfErrorResponse(request, env)
      if (csrfError) return csrfError
      const rateLimit = consumeRateLimit(TEST_MUSIC_API_RATE_LIMIT, context.clientIp)
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.retryAfterSeconds)
      }
      const body = await request.json().catch(() => null)
      if (!body || typeof body !== 'object') {
        return jsonResponse({ error: '配置无效' }, 400)
      }
      return testMusicApi(body)
    }

    if (path === '/api/config' && request.method === 'GET') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      return getConfig(env)
    }

    if (path === '/api/config' && request.method === 'PUT') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const csrfError = await csrfErrorResponse(request, env)
      if (csrfError) return csrfError
      const body = await request.json().catch(() => null)
      return putConfig(body, env)
    }

    if (path === '/api/upload' && request.method === 'POST') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const csrfError = await csrfErrorResponse(request, env)
      if (csrfError) return csrfError
      const body = (await request.json().catch(() => null)) as {
        path?: string
        content?: string
      } | null
      if (!body || !body.path || !body.content) {
        return jsonResponse({ error: '缺少 path 或 content' }, 400)
      }
      // 限制单次上传体积,防止超大 base64 撑爆 Edge 实例内存。
      // content 为 base64 字符串,按 ceil(bytes / 3) * 4 精确匹配 25MiB 文件边界。
      if (body.content.length > UPLOAD_LIMITS.MAX_BASE64_LENGTH) {
        return jsonResponse({ error: `文件过大,最大 ${UPLOAD_LIMITS.MAX_SIZE_LABEL}` }, 413)
      }
      return uploadFile({ path: body.path, content: body.content }, env)
    }

    if (path === '/api/file' && request.method === 'DELETE') {
      if (!(await verifyAuth(request, env))) {
        return jsonResponse({ error: '未授权' }, 401)
      }
      const csrfError = await csrfErrorResponse(request, env)
      if (csrfError) return csrfError
      const body = (await request.json().catch(() => null)) as { paths?: string[] } | null
      if (!body || !Array.isArray(body.paths)) {
        return jsonResponse({ error: '缺少 paths' }, 400)
      }
      // 限制单次删除数量,避免并发发起大量 GitHub API 请求触发速率限制或超时。
      if (body.paths.length > 50) {
        return jsonResponse({ error: '单次最多删除 50 个文件' }, 400)
      }
      return deleteTrackFiles(body.paths, env)
    }

    return jsonResponse({ error: '未找到' }, 404)
  } catch (error) {
    // 使用统一的错误处理，避免敏感信息泄露
    logSanitizedError('handleRequest', error)
    const errorResponse = createErrorResponse(error, 500)
    return jsonResponse({ error: errorResponse.error }, 500)
  }
}
